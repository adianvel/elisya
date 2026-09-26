import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { S3Client } from 'bun'
import { sendEmail } from '../packages/email/index.ts'

const HOUR_MS = 60 * 60_000
const MONITOR_INTERVAL_MS = 60_000
const DATABASES = ['palawa', 'n8n'] as const
type DatabaseName = typeof DATABASES[number]
export type BackupManifest = {
  version: 1
  backupId: string
  createdAt: string
  files: Array<{ database: DatabaseName; name: string; size: number; sha256: string }>
}

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

const operatorEmail = requiredEnv('TECHNICAL_OPERATOR_EMAIL')
const backupPrefix = process.env.BACKUP_S3_PREFIX ?? 'postgres'
if (!/^[A-Za-z0-9/_-]+$/.test(backupPrefix) || backupPrefix.split('/').includes('..')) {
  throw new Error('BACKUP_S3_PREFIX must contain only letters, numbers, /, _ or -')
}

const backupS3 = new S3Client({
  endpoint: requiredEnv('BACKUP_S3_ENDPOINT'),
  accessKeyId: requiredEnv('BACKUP_S3_ACCESS_KEY'),
  secretAccessKey: requiredEnv('BACKUP_S3_SECRET_KEY'),
  bucket: requiredEnv('BACKUP_S3_BUCKET'),
  region: process.env.BACKUP_S3_REGION ?? 'ap-jakarta',
})

export async function runPostgresTool(command: string, args: string[], capture = false): Promise<string> {
  const child = Bun.spawn({ cmd: [command, ...args], stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, exitCode] = await Promise.all([
    capture ? new Response(child.stdout).text() : Promise.resolve(''),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exitCode !== 0) throw new Error(`${command} exited ${exitCode}: ${stderr.trim().slice(-1000)}`)
  return stdout.trim()
}

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

function backupKey(backupId: string, name: string): string {
  return `${backupPrefix}/${backupId}/${name}`
}

function validateBackupId(backupId: string): void {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(backupId)) throw new Error('Invalid backup ID')
}

export async function createBackup(backupId = new Date().toISOString().replace(/[:.]/g, '-')): Promise<BackupManifest> {
  validateBackupId(backupId)
  const directory = await mkdtemp(join(tmpdir(), 'palawa-backup-'))

  try {
    const files: BackupManifest['files'] = []
    for (const database of DATABASES) {
      const name = `${database}.dump`
      const path = join(directory, name)
      await runPostgresTool('pg_dump', ['--format=custom', '--no-owner', '--no-acl', '--file', path, '--dbname', database])
      await runPostgresTool('pg_restore', ['--list', path])
      files.push({ database, name, size: (await stat(path)).size, sha256: await sha256(path) })
    }

    const manifest: BackupManifest = { version: 1, backupId, createdAt: new Date().toISOString(), files }
    for (const file of files) {
      const key = backupKey(backupId, file.name)
      await backupS3.write(key, Bun.file(join(directory, file.name)), {
        type: 'application/octet-stream',
      })
      if (!(await backupS3.file(key).exists())) throw new Error(`Uploaded backup file is missing: ${file.name}`)
    }
    const manifestObjectKey = backupKey(backupId, 'manifest.json')
    await backupS3.write(manifestObjectKey, JSON.stringify(manifest), {
      type: 'application/json',
    })
    if (!(await backupS3.file(manifestObjectKey).exists())) throw new Error('Uploaded backup manifest is missing')
    return manifest
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

export async function restoreBackup(
  backupId: string,
  targets: Record<DatabaseName, string> = { palawa: 'palawa', n8n: 'n8n' },
): Promise<void> {
  validateBackupId(backupId)
  const directory = await mkdtemp(join(tmpdir(), 'palawa-restore-'))

  try {
    const manifest = await backupS3.file(backupKey(backupId, 'manifest.json')).json() as BackupManifest
    if (manifest.version !== 1 || manifest.backupId !== backupId || !Array.isArray(manifest.files)) {
      throw new Error('Backup manifest is invalid')
    }

    for (const database of DATABASES) {
      const file = manifest.files.find((item) => item.database === database)
      if (!file || file.name !== `${database}.dump` || !/^[a-f0-9]{64}$/.test(file.sha256)) {
        throw new Error(`Backup manifest is missing ${database}`)
      }
      const path = join(directory, file.name)
      await pipeline(
        Readable.from(backupS3.file(backupKey(backupId, file.name)).stream() as AsyncIterable<Uint8Array>),
        createWriteStream(path),
      )
      const restoredSize = (await stat(path)).size
      const restoredHash = await sha256(path)
      if (restoredSize !== file.size || restoredHash !== file.sha256) {
        throw new Error(`Backup checksum mismatch: ${database} (size ${file.size}/${restoredSize})`)
      }
      if (!/^[A-Za-z0-9_]+$/.test(targets[database])) throw new Error('Invalid restore database name')
      await runPostgresTool('pg_restore', [
        '--clean', '--if-exists', '--no-owner', '--no-acl', '--role', database,
        '--dbname', targets[database], path,
      ])
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

async function sendOperatorAlert(subject: string, text: string): Promise<void> {
  try {
    await sendEmail({ to: operatorEmail, subject, text })
  } catch (error) {
    console.error(JSON.stringify({ component: 'ops-alert', errorName: error instanceof Error ? error.name : 'UnknownError' }))
  }
}

let lastBackupAt = 0
let backupFailed = false

async function backupCycle(): Promise<void> {
  try {
    const manifest = await createBackup()
    lastBackupAt = Date.now()
    console.info(JSON.stringify({ component: 'backup', event: 'complete', backupId: manifest.backupId }))
    if (backupFailed) await sendOperatorAlert('Palawa database backup recovered', `A new PostgreSQL backup completed at ${manifest.createdAt}.`)
    backupFailed = false
  } catch (error) {
    console.error(JSON.stringify({ component: 'backup', event: 'failed', error: error instanceof Error ? error.message : 'UnknownError' }))
    if (!backupFailed) await sendOperatorAlert('Palawa database backup failed', `The scheduled backup failed at ${new Date().toISOString()}. Check the backup service logs.`)
    backupFailed = true
  }
}

async function collectChecks(): Promise<Map<string, boolean>> {
  const checks = new Map<string, boolean>()
  const probe = async (name: string, url: string, headers?: HeadersInit) => {
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(5_000) })
      const body = await response.json().catch(() => null) as { checks?: Record<string, string> } | null
      if (body?.checks && Object.keys(body.checks).length) {
        for (const [check, state] of Object.entries(body.checks)) checks.set(`${name}.${check}`, state === 'ok')
      } else {
        checks.set(name, response.ok)
      }
    } catch {
      checks.set(name, false)
    }
  }

  await Promise.all([
    probe('api', 'http://api:8000/health/ready'),
    probe('worker', 'http://tasks:8081/health/ready'),
    probe('n8n', 'http://n8n:5678/healthz/readiness'),
    probe('waha', 'http://waha:3000/health'),
  ])

  try {
    const response = await fetch('http://waha:3000/api/sessions/default', {
      headers: { 'X-Api-Key': requiredEnv('WAHA_API_KEY') },
      signal: AbortSignal.timeout(5_000),
    })
    const session = await response.json() as { status?: string }
    checks.set('waha.session', response.ok && session.status === 'WORKING')
  } catch {
    checks.set('waha.session', false)
  }

  return checks
}

const monitored = new Map<string, boolean>()

async function monitorCycle(): Promise<void> {
  for (const [name, healthy] of await collectChecks()) {
    const previous = monitored.get(name)
    if (previous === undefined && !healthy || previous !== undefined && previous !== healthy) {
      await sendOperatorAlert(
        `Palawa ${healthy ? 'recovered' : 'unavailable'}: ${name}`,
        `${name} is ${healthy ? 'healthy' : 'unavailable'} as of ${new Date().toISOString()}.`,
      )
    }
    monitored.set(name, healthy)
  }
}

async function backupLoop(): Promise<void> {
  let nextBackupAt = Date.now()
  while (true) {
    await Bun.sleep(Math.max(0, nextBackupAt - Date.now()))
    await backupCycle()
    nextBackupAt += HOUR_MS
  }
}

async function monitorLoop(): Promise<void> {
  await Bun.sleep(90_000)
  while (true) {
    await monitorCycle()
    await Bun.sleep(MONITOR_INTERVAL_MS)
  }
}

if (import.meta.main) {
  const [command, backupId] = process.argv.slice(2)
  if (command === '--once') {
    const manifest = await createBackup(backupId)
    console.info(JSON.stringify({ component: 'backup', event: 'complete', backupId: manifest.backupId }))
  } else if (command === 'restore' && backupId) {
    await restoreBackup(backupId)
    console.info(JSON.stringify({ component: 'backup', event: 'restored', backupId }))
  } else {
    const healthServer = Bun.serve({
      hostname: '0.0.0.0',
      port: 8082,
      fetch(request) {
        if (request.method !== 'GET' || new URL(request.url).pathname !== '/health/ready') {
          return new Response('Not found', { status: 404 })
        }
        const healthy = lastBackupAt > 0 && !backupFailed && Date.now() - lastBackupAt < 2 * HOUR_MS
        return Response.json({ status: healthy ? 'ok' : 'unavailable', checks: { backup: healthy ? 'ok' : 'unavailable' } }, { status: healthy ? 200 : 503 })
      },
    })
    process.on('SIGTERM', () => { void healthServer.stop(true); process.exit(0) })
    process.on('SIGINT', () => { void healthServer.stop(true); process.exit(0) })
    await Promise.all([backupLoop(), monitorLoop()])
  }
}
