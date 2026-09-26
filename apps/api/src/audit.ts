import { ulid } from 'ulid'

type Queryable = { query(text: string, values?: unknown[]): Promise<unknown> }

export async function writeAuditEvent(
  client: Queryable,
  organizationId: string,
  actorId: string | null,
  action: string,
  entityType: string,
  entityId: string,
  metadata: Record<string, unknown>,
  createdAt: Date,
): Promise<void> {
  await client.query(
    `INSERT INTO "auditEvent" (id, "organizationId", "actorId", action, "entityType", "entityId", metadata, "createdAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [ulid(), organizationId, actorId, action, entityType, entityId, JSON.stringify(metadata), createdAt],
  )
}
