import { pool, zenstack } from '@repo/db'
import { RESERVED_SEATS_BY_TRIP } from './reserved-seats'
import { cancelTrip } from './trip-cancellation'

export type TripStatus = 'DRAFT' | 'PUBLISHED' | 'ARCHIVED' | 'CANCELLED'

export type Trip = {
  id: string
  organizationId: string
  origin: string
  destination: string
  departureAt: Date
  price: number
  currency: string
  seatQuota: number
  status: TripStatus
}

export type AvailableTrip = Trip & { remainingSeats: number }

export type TripInput = {
  origin: string
  destination: string
  departureAt: Date
  price: number
  currency?: string
  seatQuota: number
}

export type TripPatch = Partial<TripInput> & { status?: Exclude<TripStatus, 'CANCELLED'> }

export type PendingPaymentDecision = { paymentId: string; fundsReceived: boolean }

export type TripActor = {
  userId: string
  organizationId: string
}

export type TripStore = {
  isOwner(userId: string, organizationId: string): Promise<boolean>
  create(input: TripInput & { organizationId: string; currency: string; status: TripStatus }): Promise<Trip>
  update(organizationId: string, id: string, input: TripPatch, now: Date): Promise<Trip | null>
  cancel(organizationId: string, id: string, actorId: string, decisions: PendingPaymentDecision[], now: Date): Promise<Trip | null>
  findMany(organizationId: string): Promise<Trip[]>
  findAvailable(organizationId: string, now: Date): Promise<AvailableTrip[]>
}

export function configuredOrganizationId(): string {
  const organizationId = process.env.PALAWA_ORGANIZATION_ID
  if (!organizationId) throw new Error('PALAWA_ORGANIZATION_ID is required')
  return organizationId
}

const store: TripStore = {
  isOwner: async (userId, organizationId) => Boolean(await zenstack.member.findFirst({
    where: { userId, organizationId, role: 'owner' },
    select: { id: true },
  })),
  create: async (input) => zenstack.trip.create({ data: input }) as Promise<Trip>,
  async update(organizationId, id, input, now) {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const current = await client.query<Trip>(
        `SELECT id, "organizationId", origin, destination, "departureAt", price, currency, "seatQuota", status, "vehicleId", "createdAt", "updatedAt"
         FROM "trip" WHERE id = $1 AND "organizationId" = $2 FOR UPDATE`,
        [id, organizationId],
      )
      if (!current.rows[0]) {
        await client.query('COMMIT')
        return null
      }
      if (current.rows[0].status === 'CANCELLED') throw new Error('Cancelled Trip cannot be edited')

      if (input.seatQuota !== undefined || input.status === 'ARCHIVED') {
        const reserved = await client.query<{ seats: number }>(
          `SELECT seats FROM (${RESERVED_SEATS_BY_TRIP}) reserved
           WHERE reserved."organizationId" = $2 AND reserved."tripId" = $3`,
          [now, organizationId, id],
        )
        const reservedSeats = reserved.rows[0]?.seats ?? 0
        if (input.seatQuota !== undefined && input.seatQuota < reservedSeats) throw new Error(`seatQuota cannot be lower than ${reservedSeats} reserved seats`)
        if (input.status === 'ARCHIVED' && reservedSeats > 0) throw new Error('Trip cannot be archived with active Holds or Bookings; use cancellation instead')
      }

      const columns = {
        origin: 'origin',
        destination: 'destination',
        departureAt: 'departureAt',
        price: 'price',
        currency: 'currency',
        seatQuota: 'seatQuota',
        status: 'status',
      } as const
      const fields = Object.keys(columns).filter((key) => input[key as keyof TripPatch] !== undefined) as Array<keyof typeof columns>
      if (!fields.length) {
        await client.query('COMMIT')
        return current.rows[0]
      }
      const values: unknown[] = [id, organizationId]
      const assignments = fields.map((field) => {
        values.push(input[field])
        return `"${columns[field]}" = $${values.length}`
      })
      values.push(now)
      const updated = await client.query<Trip>(
        `UPDATE "trip" SET ${assignments.join(', ')}, "updatedAt" = $${values.length}
         WHERE id = $1 AND "organizationId" = $2
         RETURNING id, "organizationId", origin, destination, "departureAt", price, currency, "seatQuota", status, "vehicleId", "createdAt", "updatedAt"`,
        values,
      )
      await client.query('COMMIT')
      return updated.rows[0] ?? null
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  },
  cancel: cancelTrip,
  findMany: async (organizationId) => zenstack.trip.findMany({
    where: { organizationId },
    orderBy: { departureAt: 'asc' },
  }) as Promise<Trip[]>,
  async findAvailable(organizationId, now) {
    const result = await pool.query<AvailableTrip>(
      `SELECT t.id, t."organizationId", t.origin, t.destination, t."departureAt", t.price, t.currency,
              t."seatQuota", t.status, t."vehicleId", t."createdAt", t."updatedAt",
              GREATEST(t."seatQuota" - COALESCE(reserved.seats, 0), 0)::int AS "remainingSeats"
       FROM "trip" t
       LEFT JOIN (${RESERVED_SEATS_BY_TRIP}) reserved
         ON reserved."organizationId" = t."organizationId" AND reserved."tripId" = t.id
       WHERE t."organizationId" = $2 AND t.status = 'PUBLISHED' AND t."departureAt" > $1
         AND t."seatQuota" > COALESCE(reserved.seats, 0)
       ORDER BY t."departureAt" ASC`,
      [now, organizationId],
    )
    return result.rows
  },
}

function validateTrip(input: TripInput): void {
  if (!input.origin.trim() || !input.destination.trim()) throw new Error('origin and destination are required')
  if (!(input.departureAt instanceof Date) || Number.isNaN(input.departureAt.getTime())) throw new Error('departureAt must be a valid date')
  if (!Number.isInteger(input.price) || input.price < 0) throw new Error('price must be a non-negative integer')
  if (!Number.isInteger(input.seatQuota) || input.seatQuota < 1) throw new Error('seatQuota must be a positive integer')
}

async function requireOwner(actor: TripActor, tripStore: TripStore): Promise<void> {
  if (!await tripStore.isOwner(actor.userId, actor.organizationId)) throw new Error('Owner access required')
}

export function createTripService(tripStore: TripStore = store) {
  return {
    async create(actor: TripActor, input: TripInput): Promise<Trip> {
      await requireOwner(actor, tripStore)
      validateTrip(input)
      return tripStore.create({
        ...input,
        organizationId: actor.organizationId,
        currency: input.currency ?? 'IDR',
        status: 'DRAFT',
      })
    },

    async update(actor: TripActor, id: string, input: TripPatch): Promise<Trip> {
      await requireOwner(actor, tripStore)
      const current = (await tripStore.findMany(actor.organizationId)).find((trip) => trip.id === id)
      if (!current) throw new Error('Trip not found')
      validateTrip({ ...current, ...input })
      const updated = await tripStore.update(actor.organizationId, id, input, new Date())
      if (!updated) throw new Error('Trip not found')
      return updated
    },

    async cancel(actor: TripActor, id: string, decisions: PendingPaymentDecision[] = []): Promise<Trip> {
      await requireOwner(actor, tripStore)
      if (!id) throw new Error('Trip ID is required')
      const cancelled = await tripStore.cancel(actor.organizationId, id, actor.userId, decisions, new Date())
      if (!cancelled) throw new Error('Trip not found')
      return cancelled
    },

    async listAvailable({ organizationId, now = new Date() }: { organizationId: string; now?: Date }): Promise<AvailableTrip[]> {
      return tripStore.findAvailable(organizationId, now)
    },

    async listOwner(actor: TripActor): Promise<Trip[]> {
      await requireOwner(actor, tripStore)
      return tripStore.findMany(actor.organizationId)
    },
  }
}

export const trips = createTripService()
