import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { pool } from '@repo/db'
import { saveAssistantReply } from './chat'

test.skipIf(process.env.PALAWA_DB_TESTS !== '1')('assistant replies and their outbox intent are idempotent', async () => {
  const suffix = randomUUID()
  const organizationId = `chat-test-${suffix}`
  const eventId = `message-${suffix}`
  const customerRef = '+628123456789'
  const now = new Date()

  try {
    await pool.query(
      `INSERT INTO "organization" (id, name, slug, "createdAt") VALUES ($1, 'Chat test', $1, $2)`,
      [organizationId, now],
    )
    await pool.query(
      `INSERT INTO "integrationEvent" (id, "organizationId", source, "messageId", "customerRef", response, "createdAt")
       VALUES ($1, $2, 'whatsapp', $1, $3, $4, $5)`,
      [eventId, organizationId, customerRef, JSON.stringify({ accepted: true, text: 'Message accepted.' }), now],
    )
    await Bun.sleep(50)

    const first = await saveAssistantReply(organizationId, eventId, customerRef, 'Your Hold is active.', () => {})
    const retry = await saveAssistantReply(organizationId, eventId, customerRef, 'A duplicate response.', () => {})
    const event = await pool.query<{ response: string }>(`SELECT response FROM "integrationEvent" WHERE id = $1`, [eventId])
    const outbox = await pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM "whatsappOutbox" WHERE "organizationId" = $1 AND "eventKey" = $2`,
      [organizationId, `assistant:${eventId}`],
    )

    expect(first).toEqual({ accepted: true, text: 'Your Hold is active.' })
    expect(retry).toEqual(first)
    expect(JSON.parse(event.rows[0]!.response).assistantReply).toBe(first.text)
    expect(outbox.rows[0]?.count).toBe(1)
  } finally {
    await pool.query(`DELETE FROM "organization" WHERE id = $1`, [organizationId])
  }
})
