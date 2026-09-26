import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { getOwnerAuthorization, pool } from '@repo/db'
import { revokeSessionsBeforeTwoFactorEnable } from '@repo/auth'

test.skipIf(process.env.PALAWA_DB_TESTS !== '1')('enabling Owner two-factor removes pre-enrollment sessions', async () => {
  const suffix = randomUUID()
  const organizationId = `two-factor-${suffix}`
  const ownerId = `owner-${suffix}`
  const sessionId = `session-${suffix}`
  const now = new Date()

  try {
    await pool.query(
      `INSERT INTO "organization" (id, name, slug, "createdAt") VALUES ($1, 'Two-factor test', $1, $2)`,
      [organizationId, now],
    )
    await pool.query(
      `INSERT INTO "user" (id, name, email, "twoFactorEnabled") VALUES ($1, 'Two-factor owner', $2, false)`,
      [ownerId, `${ownerId}@example.test`],
    )
    await pool.query(
      `INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt") VALUES ($1, $2, $3, 'owner', $4)`,
      [`member-${suffix}`, organizationId, ownerId, now],
    )
    await pool.query(
      `INSERT INTO "session" (id, token, "userId", "expiresAt", "createdAt", "updatedAt") VALUES ($1, $2, $3, $4, $5, $5)`,
      [sessionId, `token-${suffix}`, ownerId, new Date(now.getTime() + 86_400_000), now],
    )
    expect(await getOwnerAuthorization(ownerId, organizationId)).toBe('two-factor-required')

    await revokeSessionsBeforeTwoFactorEnable(ownerId)
    const sessions = await pool.query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM "session" WHERE "userId" = $1`, [ownerId])
    expect(sessions.rows[0]?.count).toBe(0)

    await pool.query(`UPDATE "user" SET "twoFactorEnabled" = true WHERE id = $1`, [ownerId])
    expect(await getOwnerAuthorization(ownerId, organizationId)).toBe('authorized')
  } finally {
    await pool.query(`DELETE FROM "organization" WHERE id = $1`, [organizationId])
    await pool.query(`DELETE FROM "user" WHERE id = $1`, [ownerId])
  }
})
