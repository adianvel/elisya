import { Elysia, t } from 'elysia'
import { streamText, convertToModelMessages, tool, zodSchema, isStepCount, createUIMessageStreamResponse, toUIMessageStream } from 'ai'
import { gateway } from '@ai-sdk/gateway'
import { z } from 'zod'
import { logger } from '@repo/logger'
import { configuredOrganizationId, trips } from './trips'
import { holds } from './holds'
import { bookings } from './bookings'
import { guardMessage, isN8nWebhookAuthorized, normalizeWhatsAppSender, WhatsAppSenderError } from './integrations'

function userQuestion(messages: any[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role !== 'user') continue
    const text = (messages[i].parts ?? [])
      .filter((part: any) => part.type === 'text')
      .map((part: any) => part.text)
      .join(' ')
    if (text) return text
  }
}

const SYSTEM_PROMPT = [
  'You are a booking assistant for Palawa.',
  'Use only the available domain tools to help Customers discover Trips, create and cancel Holds, and check Booking status.',
  'When a Customer has transferred money, ask them to send the receipt image or PDF in this WhatsApp conversation.',
  'Never invent Trip availability, prices, or seat quotas.',
  'Answer in the same language as the user, in plain, non-technical language for business users.',
  'If no Trips are available, say so simply.',
].join('\n')

export const chat = new Elysia({ prefix: '/chat' }).post(
  '/message',
  async ({ request, body, status }) => {
    if (!isN8nWebhookAuthorized(request)) return status(401)
    let customerRef: string
    try {
      customerRef = normalizeWhatsAppSender(body.sender)
    } catch (error) {
      if (error instanceof WhatsAppSenderError) return status(400, error.message)
      throw error
    }
    const start = performance.now()
    const question = userQuestion(body.messages)
    const guard = guardMessage(question ?? '')
    if (!guard.allowed) return status(400, guard.reason)
    logger.ai.info({ question, messages: body.messages.length }, 'chat request')

    const result = streamText({
      model: gateway('xiaomi/mimo-v2.5'),
      system: SYSTEM_PROMPT,
      messages: await convertToModelMessages(body.messages),
      stopWhen: isStepCount(5),
      tools: {
        list_available_trips: tool<Record<string, never>, any, any>({
          description: 'List future published Trips for a Travel business.',
          inputSchema: zodSchema(z.object({})),
          execute: () => {
            return trips.listAvailable({ organizationId: configuredOrganizationId() })
          },
        }),
        create_hold: tool<{ tripId: string; seatCount: number; idempotencyKey: string }, any, any>({
          description: 'Reserve seats on an available Trip for a Customer for 15 minutes.',
          inputSchema: zodSchema(z.object({
            tripId: z.string().min(1),
            seatCount: z.number().int().positive(),
            idempotencyKey: z.string().min(1),
          })),
          execute: (input) => holds.create({
            organizationId: configuredOrganizationId(),
            ...input,
            customerRef,
          }),
        }),
        cancel_hold: tool<{ holdId: string }, any, any>({
          description: 'Cancel an unpaid Hold and release its seats.',
          inputSchema: zodSchema(z.object({ holdId: z.string().min(1) })),
          execute: (input) => holds.cancel(configuredOrganizationId(), input.holdId, customerRef),
        }),
        get_booking_status: tool<{ bookingId: string }, any, any>({
          description: 'Retrieve a Customer Booking and Invoice status.',
          inputSchema: zodSchema(z.object({
            bookingId: z.string().min(1),
          })),
          execute: (input) => bookings.getForCustomer(configuredOrganizationId(), customerRef, input.bookingId),
        }),
      },
      onFinish: ({ usage, steps }) => {
        logger.ai.info({
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          totalTokens: usage.totalTokens,
          steps: steps.length,
          durationMs: Math.round(performance.now() - start),
        }, 'chat completed')
      },
      onError: ({ error }) => {
        logger.ai.error({ err: error, durationMs: Math.round(performance.now() - start) }, 'chat failed')
      },
    })

    return createUIMessageStreamResponse({
      stream: toUIMessageStream({ stream: result.stream }),
    });
  },
  {
    body: t.Object(
      {
        messages: t.Array(t.Any()),
        id: t.Optional(t.String()),
        sender: t.String({ minLength: 1, maxLength: 255 }),
      },
      { additionalProperties: true },
    ),
  },
)
