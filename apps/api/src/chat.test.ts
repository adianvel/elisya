import { expect, test } from 'bun:test'
import { assistantTools, chat } from './chat'

test('the WhatsApp assistant exposes only the approved domain tools', () => {
  expect(Object.keys(assistantTools('+628123456789', 'org-1', 'event-1')).sort()).toEqual([
    'cancel_hold',
    'create_hold',
    'get_booking_status',
    'get_payment_status',
    'list_available_trips',
    'request_cancellation',
  ])
})

test('the chat adapter rejects unauthenticated caller-supplied Customer identity', async () => {
  const previous = process.env.N8N_WEBHOOK_SECRET
  delete process.env.N8N_WEBHOOK_SECRET
  try {
    const response = await chat.handle(new Request('http://localhost/chat/whatsapp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ eventId: 'event-1', sender: '628123456789@c.us', customerRef: '+19999999999' }),
    }))
    expect(response.status).toBe(401)
  } finally {
    if (previous === undefined) delete process.env.N8N_WEBHOOK_SECRET
    else process.env.N8N_WEBHOOK_SECRET = previous
  }
})
