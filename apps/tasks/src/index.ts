import { PgBoss } from 'pg-boss'
import { pool } from '@repo/db'

import { type AnyTaskDefinition } from './registry'
import { tasks } from './tasks'

const DATABASE_URL = process.env.DATABASE_URL

if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required')
}

const boss = new PgBoss({
  connectionString: DATABASE_URL,
})

await boss.start()

for (const definition of tasks as readonly AnyTaskDefinition[]) {
  await boss.createQueue(definition.id, {
    retryLimit: definition.retryLimit,
    retryDelay: definition.retryDelay,
    retryBackoff: definition.retryBackoff,
  })

  await boss.work<object>(definition.id, async (jobs) => {
    for (const job of jobs) {
      const payload = definition.payload.parse(job.data)
      await definition.run(payload, {
        job,
        send: (id, data, options) => boss.send(id, data, options),
      })
    }
  })
}

await boss.schedule('notify.whatsapp.outbox', '* * * * *', {}, { key: 'whatsapp-outbox' })

const healthServer = Bun.serve({
  hostname: '0.0.0.0',
  port: 8081,
  async fetch(request) {
    if (request.method !== 'GET' || new URL(request.url).pathname !== '/health/ready') {
      return new Response('Not found', { status: 404 })
    }

    try {
      const expected = tasks.map(({ id }) => id)
      const result = await pool.query<{ name: string }>(
        'SELECT name FROM pgboss.queue WHERE name = ANY($1::text[])',
        [expected],
      )
      if (result.rows.length !== expected.length) throw new Error('A task queue is missing')
      return Response.json({ status: 'ok', checks: { worker: 'ok', queue: 'ok', database: 'ok' } })
    } catch {
      return Response.json({ status: 'unavailable', checks: { worker: 'ok', queue: 'unavailable' } }, { status: 503 })
    }
  },
})

console.log('Task worker started')
console.log('Registered queues:', tasks.map((task) => task.id).join(', '))

async function shutdown(signal: string) {
  console.log(`Received ${signal}, shutting down...`)

  await healthServer.stop(true)

  await boss.stop({
    graceful: true,
  })

  process.exit(0)
}

process.on('SIGINT', () => {
  shutdown('SIGINT')
})

process.on('SIGTERM', () => {
  shutdown('SIGTERM')
})
