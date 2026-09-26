import { zenstack } from '@repo/db'

export type WhatsAppInbound = {
  eventId: string
  messageId: string
  sender: string
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
  assistantRequest?: { sender: string; messages: Array<{ role: 'user'; parts: Array<{ type: 'text'; text: string }> }> }
}

const blockedTerms = ['sql', 'database', 'drop table', 'system prompt', 'ignore instructions', 'password', 'admin access', 'arbitrary code']

export class WhatsAppSenderError extends Error {}

export function guardMessage(text: string): { allowed: true } | { allowed: false; reason: string } {
  const normalized = text.trim().toLowerCase()
  if (!normalized) return { allowed: false, reason: 'Message cannot be empty.' }
  if (normalized.length > 2000) return { allowed: false, reason: 'Message is too long.' }
  if (blockedTerms.some((term) => normalized.includes(term))) return { allowed: false, reason: 'I can only help with Palawa travel bookings.' }
  return { allowed: true }
}

export function normalizeWhatsAppSender(sender: unknown): string {
  if (typeof sender !== 'string') throw new WhatsAppSenderError('private WhatsApp sender is required')
  const match = /^([1-9]\d{7,14})@c\.us$/.exec(sender)
  if (!match) throw new WhatsAppSenderError('private WhatsApp sender must be a phone-number chat')
  return `+${match[1]}`
}

export function isN8nWebhookAuthorized(request: Request, secret = process.env.N8N_WEBHOOK_SECRET): boolean {
  return Boolean(secret) && request.headers.get('authorization') === `Bearer ${secret}`
}

export function mapWhatsAppInbound(input: unknown): WhatsAppInbound {
  if (!input || typeof input !== 'object') throw new Error('Invalid WhatsApp payload')
  const event = input as Record<string, unknown>
  if (event.event !== 'message') throw new Error('Unsupported WhatsApp event')
  if (!event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)) throw new Error('WhatsApp message payload is required')
  const payload = event.payload as Record<string, unknown>
  if (typeof payload.id !== 'string' || !payload.id || payload.id.length > 255) throw new Error('WhatsApp message ID is invalid')
  if (payload.fromMe !== false) throw new Error('only inbound WhatsApp messages can start Customer actions')
  if (typeof payload.from !== 'string') throw new Error('private WhatsApp sender is required')
  if (payload.body !== undefined && typeof payload.body !== 'string') throw new Error('WhatsApp message body must be text')
  const customerRef = normalizeWhatsAppSender(payload.from)
  return {
    eventId: payload.id,
    messageId: payload.id,
    sender: payload.from,
    customerRef,
    text: typeof payload.body === 'string' ? payload.body : '',
    source: 'whatsapp',
  }
}

export async function handleWhatsAppInbound(organizationId: string, input: WhatsAppInbound): Promise<WhatsAppResponse> {
  const existing = await zenstack.integrationEvent.findUnique({ where: { id: input.eventId } })
  if (existing) {
    if (existing.organizationId !== organizationId || existing.source !== input.source || existing.customerRef !== input.customerRef) {
      throw new Error('WhatsApp event ID has already been used')
    }
    return JSON.parse(existing.response) as WhatsAppResponse
  }

  const guard = guardMessage(input.text)
  const response: WhatsAppResponse = {
    eventId: input.eventId,
    messageId: input.messageId,
    customerRef: input.customerRef,
    accepted: guard.allowed,
    text: guard.allowed ? 'Message accepted for the Palawa booking assistant.' : guard.reason,
    ...(guard.allowed ? { assistantRequest: { sender: input.sender, messages: [{ role: 'user' as const, parts: [{ type: 'text' as const, text: input.text }] }] } } : {}),
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
    if (replay && replay.organizationId === organizationId && replay.source === input.source && replay.customerRef === input.customerRef) {
      return JSON.parse(replay.response) as WhatsAppResponse
    }
    throw new Error('Could not persist WhatsApp integration event')
  }
  return response
}
