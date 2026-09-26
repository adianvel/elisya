import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { pool } from '@repo/db'
import type { TaskContext } from '../registry'
import { dispatchWhatsAppOutbox } from './notify.whatsapp.outbox'

test.skipIf(process.env.PALAWA_DB_TESTS !== '1')('outbox creates one Hold expiry and 24-hour Owner alert without releasing pending proof seats', async () => {
  const suffix = randomUUID()
  const organizationId = `outbox-test-${suffix}`
  const tripId = `trip-${suffix}`
  const expiredHoldId = `expired-${suffix}`
  const pendingHoldId = `pending-${suffix}`
  const paymentId = `payment-${suffix}`
  const now = new Date()
  const oldOwner = process.env.PALAWA_OWNER_WHATSAPP_NUMBER
  const oldOrganization = process.env.PALAWA_ORGANIZATION_ID
  process.env.PALAWA_OWNER_WHATSAPP_NUMBER = '+6285555555555'
  process.env.PALAWA_ORGANIZATION_ID = organizationId

  try {
    await pool.query(
      `INSERT INTO "organization" (id, name, slug, "createdAt") VALUES ($1, 'Outbox test', $1, $2)`,
      [organizationId, now],
    )
    await pool.query(
      `INSERT INTO "trip" (id, "organizationId", origin, destination, "departureAt", price, "seatQuota", status)
       VALUES ($1, $2, 'A', 'B', $3, 100, 2, 'PUBLISHED')`,
      [tripId, organizationId, new Date(now.getTime() + 86_400_000)],
    )
    await pool.query(
      `INSERT INTO "hold" (id, "organizationId", "tripId", "customerRef", "seatCount", status, "expiresAt", "idempotencyKey")
       VALUES ($1, $2, $3, '+6281111111111', 1, 'ACTIVE', $4, 'expired'),
              ($5, $2, $3, '+6282222222222', 1, 'ACTIVE', $4, 'pending')`,
      [expiredHoldId, organizationId, tripId, new Date(now.getTime() - 60_000), pendingHoldId],
    )
    await pool.query(
      `INSERT INTO "payment" (id, "organizationId", "holdId", "customerRef", "proofKey", status, "idempotencyKey", "submittedAt")
       VALUES ($1, $2, $3, '+6282222222222', 'payment-proof/test', 'PENDING', 'payment', $4)`,
      [paymentId, organizationId, pendingHoldId, new Date(now.getTime() - 25 * 60 * 60_000)],
    )
    await pool.query(
      `INSERT INTO "whatsappOutbox" (id, "organizationId", "eventKey", "customerRef", text, "createdAt")
       SELECT 'backlog-' || $1 || '-' || i, $2, 'backlog:' || $1 || ':' || i, '+6283333333333', 'Backlog message', $3
       FROM generate_series(1, 101) AS i`,
      [suffix, organizationId, now],
    )
    await Bun.sleep(50)

    const queued = new Map<string, unknown>()
    const context: TaskContext = {
      job: {} as never,
      send: async (_id, payload, options) => {
        queued.set(options?.singletonKey ?? 'missing-key', payload)
        return null
      },
    }
    await dispatchWhatsAppOutbox.run({}, context)
    await dispatchWhatsAppOutbox.run({}, context)

    const holds = await pool.query<{ id: string; status: string }>(
      `SELECT id, status FROM "hold" WHERE id = ANY($1::text[]) ORDER BY id`,
      [[expiredHoldId, pendingHoldId]],
    )
    expect(holds.rows).toEqual([
      { id: expiredHoldId, status: 'EXPIRED' },
      { id: pendingHoldId, status: 'ACTIVE' },
    ])
    const outbox = await pool.query<{ eventKey: string }>(
      `SELECT "eventKey" FROM "whatsappOutbox" WHERE "organizationId" = $1 ORDER BY "eventKey"`,
      [organizationId],
    )
    expect(outbox.rows.map((row) => row.eventKey).filter((eventKey) => !eventKey.startsWith('backlog:'))).toEqual([
      `hold:${expiredHoldId}:expired`,
      `payment:${paymentId}:owner-pending-24h`,
    ])
    expect(queued.size).toBe(103)
  } finally {
    await pool.query(`DELETE FROM "organization" WHERE id = $1`, [organizationId])
    if (oldOwner === undefined) delete process.env.PALAWA_OWNER_WHATSAPP_NUMBER
    else process.env.PALAWA_OWNER_WHATSAPP_NUMBER = oldOwner
    if (oldOrganization === undefined) delete process.env.PALAWA_ORGANIZATION_ID
    else process.env.PALAWA_ORGANIZATION_ID = oldOrganization
  }
})
