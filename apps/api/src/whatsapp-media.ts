import { createHash, randomUUID } from 'node:crypto'
import { zenstack } from '@repo/db'
import * as storage from '@repo/storage'
import { payments, type Payment, type SubmitPaymentInput } from './payments'
import { normalizeWhatsAppSender } from './integrations'

export const MAX_PAYMENT_PROOF_BYTES = 10 * 1024 * 1024
// ponytail: fixed lease; add a heartbeat if uploads can run longer than five minutes.
export const MEDIA_CLAIM_LEASE_MS = 5 * 60 * 1000

export class WhatsAppMediaInputError extends Error {}
export class WhatsAppMediaProcessingError extends Error {}

export type WhatsAppMediaInput = {
  eventId: string
  sender: string
  holdId: string
  file: File
}

export type WhatsAppMediaResponse = {
  eventId: string
  customerRef: string
  holdId: string
  paymentId: string
  accepted: true
  text: string
}

export type WhatsAppMediaEvent = {
  id: string
  organizationId: string
  source: string
  messageId: string
  customerRef: string
  response: string
  createdAt: Date
}

export function mapWhatsAppMediaInbound(input: unknown, holdId: string, file: File): WhatsAppMediaInput {
  if (!holdId) throw new WhatsAppMediaInputError('Hold ID is required for a WhatsApp proof')
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new WhatsAppMediaInputError('WAHA media event is required')
  const event = input as Record<string, unknown>
  if (event.event !== 'message' || !event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)) {
    throw new WhatsAppMediaInputError('Unsupported WAHA media event')
  }
  const payload = event.payload as Record<string, unknown>
  if (typeof payload.id !== 'string' || !payload.id || payload.id.length > 255 || typeof payload.from !== 'string') {
    throw new WhatsAppMediaInputError('WAHA media event has an invalid ID or sender')
  }
  if (payload.fromMe !== false) throw new WhatsAppMediaInputError('only inbound WhatsApp messages can submit proof')
  if (payload.hasMedia !== true || !payload.media || typeof payload.media !== 'object' || Array.isArray(payload.media)) {
    throw new WhatsAppMediaInputError('WAHA event has no media')
  }
  const media = payload.media as Record<string, unknown>
  if (typeof media.url !== 'string' || !media.url) throw new WhatsAppMediaInputError('WAHA did not provide a downloadable media file')
  if (typeof media.mimetype !== 'string' || media.mimetype.toLowerCase() !== file.type.toLowerCase()) {
    throw new WhatsAppMediaInputError('WAHA media type does not match the uploaded file')
  }
  return { eventId: payload.id, sender: payload.from, holdId, file }
}

type MediaDependencies = {
  findEvent(eventId: string): Promise<WhatsAppMediaEvent | null>
  claimEvent(event: WhatsAppMediaEvent): Promise<void>
  reclaimEvent(eventId: string, response: string, createdBefore: Date, createdAt: Date, nextResponse: string): Promise<boolean>
  completeEvent(eventId: string, claim: string, response: string): Promise<boolean>
  deleteEvent(eventId: string, claim: string): Promise<boolean>
  upload(key: string, file: File): Promise<void>
  remove(key: string): Promise<void>
  submitPayment(input: SubmitPaymentInput): Promise<Pick<Payment, 'id' | 'holdId' | 'customerRef'>>
}

export function paymentProofObjectKey(organizationId: string, eventId: string): string {
  const digest = createHash('sha256').update(`${organizationId}\0${eventId}`).digest('hex')
  return `payment-proofs/${digest}`
}

function mediaEventKey(eventId: string): string {
  return `media:${eventId}`
}

// ponytail: validate container structure without decoding pixels; add a decoder/AV scan if uploaded proofs become hostile.
export async function validatePaymentProof(file: File): Promise<void> {
  if (!file.size || file.size > MAX_PAYMENT_PROOF_BYTES) throw new WhatsAppMediaInputError('Payment proof file is too large or empty')
  const type = file.type.toLowerCase()
  if (!['image/jpeg', 'image/png', 'image/webp', 'application/pdf'].includes(type)) {
    throw new WhatsAppMediaInputError('Payment proof file type is not supported')
  }
  const valid = type === 'image/jpeg' ? isJpeg(await file.arrayBuffer())
    : type === 'image/png' ? isPng(await file.arrayBuffer())
      : type === 'image/webp' ? isWebp(await file.arrayBuffer())
        : await isPdf(file)
  if (!valid) throw new WhatsAppMediaInputError('Payment proof file contents do not match its type')
}

function isJpeg(buffer: ArrayBuffer): boolean {
  const bytes = new Uint8Array(buffer)
  if (bytes.length < 20 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) return false
  let hasFrame = false
  let hasScan = false
  let offset = 2

  while (offset < bytes.length - 2) {
    if (bytes[offset] !== 0xff) return false
    while (bytes[offset] === 0xff) offset++
    const marker = bytes[offset++]
    if (marker === 0xd9) return hasFrame && hasScan && offset === bytes.length
    if (marker === 0x00) return false
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    if (offset + 2 > bytes.length) return false
    const segmentLength = (bytes[offset] << 8) | bytes[offset + 1]
    if (segmentLength < 2 || offset + segmentLength > bytes.length) return false
    if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
      hasFrame = true
    }
    offset += segmentLength
    if (marker !== 0xda) continue
    hasScan = true
    while (offset < bytes.length - 1) {
      if (bytes[offset] === 0xff) {
        const next = bytes[offset + 1]
        if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) { offset += 2; continue }
        if (next === 0xd9) return hasFrame && offset + 2 === bytes.length
        break
      }
      offset++
    }
  }
  return false
}

function isPng(buffer: ArrayBuffer): boolean {
  const bytes = new Uint8Array(buffer)
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (bytes.length < 8 || signature.some((byte, index) => bytes[index] !== byte)) return false
  let offset = 8
  let hasHeader = false
  let hasData = false
  while (offset + 12 <= bytes.length) {
    const length = new DataView(buffer, offset, 4).getUint32(0)
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8))
    const end = offset + 12 + length
    if (end > bytes.length) return false
    if (!hasHeader && (type !== 'IHDR' || length !== 13)) return false
    if (type === 'IHDR') hasHeader = true
    if (type === 'IDAT' && length > 0) hasData = true
    if (type === 'IEND') return length === 0 && hasHeader && hasData && end === bytes.length
    offset = end
  }
  return false
}

function isWebp(buffer: ArrayBuffer): boolean {
  const bytes = new Uint8Array(buffer)
  if (bytes.length < 30 || String.fromCharCode(...bytes.subarray(0, 4)) !== 'RIFF' || String.fromCharCode(...bytes.subarray(8, 12)) !== 'WEBP') return false
  if (new DataView(buffer, 4, 4).getUint32(0, true) !== bytes.length - 8) return false
  let offset = 12
  let hasImage = false
  while (offset + 8 <= bytes.length) {
    const type = String.fromCharCode(...bytes.subarray(offset, offset + 4))
    const length = new DataView(buffer, offset + 4, 4).getUint32(0, true)
    const end = offset + 8 + length + (length % 2)
    if (end > bytes.length) return false
    if ((type === 'VP8 ' || type === 'VP8L') && length > 0) hasImage = true
    offset = end
  }
  return hasImage && offset === bytes.length
}

async function isPdf(file: File): Promise<boolean> {
  if (file.size < 100 || !(await file.slice(0, 5).text()).startsWith('%PDF-')) return false
  const text = await file.text()
  const tail = text.slice(-1024)
  const eof = tail.lastIndexOf('%%EOF')
  const startXref = tail.lastIndexOf('startxref', eof)
  if (eof < 0 || startXref < 0 || !(text.includes('\nxref') || text.includes('/Type /XRef'))) return false
  return /^\s*\d+\s*$/.test(tail.slice(startXref + 'startxref'.length, eof))
}

const defaultDependencies: MediaDependencies = {
  async findEvent(eventId) {
    return await zenstack.integrationEvent.findUnique({ where: { id: eventId } }) as WhatsAppMediaEvent | null
  },
  async claimEvent(event) {
    await zenstack.integrationEvent.create({ data: event })
  },
  async reclaimEvent(eventId, response, createdBefore, createdAt, nextResponse) {
    const result = await zenstack.integrationEvent.updateMany({
      where: { id: eventId, source: 'whatsapp-media', response, createdAt: { lt: createdBefore } },
      data: { createdAt, response: nextResponse },
    })
    return result.count > 0
  },
  async completeEvent(eventId, claim, response) {
    const result = await zenstack.integrationEvent.updateMany({
      where: { id: eventId, source: 'whatsapp-media', response: claim },
      data: { response },
    })
    return result.count > 0
  },
  async deleteEvent(eventId, claim) {
    const result = await zenstack.integrationEvent.deleteMany({ where: { id: eventId, source: 'whatsapp-media', response: claim } })
    return result.count > 0
  },
  async upload(key, file) {
    await storage.upload({ scope: 'payment-proofs', key, file })
  },
  async remove(key) {
    await storage.removeObject(key)
  },
  submitPayment: (input) => payments.submit(input),
}

export function createWhatsAppMediaHandler(dependencies: MediaDependencies = defaultDependencies) {
  return async function handle(organizationId: string, input: WhatsAppMediaInput): Promise<WhatsAppMediaResponse> {
    if (!organizationId || !input.eventId || input.eventId.length > 255 || !input.holdId || !input.file) {
      throw new WhatsAppMediaInputError('organizationId, eventId, holdId, and file are required')
    }
    const customerRef = normalizeWhatsAppSender(input.sender)
    const eventId = mediaEventKey(input.eventId)
    const existing = await dependencies.findEvent(eventId)
    if (existing) {
      assertEventMatches(existing, organizationId, customerRef, input.holdId)
      if (!isProcessingEvent(existing)) return replay(existing, organizationId, customerRef, input.holdId)
    }

    await validatePaymentProof(input.file)
    const proofKey = paymentProofObjectKey(organizationId, input.eventId)
    const claimedAt = new Date()
    const claimResponse = JSON.stringify({ processing: true, holdId: input.holdId, claimToken: randomUUID() })
    const claim: WhatsAppMediaEvent = {
      id: eventId,
      organizationId,
      source: 'whatsapp-media',
      messageId: input.eventId,
      customerRef,
      response: claimResponse,
      createdAt: claimedAt,
    }
    if (existing) {
      const createdBefore = new Date(claimedAt.getTime() - MEDIA_CLAIM_LEASE_MS)
      if (existing.createdAt > createdBefore || !await dependencies.reclaimEvent(eventId, existing.response, createdBefore, claimedAt, claimResponse)) {
        const replayed = await dependencies.findEvent(eventId)
        if (replayed) return replay(replayed, organizationId, customerRef, input.holdId)
        throw new WhatsAppMediaProcessingError('WhatsApp media event is already being processed')
      }
    } else {
      try {
        await dependencies.claimEvent(claim)
      } catch (error) {
        const replayed = await dependencies.findEvent(eventId)
        if (replayed) return replay(replayed, organizationId, customerRef, input.holdId)
        throw error
      }
    }

    let paymentSubmitted = false
    try {
      await dependencies.upload(proofKey, input.file)
      const payment = await dependencies.submitPayment({
        organizationId,
        holdId: input.holdId,
        customerRef,
        proofKey,
        idempotencyKey: `whatsapp:${input.eventId}`,
      }).catch((error: unknown) => {
        if (error instanceof Error && ['Hold not found', 'Hold does not belong to Customer', 'Hold is no longer eligible for Payment'].includes(error.message)) {
          throw new WhatsAppMediaInputError(error.message)
        }
        throw error
      })
      paymentSubmitted = true

      const response: WhatsAppMediaResponse = {
        eventId: input.eventId,
        customerRef,
        holdId: payment.holdId,
        paymentId: payment.id,
        accepted: true,
        text: `Payment proof received for Hold ${payment.holdId}.`,
      }
      if (!await dependencies.completeEvent(eventId, claimResponse, JSON.stringify(response))) {
        throw new WhatsAppMediaProcessingError('WhatsApp media event claim was taken over')
      }
      return response
    } catch (error) {
      const releasedClaim = await dependencies.deleteEvent(eventId, claimResponse).catch(() => false)
      if (!paymentSubmitted && releasedClaim) await dependencies.remove(proofKey).catch(() => {})
      throw error
    }
  }
}

function replay(event: WhatsAppMediaEvent, organizationId: string, customerRef: string, holdId: string): WhatsAppMediaResponse {
  assertEventMatches(event, organizationId, customerRef, holdId)
  const response = JSON.parse(event.response) as WhatsAppMediaResponse & { processing?: boolean }
  if (response.processing) throw new WhatsAppMediaProcessingError('WhatsApp media event is already being processed')
  return response
}

function assertEventMatches(event: WhatsAppMediaEvent, organizationId: string, customerRef: string, holdId: string): void {
  if (event.organizationId !== organizationId || event.source !== 'whatsapp-media' || event.customerRef !== customerRef) {
    throw new WhatsAppMediaInputError('WhatsApp media event ID has already been used')
  }
  try {
    const response = JSON.parse(event.response) as { holdId?: string }
    if (response.holdId !== holdId) throw new WhatsAppMediaInputError('WhatsApp media event ID has already been used')
  } catch (error) {
    if (error instanceof WhatsAppMediaInputError) throw error
    throw new WhatsAppMediaInputError('WhatsApp media event record is invalid')
  }
}

function isProcessingEvent(event: WhatsAppMediaEvent): boolean {
  try {
    return (JSON.parse(event.response) as { processing?: boolean }).processing === true
  } catch {
    return false
  }
}

export const handleWhatsAppMedia = createWhatsAppMediaHandler()
