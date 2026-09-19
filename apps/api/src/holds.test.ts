import { describe, expect, it } from 'bun:test'
import { createHoldService, type Hold, type HoldStore } from './holds'

const tripId = 'trip-1'

function fakeStore(quota = 3): HoldStore {
  const rows: Hold[] = []
  const keys = new Set<string>()
  let lock = Promise.resolve()
  const withLock = async <T>(work: () => T | Promise<T>): Promise<T> => {
    const previous = lock
    let release!: () => void
    lock = new Promise<void>((resolve) => { release = resolve })
    await previous
    try { return await work() } finally { release() }
  }
  return {
    create: (input) => withLock(() => {
      const key = `${input.organizationId}:${input.customerRef}:${input.idempotencyKey}`
      const existing = keys.has(key) ? rows.find((row) => row.organizationId === input.organizationId && row.customerRef === input.customerRef && row.tripId === input.tripId) : undefined
      if (existing) return existing
      const now = input.now ?? new Date()
      for (const row of rows) if (row.status === 'ACTIVE' && row.expiresAt <= now) row.status = 'EXPIRED'
      const reserved = rows.filter((row) => row.tripId === input.tripId && row.status === 'ACTIVE' && row.expiresAt > now).reduce((sum, row) => sum + row.seatCount, 0)
      if (reserved + input.seatCount > quota) throw new Error('Not enough seats available')
      const row: Hold = { id: `hold-${rows.length + 1}`, organizationId: input.organizationId, tripId: input.tripId, customerRef: input.customerRef, seatCount: input.seatCount, status: 'ACTIVE', expiresAt: new Date(now.getTime() + 900_000) }
      rows.push(row)
      keys.add(key)
      return row
    }),
    expire: (organizationId, now) => withLock(() => {
      let count = 0
      for (const row of rows) if (row.organizationId === organizationId && row.status === 'ACTIVE' && row.expiresAt <= now) { row.status = 'EXPIRED'; count++ }
      return count
    }),
    find: async (organizationId, id) => rows.find((row) => row.organizationId === organizationId && row.id === id) ?? null,
  }
}

describe('Hold service', () => {
  it('creates a hold and returns the same hold for an idempotent retry', async () => {
    const service = createHoldService(fakeStore())
    const input = { organizationId: 'org-1', tripId, customerRef: '+6281', seatCount: 2, idempotencyKey: 'request-1' }
    const first = await service.create(input)
    const retry = await service.create(input)
    expect(first).toEqual(retry)
    expect(first.status).toBe('ACTIVE')
  })

  it('rejects invalid seat counts and overbooking, including concurrent requests', async () => {
    const service = createHoldService(fakeStore(2))
    await expect(service.create({ organizationId: 'org-1', tripId, customerRef: 'a', seatCount: 0, idempotencyKey: 'bad' })).rejects.toThrow('seatCount must be a positive integer')
    const results = await Promise.allSettled([
      service.create({ organizationId: 'org-1', tripId, customerRef: 'a', seatCount: 2, idempotencyKey: 'a' }),
      service.create({ organizationId: 'org-1', tripId, customerRef: 'b', seatCount: 1, idempotencyKey: 'b' }),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
  })

  it('expires unpaid holds and releases their seats', async () => {
    const service = createHoldService(fakeStore(1))
    const now = new Date('2026-09-19T12:00:00Z')
    const hold = await service.create({ organizationId: 'org-1', tripId, customerRef: 'a', seatCount: 1, idempotencyKey: 'a', now })
    const expired = await service.get('org-1', hold.id, new Date(now.getTime() + 901_000))
    expect(expired?.status).toBe('EXPIRED')
    const replacement = await service.create({ organizationId: 'org-1', tripId, customerRef: 'b', seatCount: 1, idempotencyKey: 'b', now: new Date(now.getTime() + 901_000) })
    expect(replacement.status).toBe('ACTIVE')
  })
})
