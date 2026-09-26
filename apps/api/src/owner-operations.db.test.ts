import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { pool } from '@repo/db'
import { bookings } from './bookings'
import { createCancellationService, createRefundService } from './cancellations'
import { dashboard } from './dashboard'
import { createHoldService } from './holds'
import { createPaymentService } from './payments'
import { trips } from './trips'
import { vehicles } from './vehicles'

async function errorMessage(action: Promise<unknown>): Promise<string> {
  try {
    await action
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  return ''
}

test.skipIf(process.env.PALAWA_DB_TESTS !== '1')('Owner operations, Vehicles, moneyflow, audit, and scope use the Travel business data', async () => {
  const suffix = randomUUID()
  const organizationId = `owner-ops-${suffix}`
  const otherOrganizationId = `other-ops-${suffix}`
  const ownerId = `owner-${suffix}`
  const now = new Date()
  const actor = { userId: ownerId, organizationId }
  const holds = createHoldService(undefined, () => {})
  const payments = createPaymentService(undefined, () => {})
  const cancellations = createCancellationService(() => {})
  const refundService = createRefundService(() => {})

  try {
    await pool.query(
      `INSERT INTO "organization" (id, name, slug, "createdAt") VALUES ($1, 'Owner ops test', $1, $2), ($3, 'Other owner ops test', $3, $2)`,
      [organizationId, now, otherOrganizationId],
    )
    await pool.query(`INSERT INTO "user" (id, name, email) VALUES ($1, 'Owner ops test', $2)`, [ownerId, `${suffix}@example.test`])
    await pool.query(
      `INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt") VALUES ($1, $2, $3, 'owner', $4)`,
      [`member-${suffix}`, organizationId, ownerId, now],
    )
    await pool.query(
      `INSERT INTO "vehicle" (id, "organizationId", name, "plateNumber", status, "createdAt", "updatedAt")
       VALUES ($1, $2, 'Other business bus', 'OTHER-' || $3, 'AVAILABLE', $4, $4)`,
      [`vehicle-other-${suffix}`, otherOrganizationId, suffix.slice(0, 6), now],
    )
    const trip = await trips.create(actor, {
      origin: 'Jakarta',
      destination: 'Bandung',
      departureAt: new Date(now.getTime() + 5 * 86_400_000),
      price: 100_000,
      seatQuota: 8,
    })
    await trips.update(actor, trip.id, { status: 'PUBLISHED' })
    const vehicle = await vehicles.create(actor, { name: 'Executive coach', plateNumber: `B-${suffix.slice(0, 6)}` })
    expect(await errorMessage(vehicles.updateStatus(actor, vehicle.id, 'ASSIGNED'))).toContain('Assign the Vehicle to a Trip')
    expect(await errorMessage(trips.update(actor, trip.id, { vehicleId: `vehicle-other-${suffix}` }))).toContain('Vehicle not found for this Travel business')
    await trips.update(actor, trip.id, { vehicleId: vehicle.id })
    expect((await vehicles.list(actor)).map((item) => item.id)).toEqual([vehicle.id])
    expect(await errorMessage(vehicles.updateStatus(actor, vehicle.id, 'MAINTENANCE'))).toContain('Unassign the Vehicle')
    await trips.update(actor, trip.id, { vehicleId: null })
    await vehicles.updateStatus(actor, vehicle.id, 'MAINTENANCE')
    expect(await errorMessage(trips.update(actor, trip.id, { vehicleId: vehicle.id }))).toContain('maintenance')
    await vehicles.updateStatus(actor, vehicle.id, 'AVAILABLE')
    await trips.update(actor, trip.id, { vehicleId: vehicle.id })

    const digits = suffix.replace(/\D/g, '').slice(0, 8).padEnd(8, '0')
    const customer = (index: number) => `+628${digits}${index}`
    const unpaidHold = await holds.create({ organizationId, tripId: trip.id, customerRef: customer(1), seatCount: 1, idempotencyKey: 'unpaid' })
    const pendingHold = await holds.create({ organizationId, tripId: trip.id, customerRef: customer(2), seatCount: 2, idempotencyKey: 'pending' })
    const pendingPayment = await payments.submit({
      organizationId, holdId: pendingHold.id, customerRef: customer(2), proofKey: 'proof/pending.jpg', idempotencyKey: 'pending',
    })

    const confirmed: Array<{ customerRef: string; id: string }> = []
    for (const index of [3, 4, 5]) {
      const customerRef = customer(index)
      const hold = await holds.create({ organizationId, tripId: trip.id, customerRef, seatCount: 1, idempotencyKey: `booking-${index}` })
      const payment = await payments.submit({
        organizationId, holdId: hold.id, customerRef, proofKey: `proof/booking-${index}.jpg`, idempotencyKey: `booking-${index}`,
      })
      await payments.review(actor, payment.id, { status: 'APPROVED' })
      const booking = await bookings.getForCustomer(organizationId, customerRef)
      expect(booking).not.toBeNull()
      confirmed.push({ customerRef, id: booking!.id })
    }

    const pendingCase = await cancellations.request({
      organizationId, customerRef: confirmed[0]!.customerRef, bookingId: confirmed[0]!.id, idempotencyKey: 'cancel-pending',
    })
    expect(pendingCase?.status).toBe('PENDING')
    for (const index of [1, 2]) {
      const target = confirmed[index]!
      const request = await cancellations.request({ organizationId, customerRef: target.customerRef, bookingId: target.id, idempotencyKey: `cancel-${index}` })
      const result = await cancellations.review(actor, request!.id, { decision: 'APPROVE' })
      expect(result.refund?.amount).toBe(100_000)
      if (index === 2) {
        await refundService.complete(actor, result.refund!.id, {
          transferDate: new Date(Date.now() - 60_000),
          transferReference: `bank-${suffix}`,
        })
      }
    }

    const operations = await dashboard.operations(actor)
    expect(operations.trips).toHaveLength(1)
    expect(operations.trips[0]).toMatchObject({ vehicleId: vehicle.id, vehicleStatus: 'ASSIGNED', seatQuota: 8, reservedSeats: 4, remainingSeats: 4 })
    expect(operations.activeHolds.map((hold) => hold.id).sort()).toEqual([unpaidHold.id, pendingHold.id].sort())
    expect(operations.pendingPaymentReviews.map((payment) => payment.id)).toEqual([pendingPayment.id])
    expect(operations.cancellationCases.map((item) => item.id)).toEqual([pendingCase!.id])
    expect(operations.confirmedBookings.map((booking) => booking.id)).toEqual([confirmed[0]!.id])
    expect(await errorMessage(dashboard.operations({ userId: ownerId, organizationId: otherOrganizationId }))).toContain('Owner access required')

    const moneyflow = await dashboard.moneyflow(actor)
    expect(moneyflow.payments).toMatchObject({ PENDING: 1, APPROVED: 3 })
    expect(moneyflow.invoiceCount).toBe(3)
    expect(moneyflow.invoiceTotals).toEqual([{ currency: 'IDR', count: 3, amount: 300_000 }])
    expect(moneyflow.approvedPaymentTotals).toEqual([{ currency: 'IDR', count: 3, amount: 300_000 }])
    expect(Object.fromEntries(moneyflow.refundTotals.map(({ status, currency, count, amount }) => [
      status,
      { currency, count, amount },
    ]))).toEqual({
      PENDING: { currency: 'IDR', count: 1, amount: 100_000 },
      COMPLETED: { currency: 'IDR', count: 1, amount: 100_000 },
    })
    expect(moneyflow.auditEvents.some((event) => event.actorId === ownerId && event.actorName === 'Owner ops test'
      && event.action === 'vehicle.created' && event.entityType === 'Vehicle' && event.entityId === vehicle.id)).toBe(true)
    expect(await errorMessage(dashboard.moneyflow({ userId: ownerId, organizationId: otherOrganizationId }))).toContain('Owner access required')
  } finally {
    await pool.query(`DELETE FROM "organization" WHERE id = ANY($1::text[])`, [[organizationId, otherOrganizationId]])
    await pool.query(`DELETE FROM "user" WHERE id = $1`, [ownerId])
  }
})
