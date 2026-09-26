import { randomUUID } from 'node:crypto'
import { pool } from '../packages/db/index.ts'
import { S3Client } from 'bun'
import { createBackup, restoreBackup, runPostgresTool } from './backup.ts'

const proofS3 = new S3Client({
  endpoint: process.env.S3_ENDPOINT!,
  accessKeyId: process.env.S3_ACCESS_KEY!,
  secretAccessKey: process.env.S3_SECRET_KEY!,
  bucket: process.env.S3_BUCKET!,
  region: process.env.S3_REGION ?? 'us-east-1',
})

async function ensureBackupRole(password: string) {
  if (!/^[A-Za-z0-9_-]{16,}$/.test(password)) throw new Error('BACKUP_DB_PASSWORD must be a generated safe secret')
  const role = await pool.query('SELECT 1 FROM pg_roles WHERE rolname = $1', ['backup'])
  const action = role.rowCount ? 'ALTER' : 'CREATE'
  await pool.query(`${action} ROLE backup WITH LOGIN PASSWORD '${password}'`)
  await pool.query('GRANT pg_read_all_data TO backup')
  await pool.query('GRANT CONNECT ON DATABASE palawa TO backup')
  await pool.query('GRANT CONNECT ON DATABASE n8n TO backup')
}

async function ensureN8nDatabase() {
  const role = await pool.query('SELECT 1 FROM pg_roles WHERE rolname = $1', ['n8n'])
  if (!role.rowCount) await runPostgresTool('psql', ['--dbname', 'postgres', '--command', 'CREATE ROLE n8n'])
  const database = await pool.query('SELECT 1 FROM pg_database WHERE datname = $1', ['n8n'])
  if (!database.rowCount) await runPostgresTool('createdb', ['--owner=n8n', 'n8n'])
}

const suffix = randomUUID().replaceAll('-', '')
const backupId = `drill-${suffix}`
const restorePalawa = `palawa_restore_${suffix}`
const restoreN8n = `n8n_restore_${suffix}`
const organizationId = `backup-drill-${suffix}`
const tripId = `trip-${suffix}`
const holdId = `hold-${suffix}`
const paymentId = `payment-${suffix}`
const proofKey = `payment-proofs/backup-drill-${suffix}.pdf`
const now = new Date()

try {
  await ensureN8nDatabase()
  const adminUser = process.env.PGUSER
  const adminPassword = process.env.PGPASSWORD
  const backupPassword = process.env.BACKUP_DB_PASSWORD
  if (!backupPassword) throw new Error('BACKUP_DB_PASSWORD is required for the restore drill')
  await ensureBackupRole(backupPassword)
  await proofS3.write(proofKey, new Blob(['Palawa backup drill proof'], { type: 'application/pdf' }), { type: 'application/pdf' })
  await pool.query(
    `INSERT INTO "organization" (id, name, slug, "createdAt") VALUES ($1, 'Backup drill', $1, $2)`,
    [organizationId, now],
  )
  await pool.query(
    `INSERT INTO "trip" (id, "organizationId", origin, destination, "departureAt", price, "seatQuota", status)
     VALUES ($1, $2, 'A', 'B', $3, 100, 1, 'PUBLISHED')`,
    [tripId, organizationId, new Date(now.getTime() + 86_400_000)],
  )
  await pool.query(
    `INSERT INTO "hold" (id, "organizationId", "tripId", "customerRef", "seatCount", "expiresAt", "idempotencyKey")
     VALUES ($1, $2, $3, 'backup-drill', 1, $4, $5)`,
    [holdId, organizationId, tripId, new Date(now.getTime() + 600_000), `backup-${suffix}`],
  )
  await pool.query(
    `INSERT INTO "payment" (id, "organizationId", "holdId", "customerRef", "proofKey", "idempotencyKey")
     VALUES ($1, $2, $3, 'backup-drill', $4, $5)`,
    [paymentId, organizationId, holdId, proofKey, `backup-${suffix}`],
  )

  process.env.PGUSER = 'backup'
  process.env.PGPASSWORD = backupPassword
  try {
    await createBackup(backupId)
  } finally {
    if (adminUser) process.env.PGUSER = adminUser
    else delete process.env.PGUSER
    if (adminPassword) process.env.PGPASSWORD = adminPassword
    else delete process.env.PGPASSWORD
  }
  await runPostgresTool('createdb', ['--owner=palawa', restorePalawa])
  await runPostgresTool('createdb', ['--owner=n8n', restoreN8n])
  await restoreBackup(backupId, { palawa: restorePalawa, n8n: restoreN8n })

  const restoredProofKey = await runPostgresTool('psql', [
    '--dbname', restorePalawa,
    '--tuples-only',
    '--no-align',
    '--command', `SELECT "proofKey" FROM "payment" WHERE id = '${paymentId}'`,
  ], true)
  if (restoredProofKey !== proofKey || !(await proofS3.file(proofKey).exists())) {
    throw new Error('Restored Payment proof reference or COS object is missing')
  }

  console.info(JSON.stringify({ event: 'backup-restore-drill-passed', backupId, proofAccessible: true }))
} finally {
  await runPostgresTool('dropdb', ['--if-exists', '--force', restorePalawa]).catch(() => '')
  await runPostgresTool('dropdb', ['--if-exists', '--force', restoreN8n]).catch(() => '')
  await pool.query('DELETE FROM "organization" WHERE id = $1', [organizationId]).catch(() => {})
  await proofS3.delete(proofKey).catch(() => {})
}
