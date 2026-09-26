import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { Client } from 'pg'

const databaseUrl = process.env.DATABASE_URL
const migrationDirectory = new URL('./migrations/', import.meta.url)
// ponytail: one database-wide lock is enough for this single-app database; split migration ownership only if services need independent schema migrations.
const lockId = 836_492_071

export function migrationChecksum(sql: string): string {
  return createHash('sha256').update(sql).digest('hex')
}

export async function migrate() {
  if (!databaseUrl) throw new Error('DATABASE_URL is required')

  const client = new Client({ connectionString: databaseUrl })
  await client.connect()

  try {
    await client.query('SELECT pg_advisory_lock($1::bigint)', [lockId])
    await client.query(`
      CREATE TABLE IF NOT EXISTS public."_schema_migration" (
        name text PRIMARY KEY,
        checksum text NOT NULL,
        "appliedAt" timestamptz NOT NULL DEFAULT now()
      )
    `)

    const files = (await readdir(migrationDirectory))
      .filter((file) => /^\d{4}-[a-z0-9-]+\.sql$/.test(file))
      .sort()
    if (!files.length) throw new Error('No SQL migrations were found')

    for (const name of files) {
      const sql = await readFile(new URL(name, migrationDirectory), 'utf8')
      const checksum = migrationChecksum(sql)
      const applied = await client.query<{ checksum: string }>(
        'SELECT checksum FROM public."_schema_migration" WHERE name = $1',
        [name],
      )

      if (applied.rows[0]) {
        if (applied.rows[0].checksum !== checksum) {
          throw new Error(`Applied migration was modified: ${name}`)
        }
        continue
      }

      await client.query('BEGIN')
      try {
        await client.query(sql)
        await client.query(
          'INSERT INTO public."_schema_migration" (name, checksum) VALUES ($1, $2)',
          [name, checksum],
        )
        await client.query('COMMIT')
        console.info(`Applied migration ${name}`)
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1::bigint)', [lockId]).catch(() => {})
    await client.end()
  }
}

if (import.meta.main) await migrate()
