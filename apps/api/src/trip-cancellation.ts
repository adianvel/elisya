import { persistWhatsAppNotification, pool } from '@repo/db'
import { ulid } from 'ulid'
import { writeAuditEvent } from './audit'
import type { Refund } from './cancellations'
import type { PendingPaymentDecision, Trip } from './trips'
import { syncVehicleAssignmentStatus } from './vehicles'

type Queryable = { query<T>(text: string, values?: unknown[]): Promise<{ rows: T[] }> }
type Hold = { id: string; customerRef: string; status: string }
type PendingPayment = {
  id: string
  holdId: string
  customerRef: string
  holdStatus: string
  seatCount: number
  price: number
  currency: string
}
type ConfirmedBooking = {
  id: string
  holdId: string
  customerRef: string
  amount: number
  currency: string
}

async function recordCancellationCase(
  client: Queryable,
  organizationId: string,
  actorId: string,
  tripId: string,
  target: { bookingId?: string; paymentId?: string },
  customerRef: string,
  now: Date,
): Promise<void> {
  const bookingId = target.bookingId ?? null
  const paymentId = target.paymentId ?? null
  if (Boolean(bookingId) === Boolean(paymentId)) throw new Error('exactly one cancellation target is required')
  const column = bookingId ? '"bookingId"' : '"paymentId"'
  const targetId = bookingId ?? paymentId!
  const pending = await client.query<{ id: string }>(
    `SELECT id FROM "cancellationRequest" WHERE "organizationId" = $1 AND ${column} = $2 AND status = 'PENDING' FOR UPDATE`,
    [organizationId, targetId],
  )
  let id: string
  if (pending.rows[0]) {
    id = pending.rows[0].id
    await client.query(
      `UPDATE "cancellationRequest" SET status = 'APPROVED', reason = 'Trip cancelled by Owner', "reviewedBy" = $3, "reviewedAt" = $4, "updatedAt" = $4
       WHERE id = $1 AND "organizationId" = $2`,
      [id, organizationId, actorId, now],
    )
  } else {
    id = ulid()
    await client.query(
      `INSERT INTO "cancellationRequest" (id, "organizationId", "bookingId", "paymentId", "customerRef", "idempotencyKey", source, status, reason, "requestedAt", "reviewedBy", "reviewedAt", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6, 'TRIP', 'APPROVED', 'Trip cancelled by Owner', $7, $8, $7, $7, $7)`,
      [id, organizationId, bookingId, paymentId, customerRef, `trip:${tripId}:${bookingId ? 'booking' : 'payment'}:${targetId}`, now, actorId],
    )
  }
  await writeAuditEvent(client, organizationId, actorId, pending.rows[0] ? 'cancellation.approved' : 'cancellation.trip_created', 'CancellationRequest', id, {
    tripId,
    bookingId,
    paymentId,
    source: pending.rows[0] ? 'CUSTOMER' : 'TRIP',
  }, now)
}

async function createRefund(
  client: Queryable,
  input: { organizationId: string; bookingId?: string; paymentId?: string; customerRef: string; amount: number; currency: string; now: Date },
): Promise<Refund> {
  const bookingId = input.bookingId ?? null
  const paymentId = input.paymentId ?? null
  if (Boolean(bookingId) === Boolean(paymentId)) throw new Error('exactly one Refund target is required')
  const column = bookingId ? '"bookingId"' : '"paymentId"'
  const targetId = bookingId ?? paymentId!
  const created = await client.query<Refund>(
    `INSERT INTO "refund" (id, "organizationId", ${column}, "customerRef", amount, currency, status, "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, $6, 'PENDING', $7, $7)
     ON CONFLICT (${column}) DO NOTHING
     RETURNING id, "organizationId", "bookingId", "paymentId", "customerRef", amount, currency, status, "transferredAt", "transferReference", "recordedBy", "createdAt", "updatedAt"`,
    [ulid(), input.organizationId, targetId, input.customerRef, input.amount, input.currency, input.now],
  )
  if (created.rows[0]) return created.rows[0]
  const existing = await client.query<Refund>(
    `SELECT id, "organizationId", "bookingId", "paymentId", "customerRef", amount, currency, status, "transferredAt", "transferReference", "recordedBy", "createdAt", "updatedAt"
     FROM "refund" WHERE "organizationId" = $1 AND ${column} = $2`,
    [input.organizationId, targetId],
  )
  if (!existing.rows[0]) throw new Error('Refund could not be created')
  return existing.rows[0]
}

export async function cancelTrip(
  organizationId: string,
  id: string,
  actorId: string,
  decisions: PendingPaymentDecision[],
  now: Date,
): Promise<Trip | null> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const current = await client.query<Trip>(
      `SELECT id, "organizationId", origin, destination, "departureAt", price, currency, "seatQuota", status, "vehicleId"
       FROM "trip" WHERE id = $1 AND "organizationId" = $2 FOR UPDATE`,
      [id, organizationId],
    )
    if (!current.rows[0]) {
      await client.query('ROLLBACK')
      return null
    }
    if (current.rows[0].status === 'CANCELLED') {
      await client.query('COMMIT')
      return current.rows[0]
    }
    if (current.rows[0].status !== 'PUBLISHED') throw new Error('Only a published Trip can be cancelled')
    const trip = current.rows[0]

    // Lock Holds after the Trip so payment submission and cancellation share a consistent order.
    await client.query<Hold>(
      `SELECT id, "customerRef", status FROM "hold"
       WHERE "organizationId" = $1 AND "tripId" = $2 ORDER BY id FOR UPDATE`,
      [organizationId, id],
    )
    const pendingPayments = await client.query<PendingPayment>(
      `SELECT p.id, p."holdId", p."customerRef", h.status AS "holdStatus", h."seatCount",
              COALESCE(h."priceAtHold", t.price) AS price, COALESCE(h."currencyAtHold", t.currency) AS currency
       FROM "payment" p
       JOIN "hold" h ON h.id = p."holdId" AND h."organizationId" = p."organizationId"
       JOIN "trip" t ON t.id = h."tripId" AND t."organizationId" = h."organizationId"
       WHERE p."organizationId" = $1 AND h."tripId" = $2 AND p.status = 'PENDING'
       ORDER BY p.id FOR UPDATE OF p`,
      [organizationId, id],
    )
    const decisionByPayment = new Map<string, boolean>()
    for (const decision of decisions) {
      if (!decision.paymentId || typeof decision.fundsReceived !== 'boolean' || decisionByPayment.has(decision.paymentId)) {
        throw new Error('Each pending Payment requires one fundsReceived decision')
      }
      decisionByPayment.set(decision.paymentId, decision.fundsReceived)
    }
    if (decisionByPayment.size !== pendingPayments.rows.length || pendingPayments.rows.some((payment) => !decisionByPayment.has(payment.id))) {
      throw new Error('Trip cancellation requires a fundsReceived decision for every pending Payment')
    }

    const bookings = await client.query<ConfirmedBooking>(
      `SELECT b.id, b."holdId", b."customerRef",
              COALESCE(i.amount, COALESCE(h."priceAtHold", t.price) * b."seatCount")::int AS amount,
              COALESCE(i.currency, COALESCE(h."currencyAtHold", t.currency)) AS currency
       FROM "booking" b
       JOIN "hold" h ON h.id = b."holdId" AND h."organizationId" = b."organizationId"
       JOIN "trip" t ON t.id = b."tripId" AND t."organizationId" = b."organizationId"
       LEFT JOIN "invoice" i ON i."bookingId" = b.id AND i."organizationId" = b."organizationId"
       WHERE b."organizationId" = $1 AND b."tripId" = $2 AND b.status = 'CONFIRMED'
       ORDER BY b.id FOR UPDATE OF b`,
      [organizationId, id],
    )

    for (const payment of pendingPayments.rows) {
      if (payment.holdStatus !== 'ACTIVE') throw new Error(`Pending Payment ${payment.id} has no active Hold`)
      const fundsReceived = decisionByPayment.get(payment.id)!
      await client.query(
        `UPDATE "hold" SET status = 'CANCELLED', "updatedAt" = $3 WHERE id = $1 AND "organizationId" = $2`,
        [payment.holdId, organizationId, now],
      )
      if (fundsReceived) {
        await client.query(
          `UPDATE "payment" SET status = 'REFUND_PENDING', "rejectionReason" = NULL, "reviewedBy" = $3, "reviewedAt" = $4, "updatedAt" = $4
           WHERE id = $1 AND "organizationId" = $2`,
          [payment.id, organizationId, actorId, now],
        )
        const refund = await createRefund(client, {
          organizationId,
          paymentId: payment.id,
          customerRef: payment.customerRef,
          amount: payment.price * payment.seatCount,
          currency: payment.currency,
          now,
        })
        await writeAuditEvent(client, organizationId, actorId, 'payment.refund_pending', 'Payment', payment.id, { refundId: refund.id }, now)
        await writeAuditEvent(client, organizationId, actorId, 'refund.created', 'Refund', refund.id, { paymentId: payment.id, amount: refund.amount, currency: refund.currency }, now)
        await persistWhatsAppNotification(client, {
          organizationId,
          eventKey: `trip:${id}:payment:${payment.id}:cancelled`,
          customerRef: payment.customerRef,
          text: `Trip ${trip.origin} to ${trip.destination} was cancelled. The Owner confirmed the transfer; a full Refund of ${refund.amount} ${refund.currency} is pending manual transfer.`,
        }, now)
      } else {
        const reason = 'Trip cancelled; Owner confirmed no transfer was received.'
        await client.query(
          `UPDATE "payment" SET status = 'REJECTED', "rejectionReason" = $3, "reviewedBy" = $4, "reviewedAt" = $5, "updatedAt" = $5
           WHERE id = $1 AND "organizationId" = $2`,
          [payment.id, organizationId, reason, actorId, now],
        )
        await writeAuditEvent(client, organizationId, actorId, 'payment.rejected', 'Payment', payment.id, { reason }, now)
        await persistWhatsAppNotification(client, {
          organizationId,
          eventKey: `trip:${id}:payment:${payment.id}:cancelled`,
          customerRef: payment.customerRef,
          text: `Trip ${trip.origin} to ${trip.destination} was cancelled. The Owner confirmed no transfer was received; Payment ${payment.id} was rejected and the Hold seats were released.`,
        }, now)
      }
      await writeAuditEvent(client, organizationId, actorId, 'hold.cancelled', 'Hold', payment.holdId, { customerRef: payment.customerRef, tripId: id }, now)
      await recordCancellationCase(client, organizationId, actorId, id, { paymentId: payment.id }, payment.customerRef, now)
    }

    for (const booking of bookings.rows) {
      await client.query(
        `UPDATE "booking" SET status = 'CANCELLED', "updatedAt" = $3 WHERE id = $1 AND "organizationId" = $2`,
        [booking.id, organizationId, now],
      )
      await client.query(
        `UPDATE "hold" SET status = 'CANCELLED', "updatedAt" = $3 WHERE id = $1 AND "organizationId" = $2`,
        [booking.holdId, organizationId, now],
      )
      const refund = await createRefund(client, {
        organizationId,
        bookingId: booking.id,
        customerRef: booking.customerRef,
        amount: booking.amount,
        currency: booking.currency,
        now,
      })
      await writeAuditEvent(client, organizationId, actorId, 'booking.cancelled', 'Booking', booking.id, { refundId: refund.id, tripId: id }, now)
      await writeAuditEvent(client, organizationId, actorId, 'refund.created', 'Refund', refund.id, { bookingId: booking.id, amount: refund.amount, currency: refund.currency }, now)
      await writeAuditEvent(client, organizationId, actorId, 'hold.cancelled', 'Hold', booking.holdId, { customerRef: booking.customerRef, tripId: id }, now)
      await recordCancellationCase(client, organizationId, actorId, id, { bookingId: booking.id }, booking.customerRef, now)
      await persistWhatsAppNotification(client, {
        organizationId,
        eventKey: `trip:${id}:booking:${booking.id}:cancelled`,
        customerRef: booking.customerRef,
        text: `Trip ${trip.origin} to ${trip.destination} was cancelled. Booking ${booking.id} is cancelled and a full Refund of ${refund.amount} ${refund.currency} is pending manual transfer.`,
      }, now)
    }

    const unpaidHolds = await client.query<Hold>(
      `UPDATE "hold" SET status = 'CANCELLED', "updatedAt" = $3
       WHERE "organizationId" = $1 AND "tripId" = $2 AND status = 'ACTIVE'
       RETURNING id, "customerRef", status`,
      [organizationId, id, now],
    )
    for (const hold of unpaidHolds.rows) {
      await writeAuditEvent(client, organizationId, actorId, 'hold.cancelled', 'Hold', hold.id, { customerRef: hold.customerRef, tripId: id }, now)
      await persistWhatsAppNotification(client, {
        organizationId,
        eventKey: `trip:${id}:hold:${hold.id}:cancelled`,
        customerRef: hold.customerRef,
        text: `Trip ${trip.origin} to ${trip.destination} was cancelled. Hold ${hold.id} is closed and its seats are available again.`,
      }, now)
    }

    const updated = await client.query<Trip>(
      `UPDATE "trip" SET status = 'CANCELLED', "updatedAt" = $3
       WHERE id = $1 AND "organizationId" = $2
       RETURNING id, "organizationId", origin, destination, "departureAt", price, currency, "seatQuota", status`,
      [id, organizationId, now],
    )
    const cancelled = updated.rows[0]
    if (!cancelled) throw new Error('Trip cancellation failed')
    if (trip.vehicleId) await syncVehicleAssignmentStatus(client, organizationId, trip.vehicleId, actorId, now)
    await writeAuditEvent(client, organizationId, actorId, 'trip.cancelled', 'Trip', id, {
      closedHolds: unpaidHolds.rows.length + pendingPayments.rows.length + bookings.rows.length,
      refundedPayments: pendingPayments.rows.filter((payment) => decisionByPayment.get(payment.id)).length,
      cancelledBookings: bookings.rows.length,
    }, now)
    await client.query('COMMIT')
    return cancelled
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}
