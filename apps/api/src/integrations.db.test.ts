import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { pool } from '@repo/db'
import { handleWhatsAppInbound } from './integrations'

test.skipIf(process.env.PALAWA_DB_TESTS !== '1')('a replayed WAHA event returns its first response and keeps its original identity', async () => {
  const suffix = randomUUID()
  const organizationId = `inbound-test-${suffix}`
  const eventId = `waha-event-${suffix}`
  const now = new Date()
  const input = {
    eventId,
    messageId: eventId,
    sender: '628123456789@c.us',
    customerRef: '+628123456789',
    text: 'show trips',
    source: 'whatsapp' as const,
  }

  try {
    await pool.query(
      `INSERT INTO "organization" (id, name, slug, "createdAt") VALUES ($1, 'Inbound test', $1, $2)`,
      [organizationId, now],
    )
    await Bun.sleep(50)
    const first = await handleWhatsAppInbound(organizationId, input)
    const replay = await handleWhatsAppInbound(organizationId, { ...input, text: 'book another trip' })
    let identityRejected = false
    try {
      await handleWhatsAppInbound(organizationId, { ...input, customerRef: '+628999999999' })
    } catch (error) {
      identityRejected = error instanceof Error && error.message.includes('already been used')
    }
    const stored = await pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM "integrationEvent" WHERE id = $1 AND "organizationId" = $2`,
      [eventId, organizationId],
    )

    expect(replay).toEqual(first)
    expect(identityRejected).toBe(true)
    expect(stored.rows[0]?.count).toBe(1)
  } finally {
    await pool.query(`DELETE FROM "organization" WHERE id = $1`, [organizationId])
  }
})
