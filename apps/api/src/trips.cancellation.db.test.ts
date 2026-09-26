import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { pool } from '@repo/db'
import { bookings } from './bookings'
import { createCancellationService, refunds } from './cancellations'
import { createHoldService } from './holds'
import { createPaymentService } from './payments'
import { trips } from './trips'

test.skipIf(process.env.PALAWA_DB_TESTS !== '1')('cancelling a Trip resolves its Holds, pending Payments, Bookings, Refunds, and cancellation cases once', async () => {
  const suffix = randomUUID()
  const organizationId = `trip-cancel-${suffix}`
  const ownerId = `owner-${suffix}`
  const tripId = `trip-${suffix}`
  const now = new Date()
  const holds = createHoldService(undefined, () => {})
  const payments = createPaymentService(undefined, () => {})
  const cancellations = createCancellationService(() => {})

  try {
    await pool.query(
      `INSERT INTO "organization" (id, name, slug, "createdAt") VALUES ($1, 'Trip cancellation test', $1, $2)`,
      [organizationId, now],
    )
    await pool.query(`INSERT INTO "user" (id, name, email, "twoFactorEnabled") VALUES ($1, 'Trip cancellation owner', $2, true)`, [ownerId, `${suffix}@example.test`])
    await pool.query(
      `INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt") VALUES ($1, $2, $3, 'owner', $4)`,
      [`member-${suffix}`, organizationId, ownerId, now],
    )
    await pool.query(
      `INSERT INTO "trip" (id, "organizationId", origin, destination, "departureAt", price, currency, "seatQuota", status)
       VALUES ($1, $2, 'A', 'B', $3, 200, 'IDR', 5, 'PUBLISHED')`,
      [tripId, organizationId, new Date(now.getTime() + 2 * 86_400_000)],
    )
    await Bun.sleep(50)

    const unpaidHold = await holds.create({ organizationId, tripId, customerRef: '+6281000000001', seatCount: 1, idempotencyKey: 'unpaid', now })
    const receivedHold = await holds.create({ organizationId, tripId, customerRef: '+6281000000002', seatCount: 1, idempotencyKey: 'received', now })
    const receivedPayment = await payments.submit({ organizationId, holdId: receivedHold.id, customerRef: receivedHold.customerRef, proofKey: 'proof/received.jpg', idempotencyKey: 'received', now: new Date(now.getTime() + 60_000) })
    const unpaidProofHold = await holds.create({ organizationId, tripId, customerRef: '+6281000000003', seatCount: 1, idempotencyKey: 'unreceived', now })
    const unpaidProof = await payments.submit({ organizationId, holdId: unpaidProofHold.id, customerRef: unpaidProofHold.customerRef, proofKey: 'proof/unreceived.jpg', idempotencyKey: 'unreceived', now: new Date(now.getTime() + 60_000) })
    const bookingHold = await holds.create({ organizationId, tripId, customerRef: '+6281000000004', seatCount: 2, idempotencyKey: 'booking', now })
    const bookingPayment = await payments.submit({ organizationId, holdId: bookingHold.id, customerRef: bookingHold.customerRef, proofKey: 'proof/booking.jpg', idempotencyKey: 'booking', now: new Date(now.getTime() + 60_000) })
    await payments.review({ userId: ownerId, organizationId }, bookingPayment.id, { status: 'APPROVED' }, new Date(now.getTime() + 120_000))
    const booking = await bookings.getForCustomer(organizationId, bookingHold.customerRef)
    expect(booking).not.toBeNull()

    const customerPaymentCase = await cancellations.request({
      organizationId,
      customerRef: receivedHold.customerRef,
      paymentId: receivedPayment.id,
      idempotencyKey: `whatsapp:${receivedPayment.id}:cancel`,
      now: new Date(now.getTime() + 180_000),
    })
    let archiveBlocked = false
    try {
      await trips.update({ userId: ownerId, organizationId }, tripId, { status: 'ARCHIVED' })
    } catch (error) {
      archiveBlocked = error instanceof Error && error.message.includes('active Holds or Bookings')
    }
    expect(archiveBlocked).toBe(true)

    const decisions = [
      { paymentId: receivedPayment.id, fundsReceived: true },
      { paymentId: unpaidProof.id, fundsReceived: false },
    ]
    let missingDecisionRejected = false
    try {
      await trips.cancel({ userId: ownerId, organizationId }, tripId, [decisions[0]!])
    } catch (error) {
      missingDecisionRejected = error instanceof Error && error.message.includes('decision for every pending Payment')
    }
    const beforeCancel = await pool.query<{ status: string }>(`SELECT status FROM "trip" WHERE id = $1`, [tripId])
    expect(missingDecisionRejected).toBe(true)
    expect(beforeCancel.rows[0]?.status).toBe('PUBLISHED')
    const cancelled = await trips.cancel({ userId: ownerId, organizationId }, tripId, decisions)
    const replay = await trips.cancel({ userId: ownerId, organizationId }, tripId, decisions)
    const currentPayments = await Promise.all([
      payments.getForCustomer(organizationId, receivedHold.customerRef, receivedPayment.id),
      payments.getForCustomer(organizationId, unpaidProofHold.customerRef, unpaidProof.id),
    ])
    const holdStates = await pool.query<{ id: string; status: string }>(
      `SELECT id, status FROM "hold" WHERE id = ANY($1::text[]) ORDER BY id`,
      [[unpaidHold.id, receivedHold.id, unpaidProofHold.id, bookingHold.id]],
    )
    const bookingState = await bookings.getForCustomer(organizationId, bookingHold.customerRef, booking!.id)
    const refundRows = await refunds.listOwner({ userId: ownerId, organizationId })
    const cancellationRows = await pool.query<{ source: string; status: string }>(
      `SELECT source, status FROM "cancellationRequest" WHERE "organizationId" = $1 ORDER BY source, status`,
      [organizationId],
    )
    const outbox = await pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM "whatsappOutbox" WHERE "organizationId" = $1 AND "eventKey" LIKE $2`,
      [organizationId, `trip:${tripId}:%`],
    )
    const audit = await pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM "auditEvent" WHERE "organizationId" = $1 AND action = 'trip.cancelled' AND "entityId" = $2`,
      [organizationId, tripId],
    )
    expect(cancelled.status).toBe('CANCELLED')
    expect(replay.status).toBe('CANCELLED')
    expect(currentPayments.map((payment) => payment?.status)).toEqual(['REFUND_PENDING', 'REJECTED'])
    expect(holdStates.rows.every((hold) => hold.status === 'CANCELLED')).toBe(true)
    expect(bookingState?.status).toBe('CANCELLED')
    expect(Object.fromEntries(refundRows.map((refund) => [
      refund.paymentId ?? refund.bookingId ?? 'missing-target',
      { amount: refund.amount, currency: refund.currency },
    ]))).toEqual({
      [receivedPayment.id]: { amount: 200, currency: 'IDR' },
      [booking!.id]: { amount: 400, currency: 'IDR' },
    })
    expect(cancellationRows.rows).toEqual([
      { source: 'CUSTOMER', status: 'APPROVED' },
      { source: 'TRIP', status: 'APPROVED' },
      { source: 'TRIP', status: 'APPROVED' },
    ])
    expect(outbox.rows[0]?.count).toBe(4)
    expect(audit.rows[0]?.count).toBe(1)

    let archivedCancelledTrip = false
    try {
      await trips.update({ userId: ownerId, organizationId }, tripId, { status: 'ARCHIVED' })
    } catch (error) {
      archivedCancelledTrip = error instanceof Error && error.message.includes('Cancelled Trip')
    }
    expect(archivedCancelledTrip).toBe(true)
  } finally {
    await pool.query(`DELETE FROM "organization" WHERE id = $1`, [organizationId])
    await pool.query(`DELETE FROM "user" WHERE id = $1`, [ownerId])
  }
})
