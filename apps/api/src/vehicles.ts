import { pool, zenstack } from '@repo/db'
import { ulid } from 'ulid'
import { writeAuditEvent } from './audit'

export type VehicleStatus = 'AVAILABLE' | 'ASSIGNED' | 'MAINTENANCE'
export type Vehicle = {
  id: string
  organizationId: string
  name: string
  plateNumber: string
  status: VehicleStatus
  createdAt: Date
  updatedAt: Date
}
export type VehicleActor = { userId: string; organizationId: string }

type Queryable = { query<T>(text: string, values?: unknown[]): Promise<{ rows: T[] }> }

async function hasUpcomingTrip(client: Queryable, organizationId: string, vehicleId: string, now: Date): Promise<boolean> {
  const result = await client.query<{ assigned: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM "trip"
       WHERE "organizationId" = $1 AND "vehicleId" = $2 AND status IN ('DRAFT', 'PUBLISHED') AND "departureAt" > $3
     ) AS assigned`,
    [organizationId, vehicleId, now],
  )
  return result.rows[0]?.assigned ?? false
}

async function requireOwner(actor: VehicleActor): Promise<void> {
  if (!await zenstack.member.findFirst({
    where: { userId: actor.userId, organizationId: actor.organizationId, role: 'owner' },
    select: { id: true },
  })) throw new Error('Owner access required')
}

export async function syncVehicleAssignmentStatus(
  client: Queryable,
  organizationId: string,
  vehicleId: string,
  actorId: string,
  now: Date,
): Promise<void> {
  const vehicle = await client.query<{ status: VehicleStatus }>(
    `SELECT status FROM "vehicle" WHERE id = $1 AND "organizationId" = $2 FOR UPDATE`,
    [vehicleId, organizationId],
  )
  if (!vehicle.rows[0]) throw new Error('Vehicle not found for this Travel business')
  const assigned = await hasUpcomingTrip(client, organizationId, vehicleId, now)
  const status = assigned ? 'ASSIGNED' : vehicle.rows[0].status === 'ASSIGNED' ? 'AVAILABLE' : vehicle.rows[0].status
  if (status === vehicle.rows[0].status) return
  await client.query(
    `UPDATE "vehicle" SET status = $3, "updatedAt" = $4 WHERE id = $1 AND "organizationId" = $2`,
    [vehicleId, organizationId, status, now],
  )
  await writeAuditEvent(client, organizationId, actorId, 'vehicle.status_changed', 'Vehicle', vehicleId, { status, source: 'Trip assignment' }, now)
}

export const vehicles = {
  async list(actor: VehicleActor): Promise<Vehicle[]> {
    await requireOwner(actor)
    const result = await pool.query<Vehicle>(
      `SELECT id, "organizationId", name, "plateNumber", status, "createdAt", "updatedAt"
       FROM "vehicle" WHERE "organizationId" = $1 ORDER BY name, "plateNumber"`,
      [actor.organizationId],
    )
    return result.rows
  },

  async create(actor: VehicleActor, input: { name: string; plateNumber: string }): Promise<Vehicle> {
    await requireOwner(actor)
    const name = input.name.trim()
    const plateNumber = input.plateNumber.trim().toUpperCase()
    if (!name || name.length > 100 || !plateNumber || plateNumber.length > 32) {
      throw new Error('Vehicle name and plate number are required')
    }
    const now = new Date()
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const result = await client.query<Vehicle>(
        `INSERT INTO "vehicle" (id, "organizationId", name, "plateNumber", status, "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4, 'AVAILABLE', $5, $5)
         RETURNING id, "organizationId", name, "plateNumber", status, "createdAt", "updatedAt"`,
        [ulid(), actor.organizationId, name, plateNumber, now],
      )
      const vehicle = result.rows[0]!
      await writeAuditEvent(client, actor.organizationId, actor.userId, 'vehicle.created', 'Vehicle', vehicle.id, {
        name: vehicle.name,
        plateNumber: vehicle.plateNumber,
      }, now)
      await client.query('COMMIT')
      return vehicle
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  },

  async updateStatus(actor: VehicleActor, id: string, status: VehicleStatus): Promise<Vehicle> {
    await requireOwner(actor)
    const now = new Date()
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const current = await client.query<Vehicle>(
        `SELECT id, "organizationId", name, "plateNumber", status, "createdAt", "updatedAt"
         FROM "vehicle" WHERE id = $1 AND "organizationId" = $2 FOR UPDATE`,
        [id, actor.organizationId],
      )
      if (!current.rows[0]) throw new Error('Vehicle not found')
      const assigned = await hasUpcomingTrip(client, actor.organizationId, id, now)
      if (status === 'ASSIGNED' && !assigned) throw new Error('Assign the Vehicle to a Trip before setting it to ASSIGNED')
      if (status !== 'ASSIGNED' && assigned) throw new Error('Unassign the Vehicle from its Trips before changing its status')
      const updated = await client.query<Vehicle>(
        `UPDATE "vehicle" SET status = $3, "updatedAt" = $4
         WHERE id = $1 AND "organizationId" = $2
         RETURNING id, "organizationId", name, "plateNumber", status, "createdAt", "updatedAt"`,
        [id, actor.organizationId, status, now],
      )
      if (current.rows[0].status !== status) {
        await writeAuditEvent(client, actor.organizationId, actor.userId, 'vehicle.status_changed', 'Vehicle', id, {
          from: current.rows[0].status,
          status,
        }, now)
      }
      await client.query('COMMIT')
      return updated.rows[0]!
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  },
}
