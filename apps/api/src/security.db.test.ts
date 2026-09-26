import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { db, pool } from '@repo/db'

test.skipIf(process.env.PALAWA_DB_TESTS !== '1')('generic model policies scope Users and Posts to the authenticated identity and business', async () => {
  const suffix = randomUUID()
  const organizationA = `security-a-${suffix}`
  const organizationB = `security-b-${suffix}`
  const userA = `security-user-a-${suffix}`
  const userB = `security-user-b-${suffix}`
  const now = new Date()

  try {
    await pool.query(
      `INSERT INTO "organization" (id, name, slug, "createdAt") VALUES
       ($1, 'Security business A', $1, $3), ($2, 'Security business B', $2, $3)`,
      [organizationA, organizationB, now],
    )
    await pool.query(
      `INSERT INTO "user" (id, name, email, "twoFactorEnabled") VALUES
       ($1, 'Security owner A', $2, true), ($3, 'Security owner B', $4, true)`,
      [userA, `${userA}@example.test`, userB, `${userB}@example.test`],
    )
    await pool.query(
      `INSERT INTO "member" (id, "organizationId", "userId", role, "createdAt") VALUES
       ($1, $2, $3, 'owner', $4), ($5, $6, $7, 'owner', $4)`,
      [`member-a-${suffix}`, organizationA, userA, now, `member-b-${suffix}`, organizationB, userB],
    )
    await pool.query(
      `INSERT INTO "post" (id, title, content, status, "authorId", "organizationId", "createdAt", "updatedAt") VALUES
       ($1, 'A business post', 'A', 'DRAFT', $2, $3, $4, $4),
       ($5, 'B business post', 'B', 'DRAFT', $6, $7, $4, $4),
       ($8, 'A personal post', 'A personal', 'DRAFT', $2, NULL, $4, $4)`,
      [`post-a-${suffix}`, userA, organizationA, now, `post-b-${suffix}`, userB, organizationB, `post-personal-${suffix}`],
    )

    const clientA = db.$setAuth({ id: userA, members: [{ organizationId: organizationA, role: 'owner' }] } as any)
    const clientB = db.$setAuth({ id: userB, members: [{ organizationId: organizationB, role: 'owner' }] } as any)
    const anonymous = db.$setAuth({ id: '', members: [] } as any)

    expect((await clientA.post.findMany({})).map((post) => post.id).sort()).toEqual([`post-a-${suffix}`, `post-personal-${suffix}`].sort())
    expect((await clientB.post.findMany({})).map((post) => post.id)).toEqual([`post-b-${suffix}`])
    expect((await clientA.user.findMany({})).map((user) => user.id)).toEqual([userA])
    expect(await anonymous.post.findMany({})).toEqual([])
    expect(await anonymous.user.findMany({})).toEqual([])
    let crossBusinessUpdateDenied = false
    try {
      await clientA.post.update({ where: { id: `post-a-${suffix}` }, data: { organizationId: organizationB } })
    } catch {
      crossBusinessUpdateDenied = true
    }
    expect(crossBusinessUpdateDenied).toBe(true)
  } finally {
    await pool.query(`DELETE FROM "organization" WHERE id = ANY($1::text[])`, [[organizationA, organizationB]])
    await pool.query(`DELETE FROM "user" WHERE id = ANY($1::text[])`, [[userA, userB]])
  }
})
