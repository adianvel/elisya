import { pool } from '@repo/db'
import { ulid } from 'ulid'
import { notifyWhatsApp } from './notifications'

export type HoldStatus = 'ACTIVE' | 'EXPIRED'

export type Hold = {
  id: string
  organizationId: string
  tripId: string
  customerRef: string
  seatCount: number
  status: HoldStatus
  expiresAt: Date
}

export type CreateHoldInput = {
  organizationId: string
  tripId: string
  customerRef: string
  seatCount: number
  idempotencyKey: string
  now?: Date
}

export type HoldStore = {
  create(input: CreateHoldInput): Promise<Hold>
  expire(organizationId: string, now: Date): Promise<number>
  find(organizationId: string, id: string): Promise<Hold | null>
}

export const HOLD_TTL_MS = 15 * 60 * 1000
export type NotificationSink = (input: { eventKey: string; customerRef: string; text: string }) => void

function validate(input: CreateHoldInput): void {
  if (!input.organizationId || !input.tripId || !input.customerRef || !input.idempotencyKey) {
    throw new Error('organizationId, tripId, customerRef, and idempotencyKey are required')
  }
  if (!Number.isInteger(input.seatCount) || input.seatCount < 1) {
    throw new Error('seatCount must be a positive integer')
  }
}

const store: HoldStore = {
  async create(input) {
    const now = input.now ?? new Date()
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const trip = await client.query<{ id: string; seatQuota: number }>(
        `SELECT id, "seatQuota" AS "seatQuota"
         FROM "trip"
         WHERE id = $1
           AND "organizationId" = $2
           AND status = 'PUBLISHED'
           AND "departureAt" > $3
         FOR UPDATE`,
        [input.tripId, input.organizationId, now],
      )
      if (!trip.rows[0]) throw new Error('Trip is not available')

      const existing = await client.query<Hold>(
        `SELECT id, "organizationId", "tripId", "customerRef", "seatCount", status, "expiresAt"
         FROM "hold"
         WHERE "organizationId" = $1 AND "customerRef" = $2 AND "idempotencyKey" = $3`,
        [input.organizationId, input.customerRef, input.idempotencyKey],
      )
      if (existing.rows[0]) {
        await client.query('COMMIT')
        return existing.rows[0]
      }

      await client.query(
        `UPDATE "hold"
         SET status = 'EXPIRED', "updatedAt" = $2
         WHERE "organizationId" = $1 AND status = 'ACTIVE' AND "expiresAt" <= $2`,
        [input.organizationId, now],
      )
      const reserved = await client.query<{ seats: number }>(
        `SELECT COALESCE(SUM("seatCount"), 0)::int AS seats
         FROM "hold"
         WHERE "organizationId" = $1 AND "tripId" = $2 AND status = 'ACTIVE' AND "expiresAt" > $3`,
        [input.organizationId, input.tripId, now],
      )
      if ((reserved.rows[0]?.seats ?? 0) + input.seatCount > trip.rows[0].seatQuota) {
        throw new Error('Not enough seats available')
      }

      const hold = {
        id: ulid(),
        expiresAt: new Date(now.getTime() + HOLD_TTL_MS),
      }
      const result = await client.query<Hold>(
        `INSERT INTO "hold" (id, "organizationId", "tripId", "customerRef", "seatCount", status, "expiresAt", "idempotencyKey", "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, 'ACTIVE', $6, $7, $8, $8)
         RETURNING id, "organizationId", "tripId", "customerRef", "seatCount", status, "expiresAt"`,
        [hold.id, input.organizationId, input.tripId, input.customerRef, input.seatCount, hold.expiresAt, input.idempotencyKey, now],
      )
      await client.query('COMMIT')
      return result.rows[0]
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  },

  async expire(organizationId, now) {
    const result = await pool.query(
      `UPDATE "hold" SET status = 'EXPIRED', "updatedAt" = $2
       WHERE "organizationId" = $1 AND status = 'ACTIVE' AND "expiresAt" <= $2`,
      [organizationId, now],
    )
    return result.rowCount ?? 0
  },

  async find(organizationId, id) {
    const result = await pool.query<Hold>(
      `SELECT id, "organizationId", "tripId", "customerRef", "seatCount", status, "expiresAt"
       FROM "hold" WHERE id = $1 AND "organizationId" = $2`,
      [id, organizationId],
    )
    return result.rows[0] ?? null
  },
}

export function createHoldService(holdStore: HoldStore = store, notify: NotificationSink = notifyWhatsApp) {
  return {
    async create(input: CreateHoldInput): Promise<Hold> {
      validate(input)
      const hold = await holdStore.create(input)
      notify({ eventKey: `hold:${hold.id}`, customerRef: hold.customerRef, text: `Your Hold ${hold.id} is active until ${hold.expiresAt.toISOString()}.` })
      return hold
    },

    expire(organizationId: string, now = new Date()): Promise<number> {
      return holdStore.expire(organizationId, now)
    },

    async get(organizationId: string, id: string, now = new Date()): Promise<Hold | null> {
      const hold = await holdStore.find(organizationId, id)
      if (hold?.status === 'ACTIVE' && hold.expiresAt <= now) {
        await holdStore.expire(organizationId, now)
        return { ...hold, status: 'EXPIRED' }
      }
      return hold
    },
  }
}

export const holds = createHoldService()
