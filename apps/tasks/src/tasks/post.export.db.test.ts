import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { getOwnerAuthorization, pool } from '@repo/db'
import type { TaskContext } from '../registry'
import { postExport } from './post.export'

test.skipIf(process.env.PALAWA_DB_TESTS !== '1')('Post export rejects unverified Owners and cross-business jobs', async () => {
  const suffix = randomUUID()
  const organizationA = `export-a-${suffix}`
  const organizationB = `export-b-${suffix}`
  const ownerId = `export-owner-${suffix}`
  const now = new Date()
  const notifications: Array<{ title: string; body: string }> = []
  const context = {
    job: { id: `job-${suffix}` },
    send: async (_id: string, payload: { title: string; body: string }) => {
      notifications.push(payload)
      return null
    },
  } as unknown as TaskContext

  try {
    await pool.query(
      `INSERT INTO "organization" (id, name, slug, "createdAt") VALUES
       ($1, 'Export business A', $1, $3), ($2, 'Export business B', $2, $3)`,
      [organizationA, organizationB, now],
    )
    await pool.query(
      `INSERT INTO "user" (id, name, email, "twoFactorEnabled") VALUES ($1, 'Export owner', $2, true)`,
      [ownerId, `${ownerId}@example.test`],
    )
    await pool.query(
      `INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt") VALUES ($1, $2, $3, 'owner', $4)`,
      [`member-${suffix}`, organizationB, ownerId, now],
    )

    expect(await getOwnerAuthorization(ownerId, organizationA)).toBe('not-owner')
    await postExport.run({ userId: ownerId, organizationId: organizationA }, context)
    await pool.query(`UPDATE "user" SET "twoFactorEnabled" = false WHERE id = $1`, [ownerId])
    expect(await getOwnerAuthorization(ownerId, organizationB)).toBe('two-factor-required')
    await postExport.run({ userId: ownerId, organizationId: organizationB }, context)

    expect(notifications).toHaveLength(2)
    expect(notifications.every((notification) => notification.title === 'Post export failed'
      && notification.body === 'The export could not be completed. Please try again later.')).toBe(true)
  } finally {
    await pool.query(`DELETE FROM "organization" WHERE id = ANY($1::text[])`, [[organizationA, organizationB]])
    await pool.query(`DELETE FROM "user" WHERE id = $1`, [ownerId])
  }
})
