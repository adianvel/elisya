import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { pool } from '@repo/db'
import { createTripService } from './trips'

test.skipIf(process.env.PALAWA_DB_TESTS !== '1')('Customers see remaining seats after a Hold', async () => {
  const suffix = randomUUID()
  const organizationId = `trip-test-${suffix}`
  const tripId = `trip-${suffix}`
  const now = new Date()
  const service = createTripService()

  try {
    await pool.query(
      `INSERT INTO "organization" (id, name, slug, "createdAt") VALUES ($1, 'Trip test', $1, $2)`,
      [organizationId, now],
    )
    await pool.query(
      `INSERT INTO "trip" (id, "organizationId", origin, destination, "departureAt", price, "seatQuota", status)
       VALUES ($1, $2, 'A', 'B', $3, 100, 3, 'PUBLISHED')`,
      [tripId, organizationId, new Date(now.getTime() + 86_400_000)],
    )
    await pool.query(
      `INSERT INTO "hold" (id, "organizationId", "tripId", "customerRef", "seatCount", "priceAtHold", "currencyAtHold", status, "expiresAt", "idempotencyKey")
       VALUES ($1, $2, $3, 'customer', 2, 100, 'IDR', 'ACTIVE', $4, 'hold')`,
      [`hold-${suffix}`, organizationId, tripId, new Date(now.getTime() + 10 * 60_000)],
    )
    await Bun.sleep(50)

    const available = await service.listAvailable({ organizationId, now })
    expect(available).toMatchObject([{ id: tripId, remainingSeats: 1 }])
  } finally {
    await pool.query(`DELETE FROM "organization" WHERE id = $1`, [organizationId])
  }
})
