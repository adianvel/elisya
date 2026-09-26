import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { pool, persistWhatsAppNotification } from '@repo/db'
import { notifyWhatsApp } from './notify.whatsapp'

test.skipIf(process.env.PALAWA_DB_TESTS !== '1')('a successful n8n delivery marks the durable notification intent sent', async () => {
  const organizationId = `sent-test-${randomUUID()}`
  const eventKey = `payment:test:${randomUUID()}`
  const now = new Date()
  const previousUrl = process.env.N8N_WHATSAPP_OUTBOUND_URL
  const previousSecret = process.env.N8N_WEBHOOK_SECRET
  const previousFetch = globalThis.fetch
  process.env.N8N_WHATSAPP_OUTBOUND_URL = 'http://n8n.test/whatsapp'
  process.env.N8N_WEBHOOK_SECRET = 'test-secret'
  let received: { url: string; authorization: string | null; body: unknown } | undefined
  globalThis.fetch = (async (url: Parameters<typeof fetch>[0], options?: Parameters<typeof fetch>[1]) => {
    received = {
      url: String(url),
      authorization: new Headers(options?.headers).get('authorization'),
      body: JSON.parse(String(options?.body)),
    }
    return new Response(null, { status: 200 })
  }) as unknown as typeof fetch

  try {
    await pool.query(
      `INSERT INTO "organization" (id, name, slug, "createdAt") VALUES ($1, 'Sent test', $1, $2)`,
      [organizationId, now],
    )
    await persistWhatsAppNotification(pool, {
      organizationId,
      eventKey,
      customerRef: '+628123456789',
      text: 'Your Payment was approved.',
    }, now)
    await notifyWhatsApp.run({ organizationId, eventKey, customerRef: '+628123456789', text: 'Your Payment was approved.' }, {
      job: { id: 'job-1' } as never,
      send: async () => null,
    })

    const outbox = await pool.query<{ sentAt: Date | null }>(
      `SELECT "sentAt" FROM "whatsappOutbox" WHERE "organizationId" = $1 AND "eventKey" = $2`,
      [organizationId, eventKey],
    )
    expect(received).toEqual({
      url: 'http://n8n.test/whatsapp',
      authorization: 'Bearer test-secret',
      body: { organizationId, eventKey, customerRef: '+628123456789', text: 'Your Payment was approved.' },
    })
    expect(outbox.rows[0]?.sentAt).toBeInstanceOf(Date)
  } finally {
    await pool.query(`DELETE FROM "organization" WHERE id = $1`, [organizationId])
    globalThis.fetch = previousFetch
    if (previousUrl === undefined) delete process.env.N8N_WHATSAPP_OUTBOUND_URL
    else process.env.N8N_WHATSAPP_OUTBOUND_URL = previousUrl
    if (previousSecret === undefined) delete process.env.N8N_WEBHOOK_SECRET
    else process.env.N8N_WEBHOOK_SECRET = previousSecret
  }
})
