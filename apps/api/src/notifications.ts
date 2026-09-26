import { pool, type WhatsAppNotification } from '@repo/db'
import { enqueueTask } from './lib/tasks'

export function notifyWhatsApp(input: WhatsAppNotification): void {
  void enqueuePersistedNotification(input).catch((error) => {
    console.error({ task: 'notify.whatsapp', eventKey: input.eventKey, err: error }, 'notification enqueue failed')
  })
}

async function enqueuePersistedNotification(input: WhatsAppNotification): Promise<void> {
  const result = await pool.query<{ customerRef: string; text: string }>(
    `SELECT "customerRef", text FROM "whatsappOutbox"
     WHERE "organizationId" = $1 AND "eventKey" = $2 AND "sentAt" IS NULL`,
    [input.organizationId, input.eventKey],
  )
  const notification = result.rows[0]
  if (notification) await enqueueTask('notify.whatsapp', { ...input, ...notification })
}
