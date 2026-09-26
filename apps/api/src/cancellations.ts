import { persistWhatsAppNotification, pool, zenstack } from '@repo/db'
import { ulid } from 'ulid'
import { notifyWhatsApp } from './notifications'
import type { NotificationSink } from './holds'

export type CancellationRequestStatus = 'PENDING' | 'APPROVED' | 'REJECTED'
export type CancellationSource = 'CUSTOMER' | 'TRIP'
export type CancellationRequest = {
  id: string
  organizationId: string
  bookingId: string | null
  paymentId: string | null
  customerRef: string
  source: CancellationSource
  status: CancellationRequestStatus
  reason: string | null
  requestedAt: Date
  reviewedAt: Date | null
}

export type RequestCancellationInput = {
  organizationId: string
  customerRef: string
  bookingId?: string
  paymentId?: string
  idempotencyKey: string
  now?: Date
}

export type CancellationActor = { userId: string; organizationId: string }
export type CancellationReview =
  | { decision: 'APPROVE'; fundsReceived?: boolean }
  | { decision: 'REJECT'; reason: string }
export type Refund = {
  id: string
  organizationId: string
  bookingId: string | null
  paymentId: string | null
  customerRef: string
  amount: number
  currency: string
  status: 'PENDING' | 'COMPLETED'
  transferredAt: Date | null
  transferReference: string | null
  recordedBy: string | null
  createdAt: Date
  updatedAt: Date
}
export type CancellationReviewResult = { cancellation: CancellationRequest; refund: Refund | null }
export type RefundCompletionInput = { transferDate: Date; transferReference: string }

const SELECT_CANCELLATION = `SELECT id, "organizationId", "bookingId", "paymentId", "customerRef", source, status, reason, "requestedAt", "reviewedAt"
  FROM "cancellationRequest"`
const SELECT_REFUND = `SELECT id, "organizationId", "bookingId", "paymentId", "customerRef", amount, currency, status, "transferredAt", "transferReference", "recordedBy", "createdAt", "updatedAt"
  FROM "refund"`

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === '23505')
}

async function requireOwner(actor: CancellationActor): Promise<void> {
  if (!await zenstack.member.findFirst({ where: { userId: actor.userId, organizationId: actor.organizationId, role: 'owner' }, select: { id: true } })) {
    throw new Error('Owner access required')
  }
}

async function writeAuditEvent(
  client: { query(text: string, values?: unknown[]): Promise<unknown> },
  organizationId: string,
  actorId: string | null,
  action: string,
  entityType: string,
  entityId: string,
  metadata: Record<string, unknown>,
  createdAt: Date,
): Promise<void> {
  await client.query(
    `INSERT INTO "auditEvent" (id, "organizationId", "actorId", action, "entityType", "entityId", metadata, "createdAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [ulid(), organizationId, actorId, action, entityType, entityId, JSON.stringify(metadata), createdAt],
  )
}

async function findRefundForCancellation(client: { query<T>(text: string, values?: unknown[]): Promise<{ rows: T[] }> }, cancellation: CancellationRequest): Promise<Refund | null> {
  const bookingId = cancellation.bookingId
  const paymentId = cancellation.paymentId
  if (!bookingId && !paymentId) return null
  const result = await client.query<Refund>(
    `${SELECT_REFUND} WHERE "organizationId" = $1 AND ${bookingId ? '"bookingId" = $2' : '"paymentId" = $2'}`,
    [cancellation.organizationId, bookingId ?? paymentId],
  )
  return result.rows[0] ?? null
}

export function createCancellationService(notify: NotificationSink = notifyWhatsApp) {
  return {
    async request(input: RequestCancellationInput): Promise<CancellationRequest | null> {
      const bookingId = input.bookingId || null
      const paymentId = input.paymentId || null
      if (!input.organizationId || !/^\+[1-9]\d{7,14}$/.test(input.customerRef) || !input.idempotencyKey || input.idempotencyKey.length > 512) {
        throw new Error('organizationId, a valid Customer number, and idempotencyKey are required')
      }
      if (Boolean(bookingId) === Boolean(paymentId)) throw new Error('exactly one of bookingId or paymentId is required')

      const now = input.now ?? new Date()
      const client = await pool.connect()
      let created: CancellationRequest | null = null
      let notificationText = ''
      try {
        await client.query('BEGIN')
        const replay = await client.query<CancellationRequest>(
          `${SELECT_CANCELLATION} WHERE "organizationId" = $1 AND "customerRef" = $2 AND "idempotencyKey" = $3`,
          [input.organizationId, input.customerRef, input.idempotencyKey],
        )
        if (replay.rows[0]) {
          await client.query('COMMIT')
          return replay.rows[0]
        }

        if (bookingId) {
          const target = await client.query<{ tripId: string }>(
            `SELECT "tripId" FROM "booking" WHERE id = $1 AND "organizationId" = $2 AND "customerRef" = $3`,
            [bookingId, input.organizationId, input.customerRef],
          )
          if (!target.rows[0]) {
            await client.query('ROLLBACK')
            return null
          }
          const trip = await client.query<{ id: string }>(
            `SELECT id FROM "trip" WHERE id = $1 AND "organizationId" = $2 FOR UPDATE`,
            [target.rows[0].tripId, input.organizationId],
          )
          if (!trip.rows[0]) {
            await client.query('ROLLBACK')
            return null
          }
          const booking = await client.query<{ status: string; departureAt: Date }>(
            `SELECT b.status, t."departureAt"
             FROM "booking" b JOIN "trip" t ON t.id = b."tripId" AND t."organizationId" = b."organizationId"
             WHERE b.id = $1 AND b."organizationId" = $2 AND b."customerRef" = $3
             FOR UPDATE OF b`,
            [bookingId, input.organizationId, input.customerRef],
          )
          if (!booking.rows[0]) {
            await client.query('ROLLBACK')
            return null
          }
          if (booking.rows[0].status !== 'CONFIRMED' || booking.rows[0].departureAt <= now) {
            throw new Error('Booking cancellation can only be requested before departure')
          }
        } else {
          const target = await client.query<{ tripId: string }>(
            `SELECT h."tripId" FROM "payment" p
             JOIN "hold" h ON h.id = p."holdId" AND h."organizationId" = p."organizationId"
             WHERE p.id = $1 AND p."organizationId" = $2 AND p."customerRef" = $3`,
            [paymentId, input.organizationId, input.customerRef],
          )
          if (!target.rows[0]) {
            await client.query('ROLLBACK')
            return null
          }
          const trip = await client.query<{ id: string }>(
            `SELECT id FROM "trip" WHERE id = $1 AND "organizationId" = $2 FOR UPDATE`,
            [target.rows[0].tripId, input.organizationId],
          )
          if (!trip.rows[0]) {
            await client.query('ROLLBACK')
            return null
          }
          const payment = await client.query<{ status: string; departureAt: Date }>(
            `SELECT p.status, t."departureAt"
             FROM "payment" p
             JOIN "hold" h ON h.id = p."holdId" AND h."organizationId" = p."organizationId"
             JOIN "trip" t ON t.id = h."tripId" AND t."organizationId" = h."organizationId"
             WHERE p.id = $1 AND p."organizationId" = $2 AND p."customerRef" = $3
             FOR UPDATE OF p, h`,
            [paymentId, input.organizationId, input.customerRef],
          )
          if (!payment.rows[0] || payment.rows[0].status !== 'PENDING') {
            await client.query('ROLLBACK')
            return null
          }
          if (payment.rows[0].departureAt <= now) throw new Error('Payment cancellation can only be requested before departure')
        }

        // The Booking/Payment row is already locked, so this read is serialized without locking the case row.
        const pending = await client.query<CancellationRequest>(
          `${SELECT_CANCELLATION} WHERE "organizationId" = $1 AND status = 'PENDING'
           AND ${bookingId ? '"bookingId" = $2' : '"paymentId" = $2'}`,
          [input.organizationId, bookingId ?? paymentId],
        )
        if (pending.rows[0]) {
          await client.query('COMMIT')
          return pending.rows[0]
        }

        const result = await client.query<CancellationRequest>(
          `INSERT INTO "cancellationRequest" (id, "organizationId", "bookingId", "paymentId", "customerRef", "idempotencyKey", status, "requestedAt", "createdAt", "updatedAt")
           VALUES ($1, $2, $3, $4, $5, $6, 'PENDING', $7, $7, $7)
           RETURNING id, "organizationId", "bookingId", "paymentId", "customerRef", source, status, reason, "requestedAt", "reviewedAt"`,
          [ulid(), input.organizationId, bookingId, paymentId, input.customerRef, input.idempotencyKey, now],
        )
        created = result.rows[0]
        await writeAuditEvent(
          client,
          input.organizationId,
          null,
          'cancellation.requested',
          'CancellationRequest',
          created.id,
          { customerRef: input.customerRef, bookingId, paymentId },
          now,
        )
        notificationText = bookingId
          ? `Cancellation request for Booking ${bookingId} received. It remains confirmed until the Owner reviews it.`
          : `Cancellation request for Payment ${paymentId} received. The Owner will check whether the transfer arrived.`
        await persistWhatsAppNotification(client, {
          organizationId: input.organizationId,
          eventKey: `cancellation:${created.id}:requested`,
          customerRef: input.customerRef,
          text: notificationText,
        }, now)
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK')
        if (isUniqueViolation(error)) {
          const replay = await pool.query<CancellationRequest>(
            `${SELECT_CANCELLATION} WHERE "organizationId" = $1 AND "customerRef" = $2 AND "idempotencyKey" = $3`,
            [input.organizationId, input.customerRef, input.idempotencyKey],
          )
          if (replay.rows[0]) return replay.rows[0]
        }
        throw error
      } finally {
        client.release()
      }
      if (created) notify({
        organizationId: created.organizationId,
        eventKey: `cancellation:${created.id}:requested`,
        customerRef: created.customerRef,
        text: notificationText,
      })
      return created
    },

    async listPending(actor: CancellationActor): Promise<CancellationRequest[]> {
      await requireOwner(actor)
      const result = await pool.query<CancellationRequest>(
        `${SELECT_CANCELLATION} WHERE "organizationId" = $1 AND status = 'PENDING' ORDER BY "requestedAt" ASC`,
        [actor.organizationId],
      )
      return result.rows
    },

    async review(
      actor: CancellationActor,
      id: string,
      review: CancellationReview,
      now = new Date(),
    ): Promise<CancellationReviewResult> {
      await requireOwner(actor)
      const client = await pool.connect()
      let notification: { eventKey: string; customerRef: string; text: string } | null = null
      let result: CancellationReviewResult
      try {
        await client.query('BEGIN')
        const initial = await client.query<CancellationRequest>(
          `${SELECT_CANCELLATION} WHERE id = $1 AND "organizationId" = $2`,
          [id, actor.organizationId],
        )
        if (!initial.rows[0]) throw new Error('Cancellation request not found')
        let cancellation = initial.rows[0]
        if (cancellation.status !== 'PENDING') {
          const refund = await findRefundForCancellation(client, cancellation)
          await client.query('COMMIT')
          return { cancellation, refund }
        }

        const targetTrip = cancellation.bookingId
          ? await client.query<{ tripId: string }>(`SELECT "tripId" FROM "booking" WHERE id = $1 AND "organizationId" = $2`, [cancellation.bookingId, actor.organizationId])
          : await client.query<{ tripId: string }>(
            `SELECT h."tripId" FROM "payment" p JOIN "hold" h ON h.id = p."holdId" AND h."organizationId" = p."organizationId"
             WHERE p.id = $1 AND p."organizationId" = $2`,
            [cancellation.paymentId, actor.organizationId],
          )
        if (!targetTrip.rows[0]) throw new Error('Cancellation request target not found')
        const trip = await client.query<{ id: string }>(
          `SELECT id FROM "trip" WHERE id = $1 AND "organizationId" = $2 FOR UPDATE`,
          [targetTrip.rows[0].tripId, actor.organizationId],
        )
        if (!trip.rows[0]) throw new Error('Cancellation request target not found')

        const booking = cancellation.bookingId
          ? await client.query<{ holdId: string; customerRef: string; status: string; amount: number; currency: string }>(
            `SELECT b."holdId", b."customerRef", b.status, i.amount, i.currency
             FROM "booking" b
             JOIN "hold" h ON h.id = b."holdId" AND h."organizationId" = b."organizationId"
             JOIN "invoice" i ON i."bookingId" = b.id AND i."organizationId" = b."organizationId"
             WHERE b.id = $1 AND b."organizationId" = $2 FOR UPDATE OF b, h`,
            [cancellation.bookingId, actor.organizationId],
          )
          : null
        const payment = cancellation.paymentId
          ? await client.query<{
            status: string
            holdId: string
            customerRef: string
            holdStatus: string
            seatCount: number
            price: number
            currency: string
          }>(
            `SELECT p.status, p."holdId", p."customerRef", h.status AS "holdStatus", h."seatCount",
                    COALESCE(h."priceAtHold", t.price) AS price, COALESCE(h."currencyAtHold", t.currency) AS currency
             FROM "payment" p
             JOIN "hold" h ON h.id = p."holdId" AND h."organizationId" = p."organizationId"
             JOIN "trip" t ON t.id = h."tripId" AND t."organizationId" = h."organizationId"
             WHERE p.id = $1 AND p."organizationId" = $2 FOR UPDATE OF p, h`,
            [cancellation.paymentId, actor.organizationId],
          )
          : null

        const locked = await client.query<CancellationRequest>(
          `${SELECT_CANCELLATION} WHERE id = $1 AND "organizationId" = $2 FOR UPDATE`,
          [id, actor.organizationId],
        )
        if (!locked.rows[0]) throw new Error('Cancellation request not found')
        cancellation = locked.rows[0]
        if (cancellation.status !== 'PENDING') {
          const refund = await findRefundForCancellation(client, cancellation)
          await client.query('COMMIT')
          return { cancellation, refund }
        }
        let refund: Refund | null = null
        if (cancellation.bookingId && review.decision === 'REJECT') {
          const reason = review.reason.trim()
          if (!reason) throw new Error('Rejection reason is required')
          const updated = await client.query<CancellationRequest>(
            `UPDATE "cancellationRequest" SET status = 'REJECTED', reason = $3, "reviewedBy" = $4, "reviewedAt" = $5, "updatedAt" = $5
             WHERE id = $1 AND "organizationId" = $2
             RETURNING id, "organizationId", "bookingId", "paymentId", "customerRef", source, status, reason, "requestedAt", "reviewedAt"`,
            [id, actor.organizationId, reason, actor.userId, now],
          )
          await writeAuditEvent(client, actor.organizationId, actor.userId, 'cancellation.rejected', 'CancellationRequest', id, { reason }, now)
          notification = {
            eventKey: `cancellation:${id}:rejected`,
            customerRef: cancellation.customerRef,
            text: `Your cancellation request for Booking ${cancellation.bookingId} was rejected: ${reason}. Your Booking remains confirmed.`,
          }
          result = { cancellation: updated.rows[0]!, refund: null }
        } else if (cancellation.bookingId && review.decision === 'APPROVE') {
          if (review.fundsReceived !== undefined) throw new Error('fundsReceived is only used for pending Payments')
          if (!booking?.rows[0] || booking.rows[0].status !== 'CONFIRMED') throw new Error('Booking is no longer cancellable')
          await client.query(
            `UPDATE "booking" SET status = 'CANCELLED', "updatedAt" = $3 WHERE id = $1 AND "organizationId" = $2`,
            [cancellation.bookingId, actor.organizationId, now],
          )
          await client.query(
            `UPDATE "hold" SET status = 'CANCELLED', "updatedAt" = $3 WHERE id = $1 AND "organizationId" = $2`,
            [booking.rows[0].holdId, actor.organizationId, now],
          )
          const refundResult = await client.query<Refund>(
            `INSERT INTO "refund" (id, "organizationId", "bookingId", "customerRef", amount, currency, status, "createdAt", "updatedAt")
             VALUES ($1, $2, $3, $4, $5, $6, 'PENDING', $7, $7)
             ON CONFLICT ("bookingId") DO NOTHING
             RETURNING id, "organizationId", "bookingId", "paymentId", "customerRef", amount, currency, status, "transferredAt", "transferReference", "recordedBy", "createdAt", "updatedAt"`,
            [ulid(), actor.organizationId, cancellation.bookingId, booking.rows[0].customerRef, booking.rows[0].amount, booking.rows[0].currency, now],
          )
          refund = refundResult.rows[0] ?? await findRefundForCancellation(client, cancellation)
          if (!refund) throw new Error('Refund could not be created')
          const updated = await client.query<CancellationRequest>(
            `UPDATE "cancellationRequest" SET status = 'APPROVED', "reviewedBy" = $3, "reviewedAt" = $4, "updatedAt" = $4
             WHERE id = $1 AND "organizationId" = $2
             RETURNING id, "organizationId", "bookingId", "paymentId", "customerRef", source, status, reason, "requestedAt", "reviewedAt"`,
            [id, actor.organizationId, actor.userId, now],
          )
          for (const [action, entityType, entityId, metadata] of [
            ['cancellation.approved', 'CancellationRequest', id, { bookingId: cancellation.bookingId }],
            ['booking.cancelled', 'Booking', cancellation.bookingId, { refundId: refund.id }],
            ['refund.created', 'Refund', refund.id, { bookingId: cancellation.bookingId, amount: refund.amount, currency: refund.currency }],
          ] as const) {
            await writeAuditEvent(client, actor.organizationId, actor.userId, action, entityType, entityId, metadata, now)
          }
          notification = {
            eventKey: `cancellation:${id}:approved`,
            customerRef: cancellation.customerRef,
            text: `Your cancellation for Booking ${cancellation.bookingId} was approved. A full Refund of ${refund.amount} ${refund.currency} is pending manual transfer.`,
          }
          result = { cancellation: updated.rows[0]!, refund }
        } else {
          if (review.decision !== 'APPROVE') throw new Error('Pending Payment cancellation must be approved')
          if (typeof review.fundsReceived !== 'boolean') {
            throw new Error('Pending Payment cancellation review requires a fundsReceived decision')
          }
          if (!payment?.rows[0] || payment.rows[0].status !== 'PENDING' || payment.rows[0].holdStatus !== 'ACTIVE') {
            throw new Error('Payment is no longer awaiting cancellation review')
          }
          const row = payment.rows[0]
          const rejectionReason = 'No transfer was received; the Customer requested cancellation.'
          if (review.fundsReceived) {
            await client.query(
              `UPDATE "payment" SET status = 'REFUND_PENDING', "rejectionReason" = NULL, "reviewedBy" = $3, "reviewedAt" = $4, "updatedAt" = $4
               WHERE id = $1 AND "organizationId" = $2`,
              [cancellation.paymentId, actor.organizationId, actor.userId, now],
            )
            const createdRefund = await client.query<Refund>(
              `INSERT INTO "refund" (id, "organizationId", "paymentId", "customerRef", amount, currency, status, "createdAt", "updatedAt")
               VALUES ($1, $2, $3, $4, $5, $6, 'PENDING', $7, $7)
               ON CONFLICT ("paymentId") DO NOTHING
               RETURNING id, "organizationId", "bookingId", "paymentId", "customerRef", amount, currency, status, "transferredAt", "transferReference", "recordedBy", "createdAt", "updatedAt"`,
              [ulid(), actor.organizationId, cancellation.paymentId, row.customerRef, row.price * row.seatCount, row.currency, now],
            )
            refund = createdRefund.rows[0] ?? await findRefundForCancellation(client, cancellation)
            if (!refund) throw new Error('Refund could not be created')
            notification = {
              eventKey: `cancellation:${id}:approved`,
              customerRef: cancellation.customerRef,
              text: `The Owner confirmed your transfer and approved cancellation of Payment ${cancellation.paymentId}. A full Refund of ${refund.amount} ${refund.currency} is pending manual transfer.`,
            }
          } else {
            await client.query(
              `UPDATE "payment" SET status = 'REJECTED', "rejectionReason" = $3, "reviewedBy" = $4, "reviewedAt" = $5, "updatedAt" = $5
               WHERE id = $1 AND "organizationId" = $2`,
              [cancellation.paymentId, actor.organizationId, rejectionReason, actor.userId, now],
            )
            notification = {
              eventKey: `cancellation:${id}:approved`,
              customerRef: cancellation.customerRef,
              text: `The Owner confirmed no transfer was received. Payment ${cancellation.paymentId} was rejected, and its Hold seats are available again.`,
            }
          }
          await client.query(
            `UPDATE "hold" SET status = 'CANCELLED', "updatedAt" = $3 WHERE id = $1 AND "organizationId" = $2`,
            [row.holdId, actor.organizationId, now],
          )
          const updated = await client.query<CancellationRequest>(
            `UPDATE "cancellationRequest" SET status = 'APPROVED', "reviewedBy" = $3, "reviewedAt" = $4, "updatedAt" = $4
             WHERE id = $1 AND "organizationId" = $2
             RETURNING id, "organizationId", "bookingId", "paymentId", "customerRef", source, status, reason, "requestedAt", "reviewedAt"`,
            [id, actor.organizationId, actor.userId, now],
          )
          const actions: Array<[string, string, string, Record<string, unknown>]> = [
            ['cancellation.approved', 'CancellationRequest', id, { paymentId: cancellation.paymentId }],
            [review.fundsReceived ? 'payment.refund_pending' : 'payment.rejected', 'Payment', cancellation.paymentId!, review.fundsReceived ? { refundId: refund!.id } : { reason: rejectionReason }],
            ['hold.cancelled', 'Hold', row.holdId, { customerRef: row.customerRef }],
          ]
          if (refund) actions.push(['refund.created', 'Refund', refund.id, { paymentId: cancellation.paymentId, amount: refund.amount, currency: refund.currency }])
          for (const [action, entityType, entityId, metadata] of actions) {
            await writeAuditEvent(client, actor.organizationId, actor.userId, action, entityType, entityId, metadata, now)
          }
          result = { cancellation: updated.rows[0]!, refund }
        }
        await persistWhatsAppNotification(client, { organizationId: actor.organizationId, ...notification }, now)
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
      if (notification) notify({ organizationId: actor.organizationId, ...notification })
      return result!
    },
  }
}

export const cancellations = createCancellationService()

export function createRefundService(notify: NotificationSink = notifyWhatsApp) {
  return {
    async listOwner(actor: CancellationActor): Promise<Refund[]> {
      await requireOwner(actor)
      const result = await pool.query<Refund>(
        `${SELECT_REFUND} WHERE "organizationId" = $1 ORDER BY "createdAt" DESC`,
        [actor.organizationId],
      )
      return result.rows
    },

    async complete(actor: CancellationActor, id: string, input: RefundCompletionInput, now = new Date()): Promise<Refund> {
      await requireOwner(actor)
      if (!(input.transferDate instanceof Date) || Number.isNaN(input.transferDate.getTime()) || input.transferDate > now) {
        throw new Error('Refund transferDate must be a valid date no later than today')
      }
      const transferReference = input.transferReference.trim()
      if (!transferReference || transferReference.length > 255) throw new Error('Refund transfer reference is required')

      const client = await pool.connect()
      let completed: Refund
      let notification: { eventKey: string; customerRef: string; text: string } | null = null
      try {
        await client.query('BEGIN')
        const current = await client.query<Refund>(
          `${SELECT_REFUND} WHERE id = $1 AND "organizationId" = $2 FOR UPDATE`,
          [id, actor.organizationId],
        )
        if (!current.rows[0]) throw new Error('Refund not found')
        if (current.rows[0].status === 'COMPLETED') {
          await client.query('COMMIT')
          return current.rows[0]
        }
        if (current.rows[0].paymentId) {
          const payment = await client.query(
            `UPDATE "payment" SET status = 'REFUNDED', "updatedAt" = $3
             WHERE id = $1 AND "organizationId" = $2 AND status = 'REFUND_PENDING'`,
            [current.rows[0].paymentId, actor.organizationId, now],
          )
          if (!payment.rowCount) throw new Error('Payment is not awaiting Refund completion')
        }
        const updated = await client.query<Refund>(
          `UPDATE "refund" SET status = 'COMPLETED', "transferredAt" = $3, "transferReference" = $4, "recordedBy" = $5, "updatedAt" = $6
           WHERE id = $1 AND "organizationId" = $2
           RETURNING id, "organizationId", "bookingId", "paymentId", "customerRef", amount, currency, status, "transferredAt", "transferReference", "recordedBy", "createdAt", "updatedAt"`,
          [id, actor.organizationId, input.transferDate, transferReference, actor.userId, now],
        )
        completed = updated.rows[0]!
        await writeAuditEvent(client, actor.organizationId, actor.userId, 'refund.completed', 'Refund', id, { transferDate: input.transferDate, transferReference }, now)
        notification = {
          eventKey: `refund:${id}:completed`,
          customerRef: completed.customerRef,
          text: `Your full Refund of ${completed.amount} ${completed.currency} was transferred on ${input.transferDate.toISOString().slice(0, 10)}. Reference: ${transferReference}.`,
        }
        await persistWhatsAppNotification(client, { organizationId: actor.organizationId, ...notification }, now)
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
      if (notification) notify({ organizationId: actor.organizationId, ...notification })
      return completed!
    },
  }
}

export const refunds = createRefundService()
