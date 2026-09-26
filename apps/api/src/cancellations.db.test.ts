import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { pool } from '@repo/db'
import { bookings } from './bookings'
import { createCancellationService, createRefundService } from './cancellations'
import { createHoldService } from './holds'
import { createPaymentService } from './payments'

test.skipIf(process.env.PALAWA_DB_TESTS !== '1')('a Customer cancellation is replay-safe and only Owner approval cancels the Booking', async () => {
  const suffix = randomUUID()
  const organizationId = `cancel-test-${suffix}`
  const ownerId = `owner-${suffix}`
  const tripId = `trip-${suffix}`
  const customerRef = '+628123456789'
  const now = new Date()
  const holds = createHoldService(undefined, () => {})
  const payments = createPaymentService(undefined, () => {})

  try {
    await pool.query(
      `INSERT INTO "organization" (id, name, slug, "createdAt") VALUES ($1, 'Cancellation test', $1, $2)`,
      [organizationId, now],
    )
    await pool.query(`INSERT INTO "user" (id, name, email) VALUES ($1, 'Cancellation owner', $2)`, [ownerId, `${suffix}@example.test`])
    await pool.query(
      `INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt") VALUES ($1, $2, $3, 'owner', $4)`,
      [`member-${suffix}`, organizationId, ownerId, now],
    )
    await pool.query(
      `INSERT INTO "trip" (id, "organizationId", origin, destination, "departureAt", price, currency, "seatQuota", status)
       VALUES ($1, $2, 'A', 'B', $3, 500, 'IDR', 2, 'PUBLISHED')`,
      [tripId, organizationId, new Date(now.getTime() + 2 * 86_400_000)],
    )
    await Bun.sleep(50)

    const hold = await holds.create({ organizationId, tripId, customerRef, seatCount: 2, idempotencyKey: 'cancel-booking', now })
    const payment = await payments.submit({
      organizationId,
      holdId: hold.id,
      customerRef,
      proofKey: 'proof/receipt.jpg',
      idempotencyKey: 'cancel-booking-payment',
      now: new Date(now.getTime() + 60_000),
    })
    await payments.review({ userId: ownerId, organizationId }, payment.id, { status: 'APPROVED' }, new Date(now.getTime() + 120_000))
    const booking = await bookings.getForCustomer(organizationId, customerRef)
    expect(booking).not.toBeNull()

    const service = createCancellationService(() => {})
    const input = {
      organizationId,
      customerRef,
      bookingId: booking!.id,
      idempotencyKey: 'whatsapp:cancellation-message',
      now: new Date(now.getTime() + 180_000),
    }
    await pool.query(`UPDATE "trip" SET "departureAt" = $2 WHERE id = $1`, [tripId, new Date(now.getTime() - 1000)])
    let afterDepartureRejected = false
    try {
      await service.request({ ...input, idempotencyKey: 'whatsapp:too-late' })
    } catch (error) {
      afterDepartureRejected = error instanceof Error && error.message.includes('before departure')
    }
    expect(afterDepartureRejected).toBe(true)
    await pool.query(`UPDATE "trip" SET "departureAt" = $2 WHERE id = $1`, [tripId, new Date(now.getTime() + 2 * 86_400_000)])

    const first = await service.request(input)
    const replay = await service.request(input)
    const duplicatePending = await service.request({ ...input, idempotencyKey: 'whatsapp:another-cancellation-message' })
    expect(await service.request({ ...input, customerRef: '+6285555555555', idempotencyKey: 'whatsapp:foreign-customer' })).toBeNull()
    expect((await service.listPending({ userId: ownerId, organizationId })).map((item) => item.id)).toContain(first!.id)
    let nonOwnerBlocked = false
    try {
      await service.review({ userId: `non-owner-${suffix}`, organizationId }, first!.id, { decision: 'REJECT', reason: 'Not an Owner' })
    } catch (error) {
      nonOwnerBlocked = error instanceof Error && error.message === 'Owner access required'
    }
    expect(nonOwnerBlocked).toBe(true)
    const currentBooking = await bookings.getForCustomer(organizationId, customerRef, booking!.id)
    const notice = await pool.query<{ text: string }>(
      `SELECT text FROM "whatsappOutbox" WHERE "organizationId" = $1 AND "eventKey" = $2`,
      [organizationId, `cancellation:${first!.id}:requested`],
    )
    const audit = await pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM "auditEvent" WHERE "organizationId" = $1 AND action = 'cancellation.requested' AND "entityId" = $2`,
      [organizationId, first!.id],
    )

    expect(first).toMatchObject({ bookingId: booking!.id, paymentId: null, customerRef, status: 'PENDING' })
    expect(replay?.id).toBe(first?.id)
    expect(duplicatePending?.id).toBe(first?.id)
    expect(currentBooking?.status).toBe('CONFIRMED')
    expect(notice.rows[0]?.text).toContain('remains confirmed')
    expect(audit.rows[0]?.count).toBe(1)

    const review = await service.review({ userId: ownerId, organizationId }, first!.id, {
      decision: 'REJECT',
      reason: 'The trip can no longer be changed at this time.',
    }, new Date(now.getTime() + 240_000))
    const rejectedBooking = await bookings.getForCustomer(organizationId, customerRef, booking!.id)
    const rejectedNotice = await pool.query<{ text: string }>(
      `SELECT text FROM "whatsappOutbox" WHERE "organizationId" = $1 AND "eventKey" = $2`,
      [organizationId, `cancellation:${first!.id}:rejected`],
    )
    const rejectedAudit = await pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM "auditEvent" WHERE "organizationId" = $1 AND action = 'cancellation.rejected' AND "entityId" = $2`,
      [organizationId, first!.id],
    )
    expect(review.cancellation).toMatchObject({ id: first!.id, status: 'REJECTED', reason: 'The trip can no longer be changed at this time.' })
    expect(review.refund).toBeNull()
    expect(rejectedBooking?.status).toBe('CONFIRMED')
    expect(rejectedNotice.rows[0]?.text).toContain('The trip can no longer be changed at this time.')
    expect(rejectedAudit.rows[0]?.count).toBe(1)

    const secondRequest = await service.request({ ...input, idempotencyKey: 'whatsapp:cancellation-message-2' })
    const approved = await service.review({ userId: ownerId, organizationId }, secondRequest!.id, { decision: 'APPROVE' }, new Date(now.getTime() + 300_000))
    const cancelledBooking = await bookings.getForCustomer(organizationId, customerRef, booking!.id)
    const cancelledHold = await pool.query<{ status: string }>(`SELECT status FROM "hold" WHERE id = $1`, [hold.id])
    const approvalNotice = await pool.query<{ text: string }>(
      `SELECT text FROM "whatsappOutbox" WHERE "organizationId" = $1 AND "eventKey" = $2`,
      [organizationId, `cancellation:${secondRequest!.id}:approved`],
    )
    const approvalAudit = await pool.query<{ action: string }>(
      `SELECT action FROM "auditEvent" WHERE "organizationId" = $1 AND "entityId" = ANY($2::text[])`,
      [organizationId, [secondRequest!.id, booking!.id, approved.refund!.id]],
    )
    const replacement = await holds.create({
      organizationId,
      tripId,
      customerRef: '+628987654321',
      seatCount: 2,
      idempotencyKey: 'after-cancellation',
      now: new Date(now.getTime() + 360_000),
    })
    expect(approved.cancellation.status).toBe('APPROVED')
    expect(approved.refund).toMatchObject({ bookingId: booking!.id, paymentId: null, amount: 1000, currency: 'IDR', status: 'PENDING' })
    expect(cancelledBooking?.status).toBe('CANCELLED')
    expect(cancelledHold.rows[0]?.status).toBe('CANCELLED')
    expect(approvalNotice.rows[0]?.text).toContain('full Refund')
    expect(approvalAudit.rows.map((row) => row.action)).toEqual(expect.arrayContaining(['cancellation.approved', 'booking.cancelled', 'refund.created']))
    expect(replacement.status).toBe('ACTIVE')

    const refundService = createRefundService(() => {})
    expect((await refundService.listOwner({ userId: ownerId, organizationId })).map((item) => item.id)).toContain(approved.refund!.id)
    const transferDate = new Date(now.getTime() + 420_000)
    const completedRefund = await refundService.complete(
      { userId: ownerId, organizationId },
      approved.refund!.id,
      { transferDate, transferReference: 'BANK-REF-123' },
      new Date(now.getTime() + 480_000),
    )
    const replayedRefund = await refundService.complete(
      { userId: ownerId, organizationId },
      approved.refund!.id,
      { transferDate, transferReference: 'SHOULD-NOT-REPLACE' },
      new Date(now.getTime() + 540_000),
    )
    const refundNotice = await pool.query<{ count: number; text: string }>(
      `SELECT COUNT(*)::int AS count, MIN(text) AS text FROM "whatsappOutbox" WHERE "organizationId" = $1 AND "eventKey" = $2 GROUP BY "organizationId", "eventKey"`,
      [organizationId, `refund:${approved.refund!.id}:completed`],
    )
    const refundAudit = await pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM "auditEvent" WHERE "organizationId" = $1 AND "entityType" = 'Refund' AND "entityId" = $2 AND action = 'refund.completed'`,
      [organizationId, approved.refund!.id],
    )
    expect(completedRefund).toMatchObject({ status: 'COMPLETED', transferReference: 'BANK-REF-123', recordedBy: ownerId })
    expect(completedRefund.transferredAt).toEqual(transferDate)
    expect(replayedRefund).toEqual(completedRefund)
    expect(refundNotice.rows[0]?.count).toBe(1)
    expect(refundNotice.rows[0]?.text).toContain('BANK-REF-123')
    expect(refundAudit.rows[0]?.count).toBe(1)
  } finally {
    await pool.query(`DELETE FROM "organization" WHERE id = $1`, [organizationId])
    await pool.query(`DELETE FROM "user" WHERE id = $1`, [ownerId])
  }
})

test.skipIf(process.env.PALAWA_DB_TESTS !== '1')('a pending Payment cancellation either creates a Refund or rejects the Payment and releases the Hold', async () => {
  const holds = createHoldService(undefined, () => {})
  const payments = createPaymentService(undefined, () => {})
  const cancellationService = createCancellationService(() => {})
  const refundService = createRefundService(() => {})
  const now = new Date()

  async function setup(suffix: string) {
    const organizationId = `pending-cancel-${suffix}`
    const ownerId = `owner-${suffix}`
    const tripId = `trip-${suffix}`
    const customerRef = suffix.includes('not-received') ? '+628123450002' : '+628123450001'
    await pool.query(
      `INSERT INTO "organization" (id, name, slug, "createdAt") VALUES ($1, 'Pending cancellation test', $1, $2)`,
      [organizationId, now],
    )
    await pool.query(`INSERT INTO "user" (id, name, email) VALUES ($1, 'Pending cancellation owner', $2)`, [ownerId, `${suffix}@example.test`])
    await pool.query(
      `INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt") VALUES ($1, $2, $3, 'owner', $4)`,
      [`member-${suffix}`, organizationId, ownerId, now],
    )
    await pool.query(
      `INSERT INTO "trip" (id, "organizationId", origin, destination, "departureAt", price, currency, "seatQuota", status)
       VALUES ($1, $2, 'A', 'B', $3, 250, 'IDR', 1, 'PUBLISHED')`,
      [tripId, organizationId, new Date(now.getTime() + 2 * 86_400_000)],
    )
    await Bun.sleep(50)
    const hold = await holds.create({ organizationId, tripId, customerRef, seatCount: 1, idempotencyKey: suffix, now })
    const payment = await payments.submit({
      organizationId,
      holdId: hold.id,
      customerRef,
      proofKey: 'proof/receipt.jpg',
      idempotencyKey: suffix,
      now: new Date(now.getTime() + 60_000),
    })
    return { organizationId, ownerId, tripId, customerRef, hold, payment }
  }

  const received = await setup(`${randomUUID()}-received`)
  const notReceived = await setup(`${randomUUID()}-not-received`)
  try {
    const receivedRequest = await cancellationService.request({
      organizationId: received.organizationId,
      customerRef: received.customerRef,
      paymentId: received.payment.id,
      idempotencyKey: 'pending-payment-cancel-received',
      now: new Date(now.getTime() + 120_000),
    })
    let normalPaymentReviewBlocked = false
    try {
      await payments.review(
        { userId: received.ownerId, organizationId: received.organizationId },
        received.payment.id,
        { status: 'APPROVED' },
        new Date(now.getTime() + 150_000),
      )
    } catch (error) {
      normalPaymentReviewBlocked = error instanceof Error && error.message.includes('pending cancellation request')
    }
    expect(normalPaymentReviewBlocked).toBe(true)
    const receivedReview = await cancellationService.review(
      { userId: received.ownerId, organizationId: received.organizationId },
      receivedRequest!.id,
      { decision: 'APPROVE', fundsReceived: true },
      new Date(now.getTime() + 180_000),
    )
    const receivedPayment = await payments.getForCustomer(received.organizationId, received.customerRef, received.payment.id)
    const receivedHold = await pool.query<{ status: string }>(`SELECT status FROM "hold" WHERE id = $1`, [received.hold.id])
    const booking = await pool.query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM "booking" WHERE "paymentId" = $1`, [received.payment.id])
    const receivedAudit = await pool.query<{ action: string }>(
      `SELECT action FROM "auditEvent" WHERE "organizationId" = $1 AND "entityId" = ANY($2::text[])`,
      [received.organizationId, [receivedRequest!.id, received.payment.id, received.hold.id, receivedReview.refund!.id]],
    )
    expect(receivedReview.cancellation.status).toBe('APPROVED')
    expect(receivedReview.refund).toMatchObject({ paymentId: received.payment.id, amount: 250, currency: 'IDR', status: 'PENDING' })
    expect(receivedPayment?.status).toBe('REFUND_PENDING')
    expect(receivedHold.rows[0]?.status).toBe('CANCELLED')
    expect(booking.rows[0]?.count).toBe(0)
    expect(receivedAudit.rows.map((row) => row.action)).toEqual(expect.arrayContaining([
      'cancellation.approved', 'payment.refund_pending', 'hold.cancelled', 'refund.created',
    ]))

    const completed = await refundService.complete(
      { userId: received.ownerId, organizationId: received.organizationId },
      receivedReview.refund!.id,
      { transferDate: new Date(now.getTime() + 240_000), transferReference: 'BANK-PENDING-001' },
      new Date(now.getTime() + 300_000),
    )
    expect(completed.status).toBe('COMPLETED')
    expect((await payments.getForCustomer(received.organizationId, received.customerRef, received.payment.id))?.status).toBe('REFUNDED')

    const notReceivedRequest = await cancellationService.request({
      organizationId: notReceived.organizationId,
      customerRef: notReceived.customerRef,
      paymentId: notReceived.payment.id,
      idempotencyKey: 'pending-payment-cancel-not-received',
      now: new Date(now.getTime() + 120_000),
    })
    const notReceivedReview = await cancellationService.review(
      { userId: notReceived.ownerId, organizationId: notReceived.organizationId },
      notReceivedRequest!.id,
      { decision: 'APPROVE', fundsReceived: false },
      new Date(now.getTime() + 180_000),
    )
    expect(notReceivedReview.cancellation.status).toBe('APPROVED')
    expect(notReceivedReview.refund).toBeNull()
    expect((await payments.getForCustomer(notReceived.organizationId, notReceived.customerRef, notReceived.payment.id))?.status).toBe('REJECTED')
    const notReceivedHold = await pool.query<{ status: string }>(`SELECT status FROM "hold" WHERE id = $1`, [notReceived.hold.id])
    const notReceivedAudit = await pool.query<{ action: string }>(
      `SELECT action FROM "auditEvent" WHERE "organizationId" = $1 AND "entityId" = ANY($2::text[])`,
      [notReceived.organizationId, [notReceivedRequest!.id, notReceived.payment.id, notReceived.hold.id]],
    )
    expect(notReceivedHold.rows[0]?.status).toBe('CANCELLED')
    expect(notReceivedAudit.rows.map((row) => row.action)).toEqual(expect.arrayContaining([
      'cancellation.approved', 'payment.rejected', 'hold.cancelled',
    ]))
  } finally {
    await pool.query(`DELETE FROM "organization" WHERE id = ANY($1::text[])`, [[received.organizationId, notReceived.organizationId]])
    await pool.query(`DELETE FROM "user" WHERE id = ANY($1::text[])`, [[received.ownerId, notReceived.ownerId]])
  }
})
