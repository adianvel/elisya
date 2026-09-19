import { describe, expect, it } from 'bun:test'
import { notifyWhatsApp } from './notify.whatsapp'

const context = { job: { id: 'job-1' } as never, send: async () => null }

describe('WhatsApp notification task', () => {
  it('succeeds locally when no outbound n8n URL is configured', async () => {
    const previous = process.env.N8N_WHATSAPP_OUTBOUND_URL
    delete process.env.N8N_WHATSAPP_OUTBOUND_URL
    await notifyWhatsApp.run({ eventKey: 'event-1', customerRef: '+6281', text: 'done' }, context)
    if (previous) process.env.N8N_WHATSAPP_OUTBOUND_URL = previous
  })

  it('throws delivery failures so pg-boss can retry them', async () => {
    const previousUrl = process.env.N8N_WHATSAPP_OUTBOUND_URL
    const previousFetch = globalThis.fetch
    process.env.N8N_WHATSAPP_OUTBOUND_URL = 'http://n8n.test/whatsapp'
    globalThis.fetch = (async () => new Response(null, { status: 503 })) as unknown as typeof fetch
    await expect(notifyWhatsApp.run({ eventKey: 'event-2', customerRef: '+6281', text: 'done' }, context)).rejects.toThrow('WhatsApp delivery failed with 503')
    globalThis.fetch = previousFetch
    if (previousUrl) process.env.N8N_WHATSAPP_OUTBOUND_URL = previousUrl
    else delete process.env.N8N_WHATSAPP_OUTBOUND_URL
  })
})
