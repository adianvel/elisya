import { describe, expect, it } from 'bun:test'
import { notifyWhatsApp } from './notify.whatsapp'

const context = { job: { id: 'job-1' } as never, send: async () => null }

describe('WhatsApp notification task', () => {
  it('keeps notification delivery pending when no outbound n8n URL is configured', async () => {
    const previous = process.env.N8N_WHATSAPP_OUTBOUND_URL
    delete process.env.N8N_WHATSAPP_OUTBOUND_URL
    try {
      await expect(notifyWhatsApp.run({ organizationId: 'org-1', eventKey: 'event-1', customerRef: '+6281', text: 'done' }, context))
        .rejects.toThrow('N8N_WHATSAPP_OUTBOUND_URL is required')
    } finally {
      if (previous) process.env.N8N_WHATSAPP_OUTBOUND_URL = previous
      else delete process.env.N8N_WHATSAPP_OUTBOUND_URL
    }
  })

  it('requires authentication before calling the n8n outbound webhook', async () => {
    const previousUrl = process.env.N8N_WHATSAPP_OUTBOUND_URL
    const previousSecret = process.env.N8N_WEBHOOK_SECRET
    const previousFetch = globalThis.fetch
    process.env.N8N_WHATSAPP_OUTBOUND_URL = 'http://n8n.test/whatsapp'
    delete process.env.N8N_WEBHOOK_SECRET
    globalThis.fetch = (async () => {
      throw new Error('fetch should not run without the webhook secret')
    }) as unknown as typeof fetch
    try {
      await expect(notifyWhatsApp.run({ organizationId: 'org-1', eventKey: 'event-1', customerRef: '+6281', text: 'done' }, context))
        .rejects.toThrow('N8N_WEBHOOK_SECRET is required')
    } finally {
      globalThis.fetch = previousFetch
      if (previousUrl === undefined) delete process.env.N8N_WHATSAPP_OUTBOUND_URL
      else process.env.N8N_WHATSAPP_OUTBOUND_URL = previousUrl
      if (previousSecret === undefined) delete process.env.N8N_WEBHOOK_SECRET
      else process.env.N8N_WEBHOOK_SECRET = previousSecret
    }
  })

  it('throws delivery failures so pg-boss can retry them', async () => {
    const previousUrl = process.env.N8N_WHATSAPP_OUTBOUND_URL
    const previousSecret = process.env.N8N_WEBHOOK_SECRET
    const previousFetch = globalThis.fetch
    process.env.N8N_WHATSAPP_OUTBOUND_URL = 'http://n8n.test/whatsapp'
    process.env.N8N_WEBHOOK_SECRET = 'test-secret'
    globalThis.fetch = (async () => new Response(null, { status: 503 })) as unknown as typeof fetch
    try {
      await expect(notifyWhatsApp.run({ organizationId: 'org-1', eventKey: 'event-2', customerRef: '+6281', text: 'done' }, context)).rejects.toThrow('WhatsApp delivery failed with 503')
    } finally {
      globalThis.fetch = previousFetch
      if (previousUrl) process.env.N8N_WHATSAPP_OUTBOUND_URL = previousUrl
      else delete process.env.N8N_WHATSAPP_OUTBOUND_URL
      if (previousSecret) process.env.N8N_WEBHOOK_SECRET = previousSecret
      else delete process.env.N8N_WEBHOOK_SECRET
    }
  })
})
