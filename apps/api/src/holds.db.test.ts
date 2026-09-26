import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { pool } from '@repo/db'
import { bookings } from './bookings'
import { createHoldService } from './holds'
import { createPaymentService } from './payments'

test.skipIf(process.env.PALAWA_DB_TESTS !== '1')('concurrent Holds cannot reserve more seats than the Trip quota', async () => {
  const suffix = randomUUID()
  const organizationId = `concurrent-test-${suffix}`
  const tripId = `trip-${suffix}`
  const now = new Date()
  const holds = createHoldService(undefined, () => {})

  try {
    await pool.query(
      `INSERT INTO "organization" (id, name, slug, "createdAt") VALUES ($1, 'Concurrent test', $1, $2)`,
      [organizationId, now],
    )
    await pool.query(
      `INSERT INTO "trip" (id, "organizationId", origin, destination, "departureAt", price, "seatQuota", status)
       VALUES ($1, $2, 'A', 'B', $3, 100, 1, 'PUBLISHED')`,
      [tripId, organizationId, new Date(now.getTime() + 86_400_000)],
    )
    await Bun.sleep(50)

    const results = await Promise.allSettled(['first', 'second'].map((customerRef) => holds.create({
      organizationId, tripId, customerRef, seatCount: 1, idempotencyKey: customerRef, now,
    })))
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    await Bun.sleep(50)
    const reserved = await pool.query<{ seats: number }>(
      `SELECT COALESCE(SUM("seatCount"), 0)::int AS seats FROM "hold" WHERE "organizationId" = $1 AND "tripId" = $2 AND status = 'ACTIVE'`,
      [organizationId, tripId],
    )
    expect(reserved.rows[0]?.seats).toBe(1)
  } finally {
    await pool.query(`DELETE FROM "organization" WHERE id = $1`, [organizationId])
  }
})

test.skipIf(process.env.PALAWA_DB_TESTS !== '1')('a pending Payment keeps the Hold and its price after the unpaid TTL', async () => {
  const suffix = randomUUID()
  const organizationId = `seat-test-${suffix}`
  const tripId = `trip-${suffix}`
  const now = new Date()
  const afterExpiry = new Date(now.getTime() + 16 * 60_000)
  const holds = createHoldService(undefined, () => {})

  try {
    await pool.query(
      `INSERT INTO "organization" (id, name, slug, "createdAt") VALUES ($1, 'Seat test', $1, $2)`,
      [organizationId, now],
    )
    await pool.query(
      `INSERT INTO "trip" (id, "organizationId", origin, destination, "departureAt", price, "seatQuota", status)
       VALUES ($1, $2, 'A', 'B', $3, 100, 1, 'PUBLISHED')`,
      [tripId, organizationId, new Date(now.getTime() + 86_400_000)],
    )
    // Let Bun's pg pool return setup connections before service transactions.
    await Bun.sleep(50)

    const hold = await holds.create({ organizationId, tripId, customerRef: 'first', seatCount: 1, idempotencyKey: 'first', now })
    expect(hold).toMatchObject({ priceAtHold: 100, currencyAtHold: 'IDR' })
    await pool.query(
      `INSERT INTO "payment" (id, "organizationId", "holdId", "customerRef", "proofKey", status, "idempotencyKey", "submittedAt")
       VALUES ($1, $2, $3, 'first', 'proof/first.jpg', 'PENDING', 'first', $4)`,
      [`payment-${suffix}`, organizationId, hold.id, new Date(now.getTime() + 14 * 60_000)],
    )
    await Bun.sleep(50)

    const holdNotice = await pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM "whatsappOutbox" WHERE "organizationId" = $1 AND "eventKey" = $2`,
      [organizationId, `hold:${hold.id}`],
    )
    expect(holdNotice.rows[0]?.count).toBe(1)
    await Bun.sleep(50)

    await expect(holds.create({
      organizationId, tripId, customerRef: 'second', seatCount: 1, idempotencyKey: 'second', now: afterExpiry,
    })).rejects.toThrow('Not enough seats available')
    const state = await pool.query<{ status: string; priceAtHold: number; currencyAtHold: string }>(
      `SELECT status, "priceAtHold", "currencyAtHold" FROM "hold" WHERE id = $1`,
      [hold.id],
    )
    expect(state.rows[0]).toEqual({ status: 'ACTIVE', priceAtHold: 100, currencyAtHold: 'IDR' })
  } finally {
    await pool.query(`DELETE FROM "organization" WHERE id = $1`, [organizationId])
  }
})

test.skipIf(process.env.PALAWA_DB_TESTS !== '1')('an idempotent retry returns an expired Hold after its unpaid TTL', async () => {
  const suffix = randomUUID()
  const organizationId = `retry-test-${suffix}`
  const tripId = `trip-${suffix}`
  const now = new Date()
  const holds = createHoldService(undefined, () => {})

  try {
    await pool.query(
      `INSERT INTO "organization" (id, name, slug, "createdAt") VALUES ($1, 'Retry test', $1, $2)`,
      [organizationId, now],
    )
    await pool.query(
      `INSERT INTO "trip" (id, "organizationId", origin, destination, "departureAt", price, "seatQuota", status)
       VALUES ($1, $2, 'A', 'B', $3, 100, 1, 'PUBLISHED')`,
      [tripId, organizationId, new Date(now.getTime() + 86_400_000)],
    )
    await Bun.sleep(50)
    const input = { organizationId, tripId, customerRef: 'customer', seatCount: 1, idempotencyKey: 'retry', now }
    const original = await holds.create(input)
    await Bun.sleep(50)
    const retry = await holds.create({ ...input, now: new Date(now.getTime() + 16 * 60_000) })
    expect(retry.id).toBe(original.id)
    expect(retry.status).toBe('EXPIRED')
    const audit = await pool.query<{ action: string; count: number }>(
      `SELECT action, COUNT(*)::int AS count FROM "auditEvent"
       WHERE "entityType" = 'Hold' AND "entityId" = $1 GROUP BY action ORDER BY action`,
      [original.id],
    )
    expect(audit.rows).toEqual([
      { action: 'hold.created', count: 1 },
      { action: 'hold.expired', count: 1 },
    ])
  } finally {
    await pool.query(`DELETE FROM "organization" WHERE id = $1`, [organizationId])
  }
})

test.skipIf(process.env.PALAWA_DB_TESTS !== '1')('Owner approval invoices the price locked when the Hold was created', async () => {
  const suffix = randomUUID()
  const organizationId = `price-test-${suffix}`
  const tripId = `trip-${suffix}`
  const ownerId = `owner-${suffix}`
  const now = new Date()
  const holds = createHoldService(undefined, () => {})
  const payments = createPaymentService(undefined, () => {})

  try {
    await pool.query(
      `INSERT INTO "organization" (id, name, slug, "createdAt") VALUES ($1, 'Price test', $1, $2)`,
      [organizationId, now],
    )
    await pool.query(
      `INSERT INTO "user" (id, name, email) VALUES ($1, 'Price test Owner', $2)`,
      [ownerId, `${suffix}@example.test`],
    )
    await pool.query(
      `INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt") VALUES ($1, $2, $3, 'owner', $4)`,
      [`member-${suffix}`, organizationId, ownerId, now],
    )
    await pool.query(
      `INSERT INTO "trip" (id, "organizationId", origin, destination, "departureAt", price, "seatQuota", status)
       VALUES ($1, $2, 'A', 'B', $3, 100, 3, 'PUBLISHED')`,
      [tripId, organizationId, new Date(now.getTime() + 86_400_000)],
    )
    await Bun.sleep(50)

    const hold = await holds.create({ organizationId, tripId, customerRef: 'customer', seatCount: 2, idempotencyKey: 'hold', now })
    const holdNotice = await pool.query<{ text: string }>(
      `SELECT text FROM "whatsappOutbox" WHERE "organizationId" = $1 AND "eventKey" = $2`,
      [organizationId, `hold:${hold.id}`],
    )
    expect(holdNotice.rows[0]?.text).toContain('Total due: 200 IDR')
    await Bun.sleep(50)
    const paymentInput = {
      organizationId,
      holdId: hold.id,
      customerRef: 'customer',
      proofKey: 'proof/receipt.jpg',
      idempotencyKey: 'payment',
      now: new Date(now.getTime() + 14 * 60_000),
    }
    const payment = await payments.submit(paymentInput)
    const paymentRetry = await payments.submit(paymentInput)
    expect(paymentRetry.id).toBe(payment.id)
    const customerPayment = await payments.getForCustomer(organizationId, 'customer')
    expect(customerPayment).toMatchObject({ id: payment.id, status: 'PENDING' })
    expect(customerPayment).not.toHaveProperty('proofKey')
    expect(await payments.getForCustomer(organizationId, 'another-customer')).toBeNull()
    const paymentNotice = await pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM "whatsappOutbox" WHERE "organizationId" = $1 AND "eventKey" = $2`,
      [organizationId, `payment:${payment.id}:submitted`],
    )
    expect(paymentNotice.rows[0]?.count).toBe(1)
    const pendingNotice = await pool.query<{ text: string }>(
      `SELECT text FROM "whatsappOutbox" WHERE "organizationId" = $1 AND "eventKey" = $2`,
      [organizationId, `payment:${payment.id}:submitted`],
    )
    expect(pendingNotice.rows[0]?.text).toContain('pending Owner review')
    const submittedAudit = await pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM "auditEvent" WHERE "entityType" = 'Payment' AND "entityId" = $1 AND action = 'payment.submitted'`,
      [payment.id],
    )
    expect(submittedAudit.rows[0]?.count).toBe(1)
    const pendingHold = await pool.query<{ status: string }>(`SELECT status FROM "hold" WHERE id = $1`, [hold.id])
    expect(pendingHold.rows[0]?.status).toBe('ACTIVE')
    await Bun.sleep(50)
    await pool.query(`UPDATE "trip" SET price = 200 WHERE id = $1`, [tripId])
    await Bun.sleep(50)
    const secondHold = await holds.create({
      organizationId, tripId, customerRef: 'second', seatCount: 1, idempotencyKey: 'second',
      now: new Date(now.getTime() + 14 * 60_000),
    })
    await Bun.sleep(50)
    const secondPayment = await payments.submit({
      organizationId,
      holdId: secondHold.id,
      customerRef: 'second',
      proofKey: 'proof/second.jpg',
      idempotencyKey: 'second',
      now: new Date(now.getTime() + 14 * 60_000),
    })
    await Bun.sleep(50)

    await expect(holds.create({
      organizationId, tripId, customerRef: 'third', seatCount: 1, idempotencyKey: 'third',
      now: new Date(now.getTime() + 14 * 60_000),
    })).rejects.toThrow('Not enough seats available')

    const approved = await payments.review(
      { userId: ownerId, organizationId }, payment.id, { status: 'APPROVED' }, new Date(now.getTime() + 16 * 60_000),
    )
    expect(approved.status).toBe('APPROVED')
    const convertedHold = await pool.query<{ status: string }>(`SELECT status FROM "hold" WHERE id = $1`, [hold.id])
    expect(convertedHold.rows[0]?.status).toBe('ACTIVE')
    const confirmationNotice = await pool.query<{ text: string; bookingId: string; amount: number; currency: string }>(
      `SELECT o.text, b.id AS "bookingId", i.amount, i.currency
       FROM "whatsappOutbox" o
       JOIN "booking" b ON b."paymentId" = $3 AND b."organizationId" = o."organizationId"
       JOIN "invoice" i ON i."bookingId" = b.id
       WHERE o."organizationId" = $1 AND o."eventKey" = $2`,
      [organizationId, `booking:${payment.id}:confirmed`, payment.id],
    )
    expect(confirmationNotice.rows[0]?.text).toContain(`Booking ${confirmationNotice.rows[0]?.bookingId} is confirmed.`)
    expect(confirmationNotice.rows[0]?.text).toContain(`${confirmationNotice.rows[0]?.amount} ${confirmationNotice.rows[0]?.currency}`)
    const invoice = await pool.query<{ amount: number; currency: string }>(
      `SELECT amount, currency FROM "invoice" WHERE "bookingId" = (SELECT id FROM "booking" WHERE "paymentId" = $1)`,
      [payment.id],
    )
    expect(invoice.rows[0]).toEqual({ amount: 200, currency: 'IDR' })
    expect(await bookings.getForCustomer(organizationId, 'customer')).toMatchObject({ id: confirmationNotice.rows[0]?.bookingId })

    const afterReview = new Date(now.getTime() + 17 * 60_000)
    const rejected = await payments.review(
      { userId: ownerId, organizationId }, secondPayment.id, { status: 'REJECTED', reason: 'Amount does not match' },
      afterReview,
    )
    expect(rejected.status).toBe('REJECTED')
    const rejectedBooking = await pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM "booking" WHERE "paymentId" = $1`,
      [secondPayment.id],
    )
    expect(rejectedBooking.rows[0]?.count).toBe(0)
    const rejectionAudit = await pool.query<{ action: string }>(
      `SELECT action FROM "auditEvent" WHERE "entityType" = 'Payment' AND "entityId" = $1`,
      [secondPayment.id],
    )
    expect(rejectionAudit.rows.map((row) => row.action)).toContain('payment.rejected')
    const rejectionNotice = await pool.query<{ count: number; text: string }>(
      `SELECT COUNT(*)::int AS count, MIN(text) AS text FROM "whatsappOutbox" WHERE "organizationId" = $1 AND "eventKey" = $2 GROUP BY "organizationId", "eventKey"`,
      [organizationId, `payment:${secondPayment.id}:rejected`],
    )
    expect(rejectionNotice.rows[0]?.count).toBe(1)
    expect(rejectionNotice.rows[0]?.text).toContain('Amount does not match')
    const closedHold = await pool.query<{ status: string }>(
      `SELECT status FROM "hold" WHERE id = $1`,
      [secondHold.id],
    )
    expect(closedHold.rows[0]?.status).toBe('CANCELLED')
    await Bun.sleep(50)
    const replacement = await holds.create({
      organizationId, tripId, customerRef: 'replacement', seatCount: 1, idempotencyKey: 'replacement',
      now: afterReview,
    })
    expect(replacement.status).toBe('ACTIVE')
    await Bun.sleep(50)
    const cancelled = await holds.cancel(organizationId, replacement.id, 'replacement', afterReview)
    expect(cancelled?.status).toBe('CANCELLED')
    const holdAudit = await pool.query<{ action: string }>(
      `SELECT action FROM "auditEvent" WHERE "entityType" = 'Hold' AND "entityId" = $1`,
      [replacement.id],
    )
    expect(holdAudit.rows.map((row) => row.action)).toContain('hold.cancelled')
    const cancelledNotice = await pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM "whatsappOutbox" WHERE "organizationId" = $1 AND "eventKey" = $2`,
      [organizationId, `hold:${replacement.id}:cancelled`],
    )
    expect(cancelledNotice.rows[0]?.count).toBe(1)
    await Bun.sleep(50)
    await expect(holds.create({
      organizationId, tripId, customerRef: 'after-cancel', seatCount: 1, idempotencyKey: 'after-cancel',
      now: afterReview,
    })).resolves.toMatchObject({ status: 'ACTIVE' })
    await expect(holds.create({
      organizationId, tripId, customerRef: 'over-capacity', seatCount: 1, idempotencyKey: 'over-capacity',
      now: afterReview,
    })).rejects.toThrow('Not enough seats available')
  } finally {
    await pool.query(`DELETE FROM "organization" WHERE id = $1`, [organizationId])
    await pool.query(`DELETE FROM "user" WHERE id = $1`, [ownerId])
  }
})
