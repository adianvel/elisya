import { randomUUID } from 'node:crypto'

export type WhatsAppNotification = {
  organizationId: string
  eventKey: string
  customerRef: string
  text: string
}

type Queryable = { query(text: string, values?: unknown[]): Promise<unknown> }

export async function persistWhatsAppNotification(
  client: Queryable,
  input: WhatsAppNotification,
  now = new Date(),
): Promise<void> {
  await client.query(
    `INSERT INTO "whatsappOutbox" (id, "organizationId", "eventKey", "customerRef", text, "createdAt")
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT ("organizationId", "eventKey") DO NOTHING`,
    [randomUUID(), input.organizationId, input.eventKey, input.customerRef, input.text, now],
  )
}
