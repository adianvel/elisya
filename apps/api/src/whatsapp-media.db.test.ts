import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { pool, zenstack } from '@repo/db'
import { createHoldService } from './holds'
import { createPaymentService } from './payments'
import { createWhatsAppMediaHandler, paymentProofObjectKey, WhatsAppMediaProcessingError } from './whatsapp-media'
import type { WhatsAppMediaEvent } from './whatsapp-media'

async function testJpeg(): Promise<File> {
  const bytes = new Uint8Array(await readFile(new URL('./__fixtures__/proof.jpg', import.meta.url)))
  return new File([bytes], 'proof.jpg', { type: 'image/jpeg' })
}

test.skipIf(process.env.PALAWA_DB_TESTS !== '1')('a replayed WAHA media event creates one Payment and one proof object key', async () => {
  const suffix = randomUUID()
  const organizationId = `media-test-${suffix}`
  const tripId = `trip-${suffix}`
  const eventId = `waha-${suffix}`
  const customerRef = '+628123456789'
  const now = new Date()
  const objects = new Map<string, string>()
  let uploads = 0
  const holds = createHoldService(undefined, () => {})
  const payments = createPaymentService(undefined, () => {})

  try {
    await pool.query(
      `INSERT INTO "organization" (id, name, slug, "createdAt") VALUES ($1, 'Media test', $1, $2)`,
      [organizationId, now],
    )
    await pool.query(
      `INSERT INTO "trip" (id, "organizationId", origin, destination, "departureAt", price, "seatQuota", status)
       VALUES ($1, $2, 'A', 'B', $3, 100, 1, 'PUBLISHED')`,
      [tripId, organizationId, new Date(now.getTime() + 86_400_000)],
    )
    await Bun.sleep(50)
    const hold = await holds.create({ organizationId, tripId, customerRef, seatCount: 1, idempotencyKey: 'media-hold', now })
    await Bun.sleep(50)

    const handle = createWhatsAppMediaHandler({
      findEvent: async (id) => await zenstack.integrationEvent.findUnique({ where: { id } }) as WhatsAppMediaEvent | null,
      claimEvent: async (event) => { await zenstack.integrationEvent.create({ data: event }) },
      reclaimEvent: async (id, response, createdBefore, createdAt, nextResponse) => {
        const result = await zenstack.integrationEvent.updateMany({
          where: { id, source: 'whatsapp-media', response, createdAt: { lt: createdBefore } },
          data: { createdAt, response: nextResponse },
        })
        return result.count > 0
      },
      completeEvent: async (id, claim, response) => {
        const result = await zenstack.integrationEvent.updateMany({ where: { id, source: 'whatsapp-media', response: claim }, data: { response } })
        return result.count > 0
      },
      deleteEvent: async (id, claim) => {
        const result = await zenstack.integrationEvent.deleteMany({ where: { id, source: 'whatsapp-media', response: claim } })
        return result.count > 0
      },
      upload: async (key, file) => { uploads++; objects.set(key, await file.text()) },
      remove: async (key) => { objects.delete(key) },
      submitPayment: (input) => payments.submit(input),
    })
    const input = {
      eventId,
      sender: '628123456789@c.us',
      holdId: hold.id,
      file: await testJpeg(),
    }
    const results = await Promise.allSettled([handle(organizationId, input), handle(organizationId, input)])
    const completed = results.find((result) => result.status === 'fulfilled')
    const duplicate = results.find((result) => result.status === 'rejected')
    expect(results.filter((result) => result.status === 'fulfilled').length).toBeGreaterThan(0)
    if (duplicate?.status === 'rejected') expect(duplicate.reason).toBeInstanceOf(WhatsAppMediaProcessingError)
    const replay = await handle(organizationId, input)
    const paymentCount = await pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM "payment" WHERE "organizationId" = $1 AND "idempotencyKey" = $2`,
      [organizationId, `whatsapp:${eventId}`],
    )
    const eventCount = await pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM "integrationEvent" WHERE "organizationId" = $1 AND id = $2`,
      [organizationId, `media:${eventId}`],
    )

    expect(completed?.status === 'fulfilled' ? completed.value.paymentId : null).toBe(replay.paymentId)
    expect(paymentCount.rows[0]?.count).toBe(1)
    expect(eventCount.rows[0]?.count).toBe(1)
    expect(uploads).toBe(1)
    expect(objects.size).toBe(1)
    expect(objects.has(paymentProofObjectKey(organizationId, eventId))).toBe(true)
  } finally {
    await pool.query(`DELETE FROM "organization" WHERE id = $1`, [organizationId])
  }
})
