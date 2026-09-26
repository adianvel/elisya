import { randomUUID } from 'node:crypto'
import { pool, persistWhatsAppNotification, type WhatsAppNotification } from '@repo/db'
import { z } from 'zod'
import { task } from '../registry'

type ExpiredHold = { id: string; organizationId: string; customerRef: string }
type OverduePayment = { id: string; organizationId: string }
async function persistDueNotifications(organizationId: string, now: Date): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const expired = await client.query<ExpiredHold>(
      `UPDATE "hold" h SET status = 'EXPIRED', "updatedAt" = $2
       WHERE h."organizationId" = $1 AND h.status = 'ACTIVE' AND h."expiresAt" <= $2
         AND NOT EXISTS (
           SELECT 1 FROM "payment" p
           WHERE p."organizationId" = h."organizationId" AND p."holdId" = h.id AND p.status = 'PENDING'
         )
         AND NOT EXISTS (
           SELECT 1 FROM "booking" b
           WHERE b."organizationId" = h."organizationId" AND b."holdId" = h.id AND b.status = 'CONFIRMED'
         )
       RETURNING h.id, h."organizationId", h."customerRef"`,
      [organizationId, now],
    )
    for (const hold of expired.rows) {
      await client.query(
        `INSERT INTO "auditEvent" (id, "organizationId", action, "entityType", "entityId", metadata, "createdAt")
         VALUES ($1, $2, 'hold.expired', 'Hold', $3, $4, $5)`,
        [randomUUID(), organizationId, hold.id, JSON.stringify({ customerRef: hold.customerRef }), now],
      )
      await persistWhatsAppNotification(client, {
        organizationId,
        eventKey: `hold:${hold.id}:expired`,
        customerRef: hold.customerRef,
        text: `Your Hold ${hold.id} expired and its seats are available again.`,
      }, now)
    }

    const ownerRef = process.env.PALAWA_OWNER_WHATSAPP_NUMBER
    if (ownerRef) {
      const overdue = await client.query<OverduePayment>(
        `SELECT id, "organizationId" FROM "payment"
         WHERE "organizationId" = $1 AND status = 'PENDING' AND "submittedAt" <= $2`,
        [organizationId, new Date(now.getTime() - 24 * 60 * 60_000)],
      )
      for (const payment of overdue.rows) {
        await persistWhatsAppNotification(client, {
          organizationId,
          eventKey: `payment:${payment.id}:owner-pending-24h`,
          customerRef: ownerRef,
          text: `Payment ${payment.id} has been waiting for review for 24 hours. Please review it in the Owner dashboard; its seats remain reserved until review.`,
        }, now)
      }
    }
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export const dispatchWhatsAppOutbox = task({
  id: 'notify.whatsapp.outbox',
  payload: z.object({}),
  retryLimit: 3,
  retryDelay: 10,
  retryBackoff: true,

  async run(_payload, context) {
    const organizationId = process.env.PALAWA_ORGANIZATION_ID
    if (!organizationId) throw new Error('PALAWA_ORGANIZATION_ID is required')
    await persistDueNotifications(organizationId, new Date())
    // ponytail: scan the single-business pilot's pending outbox; add keyset batches if backlog size grows.
    const pending = await pool.query<WhatsAppNotification>(
      `SELECT "organizationId", "eventKey", "customerRef", text FROM "whatsappOutbox"
       WHERE "organizationId" = $1 AND "sentAt" IS NULL ORDER BY "createdAt" ASC`,
      [organizationId],
    )
    for (const message of pending.rows) {
      await context.send('notify.whatsapp', message, { singletonKey: message.eventKey, singletonSeconds: 600 })
    }
  },
})
