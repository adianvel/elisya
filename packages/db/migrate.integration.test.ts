import { expect, test } from 'bun:test'
import { Client } from 'pg'

if (process.env.DATABASE_URL) test('the PostgreSQL migration creates the Palawa schema and records its checksum', async () => {
  const client = new Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()

  try {
    const result = await client.query<{ hasTripTable: boolean; migrationName: string; checksum: string }>(`
      SELECT
        to_regclass('public.trip') IS NOT NULL AS "hasTripTable",
        (SELECT name FROM public."_schema_migration" ORDER BY name LIMIT 1) AS "migrationName",
        (SELECT checksum FROM public."_schema_migration" ORDER BY name LIMIT 1) AS checksum
    `)
    expect(result.rows[0]).toMatchObject({ hasTripTable: true, migrationName: '0001-initial.sql' })
    expect(result.rows[0]?.checksum).toHaveLength(64)
  } finally {
    await client.end()
  }
})
