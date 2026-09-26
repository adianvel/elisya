import { pool, zenstack } from '@repo/db'
import { ulid } from 'ulid'
import { isAuthorizedOwner } from './authz'
import { writeAuditEvent } from './audit'
import { RESERVED_SEATS_BY_TRIP } from './reserved-seats'
import { cancelTrip } from './trip-cancellation'
import { syncVehicleAssignmentStatus } from './vehicles'

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
  vehicleId: string | null
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

export type TripPatch = Partial<TripInput> & { status?: Exclude<TripStatus, 'CANCELLED'>; vehicleId?: string | null }

export type PendingPaymentDecision = { paymentId: string; fundsReceived: boolean }

export type TripActor = {
  userId: string
  organizationId: string
}

export type TripStore = {
  isOwner(userId: string, organizationId: string): Promise<boolean>
  create(actorId: string, input: TripInput & { organizationId: string; currency: string; status: TripStatus }): Promise<Trip>
  update(organizationId: string, id: string, input: TripPatch, actorId: string, now: Date): Promise<Trip | null>
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
  isOwner: isAuthorizedOwner,
  async create(actorId, input) {
    const now = new Date()
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const created = await client.query<Trip>(
        `INSERT INTO "trip" (id, "organizationId", origin, destination, "departureAt", price, currency, "seatQuota", status, "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)
         RETURNING id, "organizationId", origin, destination, "departureAt", price, currency, "seatQuota", status, "vehicleId"`,
        [ulid(), input.organizationId, input.origin, input.destination, input.departureAt, input.price, input.currency, input.seatQuota, input.status, now],
      )
      const trip = created.rows[0]!
      await writeAuditEvent(client, input.organizationId, actorId, 'trip.created', 'Trip', trip.id, {
        origin: trip.origin,
        destination: trip.destination,
      }, now)
      await client.query('COMMIT')
      return trip
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  },
  async update(organizationId, id, input, actorId, now) {
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

      const nextStatus = input.status ?? current.rows[0].status
      const assignmentChanged = input.vehicleId !== undefined && input.vehicleId !== current.rows[0].vehicleId
      const wasOperational = (current.rows[0].status === 'DRAFT' || current.rows[0].status === 'PUBLISHED') && current.rows[0].departureAt > now
      const isOperational = (nextStatus === 'DRAFT' || nextStatus === 'PUBLISHED') && (input.departureAt ?? current.rows[0].departureAt) > now
      const assignmentAffectsVehicle = assignmentChanged || wasOperational !== isOperational
      if (input.vehicleId && nextStatus === 'ARCHIVED') throw new Error('Archived Trips cannot be assigned a Vehicle')
      const affectedVehicleIds = [...new Set([current.rows[0].vehicleId, input.vehicleId ?? null].filter((vehicleId): vehicleId is string => Boolean(vehicleId)))]
      if (assignmentAffectsVehicle && affectedVehicleIds.length) {
        const lockedVehicles = await client.query<{ id: string; status: string }>(
          `SELECT id, status FROM "vehicle" WHERE "organizationId" = $1 AND id = ANY($2::text[]) ORDER BY id FOR UPDATE`,
          [organizationId, affectedVehicleIds],
        )
        if (current.rows[0].vehicleId && !lockedVehicles.rows.some((vehicle) => vehicle.id === current.rows[0]!.vehicleId)) {
          throw new Error('Trip Vehicle not found for this Travel business')
        }
        if (input.vehicleId && !lockedVehicles.rows.some((vehicle) => vehicle.id === input.vehicleId)) {
          throw new Error('Vehicle not found for this Travel business')
        }
        const assignedVehicle = input.vehicleId
          ? lockedVehicles.rows.find((vehicle) => vehicle.id === input.vehicleId)
          : undefined
        if (input.vehicleId && isOperational && assignedVehicle?.status === 'MAINTENANCE') {
          throw new Error('Vehicle in maintenance cannot be assigned to a Trip')
        }
        const existingVehicle = current.rows[0].vehicleId
          ? lockedVehicles.rows.find((vehicle) => vehicle.id === current.rows[0]!.vehicleId)
          : undefined
        if (!input.vehicleId && isOperational && !wasOperational && existingVehicle?.status === 'MAINTENANCE') {
          throw new Error('Vehicle in maintenance cannot be assigned to a Trip')
        }
      }

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
        vehicleId: 'vehicleId',
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
      if (assignmentAffectsVehicle) {
        for (const vehicleId of affectedVehicleIds) {
          await syncVehicleAssignmentStatus(client, organizationId, vehicleId, actorId, now)
        }
      }
      await writeAuditEvent(client, organizationId, actorId, 'trip.updated', 'Trip', id, { changedFields: fields }, now)
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
      return tripStore.create(actor.userId, {
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
      const updated = await tripStore.update(actor.organizationId, id, input, actor.userId, new Date())
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
