import { zenstack } from '@repo/db'

export type WhatsAppInbound = {
  eventId: string
  messageId: string
  customerRef: string
  text: string
  source: 'whatsapp'
}

export type WhatsAppResponse = {
  eventId: string
  messageId: string
  customerRef: string
  accepted: boolean
  text: string
  assistantRequest?: { customerRef: string; messages: Array<{ role: 'user'; parts: Array<{ type: 'text'; text: string }> }> }
}

const bookingTerms = ['book', 'booking', 'trip', 'travel', 'seat', 'hold', 'pay', 'payment', 'invoice', 'status', 'jadwal', 'kursi', 'pesan', 'bayar', 'tiket', 'halo', 'hello', 'help', 'bantuan']
const blockedTerms = ['sql', 'database', 'drop table', 'system prompt', 'ignore instructions', 'password', 'admin access', 'arbitrary code']

export function guardMessage(text: string): { allowed: true } | { allowed: false; reason: string } {
  const normalized = text.trim().toLowerCase()
  if (!normalized) return { allowed: false, reason: 'Message cannot be empty.' }
  if (normalized.length > 2000) return { allowed: false, reason: 'Message is too long.' }
  if (blockedTerms.some((term) => normalized.includes(term))) return { allowed: false, reason: 'I can only help with Palawa travel bookings.' }
  if (!bookingTerms.some((term) => normalized.includes(term))) return { allowed: false, reason: 'I can only help with Palawa travel bookings.' }
  return { allowed: true }
}

export function mapWhatsAppInbound(input: unknown): WhatsAppInbound {
  if (!input || typeof input !== 'object') throw new Error('Invalid WhatsApp payload')
  const payload = input as Record<string, unknown>
  if (payload.source !== 'whatsapp') throw new Error('Unsupported integration source')
  for (const field of ['eventId', 'messageId', 'customerRef', 'text']) {
    if (typeof payload[field] !== 'string' || !payload[field]) throw new Error(`${field} is required`)
  }
  return {
    eventId: payload.eventId as string,
    messageId: payload.messageId as string,
    customerRef: payload.customerRef as string,
    text: payload.text as string,
    source: 'whatsapp',
  }
}

export async function handleWhatsAppInbound(organizationId: string, input: WhatsAppInbound): Promise<WhatsAppResponse> {
  const existing = await zenstack.integrationEvent.findUnique({ where: { id: input.eventId } })
  if (existing) return JSON.parse(existing.response) as WhatsAppResponse

  const guard = guardMessage(input.text)
  const response: WhatsAppResponse = {
    eventId: input.eventId,
    messageId: input.messageId,
    customerRef: input.customerRef,
    accepted: guard.allowed,
    text: guard.allowed ? 'Message accepted for the Palawa booking assistant.' : guard.reason,
    ...(guard.allowed ? { assistantRequest: { customerRef: input.customerRef, messages: [{ role: 'user' as const, parts: [{ type: 'text' as const, text: input.text }] }] } } : {}),
  }
  try {
    await zenstack.integrationEvent.create({
      data: {
        id: input.eventId,
        organizationId,
        source: input.source,
        messageId: input.messageId,
        customerRef: input.customerRef,
        response: JSON.stringify(response),
      },
    })
  } catch {
    const replay = await zenstack.integrationEvent.findUnique({ where: { id: input.eventId } })
    if (replay) return JSON.parse(replay.response) as WhatsAppResponse
    throw new Error('Could not persist WhatsApp integration event')
  }
  return response
}
