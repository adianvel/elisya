import { z } from 'zod'
import { task } from '../registry'

export const notifyWhatsApp = task({
  id: 'notify.whatsapp',
  payload: z.object({
    eventKey: z.string().min(1),
    customerRef: z.string().min(1),
    text: z.string().min(1),
  }),
  retryLimit: 5,
  retryDelay: 10,
  retryBackoff: true,

  async run(payload, context) {
    const url = process.env.N8N_WHATSAPP_OUTBOUND_URL
    if (!url) {
      console.log({ task: 'notify.whatsapp', jobId: context.job.id, eventKey: payload.eventKey, customerRef: payload.customerRef, text: payload.text })
      return
    }
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(process.env.N8N_WEBHOOK_SECRET ? { authorization: `Bearer ${process.env.N8N_WEBHOOK_SECRET}` } : {}),
      },
      body: JSON.stringify(payload),
    })
    if (!response.ok) throw new Error(`WhatsApp delivery failed with ${response.status}`)
  },
})
