import { describe, expect, it } from 'bun:test'
import { createTripService, type Trip, type TripStore } from './trips'

const trip = (overrides: Partial<Trip> = {}): Trip => ({
  id: 'trip-1',
  organizationId: 'business-1',
  origin: 'Jakarta',
  destination: 'Bandung',
  departureAt: new Date('2030-01-02T08:00:00Z'),
  price: 150000,
  currency: 'IDR',
  seatQuota: 10,
  status: 'PUBLISHED',
  ...overrides,
})

const store = (trips: Trip[], ownerIds = ['owner-1'], reservedSeats: Record<string, number> = {}): TripStore => ({
  isOwner: async (userId, organizationId) => organizationId === 'business-1' && ownerIds.includes(userId),
  create: async (input) => {
    const created = trip({ ...input, id: `trip-${trips.length + 1}` })
    trips.push(created)
    return created
  },
  update: async (organizationId, id, input) => {
    const current = trips.find((item) => item.organizationId === organizationId && item.id === id)
    if (!current) return null
    if (input.seatQuota !== undefined && input.seatQuota < (reservedSeats[id] ?? 0)) {
      throw new Error(`seatQuota cannot be lower than ${reservedSeats[id]} reserved seats`)
    }
    Object.assign(current, input)
    return current
  },
  findMany: async (organizationId) => trips.filter((item) => item.organizationId === organizationId),
  findAvailable: async (organizationId, now) => trips
    .filter((item) => item.organizationId === organizationId && item.status === 'PUBLISHED' && item.departureAt > now)
    .map((item) => ({ ...item, remainingSeats: item.seatQuota - (reservedSeats[item.id] ?? 0) }))
    .filter((item) => item.remainingSeats > 0),
})

describe('Trip service', () => {
  it('lists only future published Trips for the requested Travel business', async () => {
    const service = createTripService(store([
      trip(),
      trip({ id: 'past', departureAt: new Date('2020-01-02T08:00:00Z') }),
      trip({ id: 'draft', status: 'DRAFT' }),
      trip({ id: 'other-business', organizationId: 'business-2' }),
    ]))

    await expect(service.listAvailable({
      organizationId: 'business-1',
      now: new Date('2029-01-01T00:00:00Z'),
    })).resolves.toEqual([{ ...trip(), remainingSeats: 10 }])
  })

  it('allows only Owners to create Trips for their Travel business', async () => {
    const service = createTripService(store([]))
    const input = {
      origin: 'Jakarta',
      destination: 'Bandung',
      departureAt: new Date('2030-01-02T08:00:00Z'),
      price: 150000,
      seatQuota: 10,
    }

    await expect(service.create({ userId: 'owner-1', organizationId: 'business-1' }, input))
      .resolves.toMatchObject({ organizationId: 'business-1', ...input, currency: 'IDR', status: 'DRAFT' })
    await expect(service.create({ userId: 'member-1', organizationId: 'business-1' }, input))
      .rejects.toThrow('Owner access required')
  })

  it('rejects invalid price and seat quota', async () => {
    const service = createTripService(store([]))
    const actor = { userId: 'owner-1', organizationId: 'business-1' }

    await expect(service.create(actor, {
      origin: 'Jakarta', destination: 'Bandung', departureAt: new Date('2030-01-02T08:00:00Z'), price: -1, seatQuota: 10,
    })).rejects.toThrow('price must be a non-negative integer')
    await expect(service.create(actor, {
      origin: 'Jakarta', destination: 'Bandung', departureAt: new Date('2030-01-02T08:00:00Z'), price: 150000, seatQuota: 0,
    })).rejects.toThrow('seatQuota must be a positive integer')
  })

  it('updates a Trip without changing fields that were omitted', async () => {
    const service = createTripService(store([trip()]))

    await expect(service.update(
      { userId: 'owner-1', organizationId: 'business-1' },
      'trip-1',
      { status: 'PUBLISHED' },
    )).resolves.toMatchObject({ id: 'trip-1', origin: 'Jakarta', status: 'PUBLISHED' })
  })

  it('rejects a seat quota below reserved seats', async () => {
    const service = createTripService(store([trip()], ['owner-1'], { 'trip-1': 4 }))
    await expect(service.update(
      { userId: 'owner-1', organizationId: 'business-1' },
      'trip-1',
      { seatQuota: 3 },
    )).rejects.toThrow('seatQuota cannot be lower than 4 reserved seats')
  })
})
