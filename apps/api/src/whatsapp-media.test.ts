import { describe, expect, it } from 'bun:test'
import { readFile } from 'node:fs/promises'
import {
  createWhatsAppMediaHandler,
  MAX_PAYMENT_PROOF_BYTES,
  mapWhatsAppMediaInbound,
  paymentProofObjectKey,
  MEDIA_CLAIM_LEASE_MS,
  validatePaymentProof,
  type WhatsAppMediaEvent,
  WhatsAppMediaProcessingError,
} from './whatsapp-media'
import type { SubmitPaymentInput } from './payments'

const fixture = async (name: string, type: string) => {
  const bytes = new Uint8Array(await readFile(new URL(`./__fixtures__/${name}`, import.meta.url)))
  return new File([bytes], name, { type })
}
const jpeg = () => fixture('proof.jpg', 'image/jpeg')
const png = () => fixture('proof.png', 'image/png')
const webp = () => fixture('proof.webp', 'image/webp')

function pdf(): File {
  const header = '%PDF-1.7\n'
  const catalog = '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n'
  const pages = '2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\n'
  const firstOffset = header.length
  const secondOffset = firstOffset + catalog.length
  const xrefOffset = secondOffset + pages.length
  const xref = `xref\n0 3\n0000000000 65535 f \n${String(firstOffset).padStart(10, '0')} 00000 n \n${String(secondOffset).padStart(10, '0')} 00000 n \n`
  const trailer = `trailer\n<< /Size 3 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`
  return new File([`${header}${catalog}${pages}${xref}${trailer}`], 'receipt.pdf', { type: 'application/pdf' })
}

describe('WhatsApp Payment proof uploads', () => {
  it('maps WAHA media events to a Customer and Hold without trusting a supplied customerRef', async () => {
    const mapped = mapWhatsAppMediaInbound({
      event: 'message',
      payload: {
        id: 'waha-media-3',
        from: '628123456789@c.us',
        fromMe: false,
        customerRef: '+19999999999',
        hasMedia: true,
        media: { url: 'http://waha/api/files/receipt.jpg', mimetype: 'image/jpeg' },
      },
    }, 'hold-1', await jpeg())

    expect(mapped).toMatchObject({ eventId: 'waha-media-3', sender: '628123456789@c.us', holdId: 'hold-1' })
    expect(() => mapWhatsAppMediaInbound({ event: 'message', payload: { id: 'waha-media-4', from: '628123456789@c.us', fromMe: false, hasMedia: false } }, 'hold-1', new File([], 'empty.jpg', { type: 'image/jpeg' })))
      .toThrow('WAHA event has no media')
    expect(() => mapWhatsAppMediaInbound({ event: 'message', payload: { id: 'waha-media-5', from: '628123456789@c.us', fromMe: false, hasMedia: true, media: { url: null } } }, 'hold-1', new File([], 'empty.jpg', { type: 'image/jpeg' })))
      .toThrow('downloadable media file')
    expect(() => mapWhatsAppMediaInbound({ event: 'message', payload: { id: 'waha-media-6', from: '628123456789@c.us', fromMe: false, hasMedia: true, media: { url: 'http://waha/file.pdf', mimetype: 'application/pdf' } } }, 'hold-1', new File([], 'photo.jpg', { type: 'image/jpeg' })))
      .toThrow('does not match the uploaded file')
  })

  it('accepts supported image and PDF signatures and rejects unsupported or mismatched files', async () => {
    await expect(validatePaymentProof(await jpeg())).resolves.toBeUndefined()
    await expect(validatePaymentProof(await png())).resolves.toBeUndefined()
    await expect(validatePaymentProof(await webp())).resolves.toBeUndefined()
    await expect(validatePaymentProof(pdf())).resolves.toBeUndefined()
    const malformedPng = new Uint8Array(await readFile(new URL('./__fixtures__/proof.png', import.meta.url)))
    malformedPng[12] = 0x58
    await expect(validatePaymentProof(new File([malformedPng], 'malformed.png', { type: 'image/png' }))).rejects.toThrow('file contents do not match')
    const malformedWebp = new Uint8Array(await readFile(new URL('./__fixtures__/proof.webp', import.meta.url)))
    new DataView(malformedWebp.buffer).setUint32(16, 0xffff, true)
    await expect(validatePaymentProof(new File([malformedWebp], 'malformed.webp', { type: 'image/webp' }))).rejects.toThrow('file contents do not match')
    await expect(validatePaymentProof(new File(['not an image'], 'receipt.svg', { type: 'image/svg+xml' }))).rejects.toThrow('file type is not supported')
    await expect(validatePaymentProof(new File(['not a PDF'], 'receipt.pdf', { type: 'application/pdf' }))).rejects.toThrow('file contents do not match')
    await expect(validatePaymentProof(new File([Uint8Array.from([0xff, 0xd8, 0xff, 0x00])], 'truncated.jpg', { type: 'image/jpeg' }))).rejects.toThrow('file contents do not match')
    await expect(validatePaymentProof(new File(['%PDF-1.7'], 'truncated.pdf', { type: 'application/pdf' }))).rejects.toThrow('file contents do not match')
    await expect(validatePaymentProof(new File([new Uint8Array(MAX_PAYMENT_PROOF_BYTES + 1)], 'large.jpg', { type: 'image/jpeg' }))).rejects.toThrow('file is too large')
  })

  it('uses one generated object key and one Payment for replayed media events', async () => {
    const events = new Map<string, WhatsAppMediaEvent>()
    const objects = new Map<string, string>()
    const submitted = new Map<string, { id: string; holdId: string; customerRef: string }>()
    let uploads = 0
    let submissions = 0
    const handler = createWhatsAppMediaHandler({
      findEvent: async (eventId) => events.get(eventId) ?? null,
      claimEvent: async (event) => {
        if (events.has(event.id)) throw new Error('duplicate event')
        events.set(event.id, event)
      },
      reclaimEvent: async (eventId, response, createdBefore, createdAt, nextResponse) => {
        const event = events.get(eventId)
        if (!event || event.response !== response || event.createdAt >= createdBefore) return false
        events.set(eventId, { ...event, createdAt, response: nextResponse })
        return true
      },
      completeEvent: async (eventId, claim, response) => {
        const event = events.get(eventId)
        if (!event || event.response !== claim) return false
        events.set(eventId, { ...event, response })
        return true
      },
      deleteEvent: async (eventId, claim) => {
        if (events.get(eventId)?.response !== claim) return false
        return events.delete(eventId)
      },
      upload: async (key, file) => {
        uploads++
        objects.set(key, await file.text())
      },
      remove: async (key) => { objects.delete(key) },
      submitPayment: async (input: SubmitPaymentInput) => {
        const existing = submitted.get(input.idempotencyKey)
        if (existing) return existing
        const payment = { id: `payment-${input.idempotencyKey}`, holdId: input.holdId, customerRef: input.customerRef }
        submissions++
        submitted.set(input.idempotencyKey, payment)
        return payment
      },
    })
    const input = { eventId: 'waha-media-1', sender: '628123456789@c.us', holdId: 'hold-1', file: await jpeg() }

    const results = await Promise.allSettled([
      handler('org-1', input),
      handler('org-1', input),
    ])
    const replay = await handler('org-1', input)
    const successful = results.find((result) => result.status === 'fulfilled')
    const rejected = results.find((result) => result.status === 'rejected')

    expect(results.filter((result) => result.status === 'fulfilled').length).toBeGreaterThan(0)
    if (rejected?.status === 'rejected') expect(rejected.reason).toBeInstanceOf(WhatsAppMediaProcessingError)
    const first = successful?.status === 'fulfilled' ? successful.value : null
    if (!first) throw new Error('Expected one media request to complete')
    expect(replay).toEqual(first)
    expect(uploads).toBe(1)
    expect(objects.size).toBe(1)
    expect(objects.has(paymentProofObjectKey('org-1', input.eventId))).toBe(true)
    expect(submissions).toBe(1)
    expect(events.size).toBe(1)
    expect(first).toMatchObject({ customerRef: '+628123456789', holdId: 'hold-1', accepted: true })
    expect(paymentProofObjectKey('org-1', input.eventId)).toMatch(/^payment-proofs\/[a-f0-9]{64}$/)
    expect(paymentProofObjectKey('org-1', input.eventId)).not.toContain(input.eventId)
    expect(paymentProofObjectKey('org-2', input.eventId)).not.toBe(paymentProofObjectKey('org-1', input.eventId))
  })

  it('rejects a replay ID reused by another Customer or Hold', async () => {
    const event: WhatsAppMediaEvent = {
      id: 'media:waha-media-1',
      organizationId: 'org-1',
      source: 'whatsapp-media',
      messageId: 'waha-media-1',
      customerRef: '+628123456789',
      response: JSON.stringify({ eventId: 'waha-media-1', customerRef: '+628123456789', holdId: 'hold-1', paymentId: 'payment-1', accepted: true, text: 'received' }),
      createdAt: new Date(),
    }
    const handler = createWhatsAppMediaHandler({
      findEvent: async () => event,
      claimEvent: async () => { throw new Error('must not claim') },
      reclaimEvent: async () => false,
      completeEvent: async () => false,
      deleteEvent: async () => false,
      upload: async () => { throw new Error('must not upload') },
      remove: async () => {},
      submitPayment: async () => { throw new Error('must not submit') },
    })

    await expect(handler('org-1', { eventId: 'waha-media-1', sender: '628123456789@c.us', holdId: 'another-hold', file: await jpeg() }))
      .rejects.toThrow('event ID has already been used')
  })

  it('removes the generated proof object when Payment submission fails', async () => {
    const objects = new Set<string>()
    const handler = createWhatsAppMediaHandler({
      findEvent: async () => null,
      claimEvent: async (event) => { objects.add(event.id) },
      reclaimEvent: async () => false,
      completeEvent: async () => false,
      deleteEvent: async (eventId) => { objects.delete(eventId); return true },
      upload: async (key) => { objects.add(key) },
      remove: async (key) => { objects.delete(key) },
      submitPayment: async () => { throw new Error('Hold is no longer eligible for Payment') },
    })

    await expect(handler('org-1', { eventId: 'waha-media-2', sender: '628123456789@c.us', holdId: 'expired-hold', file: await jpeg() }))
      .rejects.toThrow('Hold is no longer eligible for Payment')
    expect(objects.size).toBe(0)
  })

  it('reclaims a stale claim left by a stopped process', async () => {
    const event: WhatsAppMediaEvent = {
      id: 'media:waha-media-stale',
      organizationId: 'org-1',
      source: 'whatsapp-media',
      messageId: 'waha-media-stale',
      customerRef: '+628123456789',
      response: JSON.stringify({ processing: true, holdId: 'hold-1' }),
      createdAt: new Date(Date.now() - MEDIA_CLAIM_LEASE_MS - 1),
    }
    let reclaims = 0
    const handler = createWhatsAppMediaHandler({
      findEvent: async () => event,
      claimEvent: async () => { throw new Error('stale claim should be reclaimed') },
      reclaimEvent: async (id, response, createdBefore, createdAt, nextResponse) => {
        if (id !== event.id || event.response !== response || event.createdAt >= createdBefore) return false
        event.createdAt = createdAt
        event.response = nextResponse
        reclaims++
        return true
      },
      completeEvent: async (_id, claim, response) => {
        if (event.response !== claim) return false
        event.response = response
        return true
      },
      deleteEvent: async () => false,
      upload: async () => {},
      remove: async () => {},
      submitPayment: async (input) => ({ id: 'payment-recovered', holdId: input.holdId, customerRef: input.customerRef }),
    })

    const recovered = await handler('org-1', { eventId: 'waha-media-stale', sender: '628123456789@c.us', holdId: 'hold-1', file: await jpeg() })
    expect(recovered.paymentId).toBe('payment-recovered')
    expect(reclaims).toBe(1)
  })
})
