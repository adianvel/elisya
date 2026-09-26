import { z } from 'zod'
import { pool } from '@repo/db'
import { task } from '../registry'

export const notifyWhatsApp = task({
  id: 'notify.whatsapp',
  payload: z.object({
    organizationId: z.string().min(1),
    eventKey: z.string().min(1),
    customerRef: z.string().min(1),
    text: z.string().min(1),
  }),
  retryLimit: 5,
  retryDelay: 10,
  retryBackoff: true,

  async run(payload, context) {
    const url = process.env.N8N_WHATSAPP_OUTBOUND_URL
    if (!url) throw new Error('N8N_WHATSAPP_OUTBOUND_URL is required')
    const secret = process.env.N8N_WEBHOOK_SECRET
    if (!secret) throw new Error('N8N_WEBHOOK_SECRET is required')
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${secret}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) throw new Error(`WhatsApp delivery failed with ${response.status}`)
    await pool.query(
      `UPDATE "whatsappOutbox" SET "sentAt" = $3 WHERE "organizationId" = $1 AND "eventKey" = $2 AND "sentAt" IS NULL`,
      [payload.organizationId, payload.eventKey, new Date()],
    )
  },
})
