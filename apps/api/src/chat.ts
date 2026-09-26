import { Elysia, t } from 'elysia'
import { convertToModelMessages, generateText, isStepCount, tool, zodSchema } from 'ai'
import { gateway } from '@ai-sdk/gateway'
import { z } from 'zod'
import { logger } from '@repo/logger'
import { persistWhatsAppNotification, pool, type WhatsAppNotification } from '@repo/db'
import { configuredOrganizationId, trips } from './trips'
import { holds } from './holds'
import { bookings } from './bookings'
import { payments } from './payments'
import { notifyWhatsApp } from './notifications'
import { guardMessage, isN8nWebhookAuthorized, normalizeWhatsAppSender, WhatsAppSenderError } from './integrations'

const SYSTEM_PROMPT = [
  'You are a booking assistant for Palawa.',
  'Use only the available domain tools to help Customers discover Trips, create and cancel Holds, and check Payment and Booking status.',
  'When you create a Hold, state the seat count, total due from the Hold price snapshot, currency, and expiry. Give the Hold ID and ask the Customer to include it in the caption of any transfer receipt image or PDF.',
  'Create at most one Hold per inbound message; ask the Customer to send another message for a separate reservation.',
  'For a status request without an ID, check the latest Payment and Booking for the current sender. Never expose another Customer’s information.',
  'Never invent Trip availability, prices, seat quotas, or bank transfer details.',
  'Answer in the same language as the user, in plain, non-technical language for business users.',
  'For unrelated questions, politely explain that you can only help with Palawa travel bookings.',
  'If no Trips are available, say so simply.',
].join('\n')

type StoredResponse = {
  accepted: boolean
  text: string
  assistantRequest?: { messages: Array<{ role: 'user'; parts: Array<{ type: 'text'; text: string }> }> }
  assistantReply?: string
}

export function assistantTools(customerRef: string, organizationId: string, eventId: string) {
  return {
    list_available_trips: tool<Record<string, never>, any, any>({
      description: 'List future published Trips for a Travel business.',
      inputSchema: zodSchema(z.object({})),
      execute: () => trips.listAvailable({ organizationId }),
    }),
    create_hold: tool<{ tripId: string; seatCount: number }, any, any>({
      description: 'Reserve seats on an available Trip for a Customer for 15 minutes. Create only one Hold per inbound message.',
      inputSchema: zodSchema(z.object({ tripId: z.string().min(1), seatCount: z.number().int().positive() })),
      execute: (input) => holds.create({
        organizationId,
        ...input,
        customerRef,
        idempotencyKey: `whatsapp:${eventId}:hold`,
      }),
    }),
    cancel_hold: tool<{ holdId: string }, any, any>({
      description: 'Cancel an unpaid Hold and release its seats.',
      inputSchema: zodSchema(z.object({ holdId: z.string().min(1) })),
      execute: (input) => holds.cancel(organizationId, input.holdId, customerRef),
    }),
    get_booking_status: tool<{ bookingId?: string }, any, any>({
      description: 'Retrieve the latest Booking for this Customer, or a specific Booking when its ID is given.',
      inputSchema: zodSchema(z.object({ bookingId: z.string().min(1).optional() })),
      execute: (input) => bookings.getForCustomer(organizationId, customerRef, input.bookingId),
    }),
    get_payment_status: tool<{ paymentId?: string }, any, any>({
      description: 'Retrieve the latest Payment for this Customer, or a specific Payment when its ID is given.',
      inputSchema: zodSchema(z.object({ paymentId: z.string().min(1).optional() })),
      execute: (input) => payments.getForCustomer(organizationId, customerRef, input.paymentId),
    }),
  }
}

async function conversationMessages(organizationId: string, customerRef: string) {
  const result = await pool.query<{ response: string }>(
    `SELECT response FROM "integrationEvent"
     WHERE "organizationId" = $1 AND "customerRef" = $2 AND source = 'whatsapp'
     ORDER BY "createdAt" DESC LIMIT 20`,
    [organizationId, customerRef],
  )
  const messages: Array<{ role: string; parts: Array<{ type: 'text'; text: string }> }> = []
  for (const row of result.rows.reverse()) {
    const response = JSON.parse(row.response) as StoredResponse
    if (!response.accepted) continue
    messages.push(...(response.assistantRequest?.messages ?? []))
    if (response.assistantReply) messages.push({ role: 'assistant', parts: [{ type: 'text', text: response.assistantReply }] })
  }
  return messages
}

export async function saveAssistantReply(
  organizationId: string,
  eventId: string,
  customerRef: string,
  text: string,
  notify: (input: WhatsAppNotification) => void = notifyWhatsApp,
): Promise<{ accepted: boolean; text: string }> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const current = await client.query<{ response: string; customerRef: string; source: string }>(
      `SELECT response, "customerRef", source FROM "integrationEvent"
       WHERE id = $1 AND "organizationId" = $2 FOR UPDATE`,
      [eventId, organizationId],
    )
    if (!current.rows[0] || current.rows[0].source !== 'whatsapp' || current.rows[0].customerRef !== customerRef) {
      throw new Error('WhatsApp event not found for Customer')
    }
    const response = JSON.parse(current.rows[0].response) as StoredResponse
    if (response.assistantReply) {
      await client.query('COMMIT')
      return { accepted: response.accepted, text: response.assistantReply }
    }
    await client.query(
      `UPDATE "integrationEvent" SET response = $3 WHERE id = $1 AND "organizationId" = $2`,
      [eventId, organizationId, JSON.stringify({ ...response, assistantReply: text })],
    )
    await persistWhatsAppNotification(client, {
      organizationId,
      eventKey: `assistant:${eventId}`,
      customerRef,
      text,
    })
    await client.query('COMMIT')
    notify({ organizationId, eventKey: `assistant:${eventId}`, customerRef, text })
    return { accepted: response.accepted, text }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export const chat = new Elysia({ prefix: '/chat' }).post(
  '/whatsapp',
  async ({ request, body, status }) => {
    if (!isN8nWebhookAuthorized(request)) return status(401)
    let customerRef: string
    try {
      customerRef = normalizeWhatsAppSender(body.sender)
    } catch (error) {
      if (error instanceof WhatsAppSenderError) return status(400, error.message)
      throw error
    }
    const organizationId = configuredOrganizationId()
    const event = await pool.query<{ response: string }>(
      `SELECT response FROM "integrationEvent"
       WHERE id = $1 AND "organizationId" = $2 AND "customerRef" = $3 AND source = 'whatsapp'`,
      [body.eventId, organizationId, customerRef],
    )
    if (!event.rows[0]) return status(404)
    const inbound = JSON.parse(event.rows[0].response) as StoredResponse
    if (inbound.assistantReply) return { accepted: inbound.accepted, text: inbound.assistantReply }
    if (!inbound.accepted) return saveAssistantReply(organizationId, body.eventId, customerRef, inbound.text)

    const startedAt = performance.now()
    const messages = await conversationMessages(organizationId, customerRef)
    const result = await generateText({
      model: gateway('xiaomi/mimo-v2.5'),
      system: SYSTEM_PROMPT,
      messages: await convertToModelMessages(messages as any[]),
      stopWhen: isStepCount(5),
      tools: assistantTools(customerRef, organizationId, body.eventId),
    })
    logger.ai.info({ totalTokens: result.usage.totalTokens, durationMs: Math.round(performance.now() - startedAt) }, 'WhatsApp assistant completed')
    return saveAssistantReply(organizationId, body.eventId, customerRef, result.text)
  },
  {
    body: t.Object({ eventId: t.String({ minLength: 1, maxLength: 255 }), sender: t.String({ minLength: 1, maxLength: 255 }) }),
  },
)
