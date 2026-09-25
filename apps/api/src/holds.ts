import { pool } from '@repo/db'
import { ulid } from 'ulid'
import { notifyWhatsApp } from './notifications'
import { RESERVED_SEATS_BY_TRIP } from './reserved-seats'

export type HoldStatus = 'ACTIVE' | 'EXPIRED' | 'CANCELLED'

export type Hold = {
  id: string
  organizationId: string
  tripId: string
  customerRef: string
  seatCount: number
  priceAtHold: number | null
  currencyAtHold: string | null
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
  cancel(organizationId: string, id: string, customerRef: string, now: Date): Promise<Hold | null>
}

export const HOLD_TTL_MS = 15 * 60 * 1000
export type NotificationSink = (input: { eventKey: string; customerRef: string; text: string }) => void

const EXPIRE_UNPAID_HOLDS_SQL = `UPDATE "hold" h SET status = 'EXPIRED', "updatedAt" = $2
  WHERE h."organizationId" = $1 AND h.status = 'ACTIVE' AND h."expiresAt" <= $2
    AND NOT EXISTS (
      SELECT 1 FROM "payment" p
      WHERE p."organizationId" = h."organizationId" AND p."holdId" = h.id AND p.status = 'PENDING'
    )
  RETURNING h.id, h."customerRef"`

type HoldAuditEntry = { id: string; customerRef: string }
type Queryable = { query(text: string, values?: unknown[]): Promise<unknown> }

async function auditHoldChanges(
  client: Queryable,
  organizationId: string,
  action: 'hold.created' | 'hold.expired' | 'hold.cancelled',
  holds: HoldAuditEntry[],
  now: Date,
): Promise<void> {
  for (let start = 0; start < holds.length; start += 1000) {
    const values: unknown[] = []
    const rows = holds.slice(start, start + 1000).map((hold) => {
      const offset = values.length
      values.push(ulid(), organizationId, action, hold.id, JSON.stringify({ customerRef: hold.customerRef }), now)
      return `($${offset + 1}, $${offset + 2}, $${offset + 3}, 'Hold', $${offset + 4}, $${offset + 5}, $${offset + 6})`
    })
    if (rows.length) {
      await client.query(
        `INSERT INTO "auditEvent" (id, "organizationId", action, "entityType", "entityId", metadata, "createdAt") VALUES ${rows.join(', ')}`,
        values,
      )
    }
  }
}

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
      const trip = await client.query<{ id: string; seatQuota: number; price: number; currency: string }>(
        `SELECT id, "seatQuota" AS "seatQuota", price, currency
         FROM "trip"
         WHERE id = $1
           AND "organizationId" = $2
           AND status = 'PUBLISHED'
           AND "departureAt" > $3
         FOR UPDATE`,
        [input.tripId, input.organizationId, now],
      )
      if (!trip.rows[0]) throw new Error('Trip is not available')

      const expired = await client.query<HoldAuditEntry>(EXPIRE_UNPAID_HOLDS_SQL, [input.organizationId, now])
      await auditHoldChanges(client, input.organizationId, 'hold.expired', expired.rows, now)
      const existing = await client.query<Hold>(
        `SELECT id, "organizationId", "tripId", "customerRef", "seatCount", "priceAtHold", "currencyAtHold", status, "expiresAt"
         FROM "hold"
         WHERE "organizationId" = $1 AND "customerRef" = $2 AND "idempotencyKey" = $3`,
        [input.organizationId, input.customerRef, input.idempotencyKey],
      )
      if (existing.rows[0]) {
        await client.query('COMMIT')
        return existing.rows[0]
      }

      const reserved = await client.query<{ seats: number }>(
        `SELECT seats FROM (${RESERVED_SEATS_BY_TRIP}) reserved
         WHERE reserved."organizationId" = $2 AND reserved."tripId" = $3`,
        [now, input.organizationId, input.tripId],
      )
      if ((reserved.rows[0]?.seats ?? 0) + input.seatCount > trip.rows[0].seatQuota) {
        throw new Error('Not enough seats available')
      }

      const hold = {
        id: ulid(),
        expiresAt: new Date(now.getTime() + HOLD_TTL_MS),
      }
      const result = await client.query<Hold>(
        `INSERT INTO "hold" (id, "organizationId", "tripId", "customerRef", "seatCount", "priceAtHold", "currencyAtHold", status, "expiresAt", "idempotencyKey", "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'ACTIVE', $8, $9, $10, $10)
         RETURNING id, "organizationId", "tripId", "customerRef", "seatCount", "priceAtHold", "currencyAtHold", status, "expiresAt"`,
        [hold.id, input.organizationId, input.tripId, input.customerRef, input.seatCount, trip.rows[0].price, trip.rows[0].currency, hold.expiresAt, input.idempotencyKey, now],
      )
      await auditHoldChanges(client, input.organizationId, 'hold.created', [result.rows[0]], now)
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
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const expired = await client.query<HoldAuditEntry>(EXPIRE_UNPAID_HOLDS_SQL, [organizationId, now])
      await auditHoldChanges(client, organizationId, 'hold.expired', expired.rows, now)
      await client.query('COMMIT')
      return expired.rows.length
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  },

  async find(organizationId, id) {
    const result = await pool.query<Hold>(
      `SELECT id, "organizationId", "tripId", "customerRef", "seatCount", "priceAtHold", "currencyAtHold", status, "expiresAt"
       FROM "hold" WHERE id = $1 AND "organizationId" = $2`,
      [id, organizationId],
    )
    return result.rows[0] ?? null
  },

  async cancel(organizationId, id, customerRef, now) {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const current = await client.query<Hold>(
        `SELECT h.id, h."organizationId", h."tripId", h."customerRef", h."seatCount", h."priceAtHold", h."currencyAtHold", h.status, h."expiresAt"
         FROM "hold" h
         WHERE h.id = $1 AND h."organizationId" = $2 AND h."customerRef" = $3
         FOR UPDATE`,
        [id, organizationId, customerRef],
      )
      if (!current.rows[0]) {
        await client.query('COMMIT')
        return null
      }
      if (current.rows[0].status === 'CANCELLED') {
        await client.query('COMMIT')
        return current.rows[0]
      }
      if (current.rows[0].status !== 'ACTIVE' || current.rows[0].expiresAt <= now) {
        throw new Error('Hold is no longer cancellable')
      }
      const eligibility = await client.query<{ hasPayment: boolean; hasBooking: boolean }>(
        `SELECT
           EXISTS (SELECT 1 FROM "payment" p WHERE p."organizationId" = $1 AND p."holdId" = $2) AS "hasPayment",
           EXISTS (SELECT 1 FROM "booking" b WHERE b."organizationId" = $1 AND b."holdId" = $2) AS "hasBooking"`,
        [organizationId, id],
      )
      if (eligibility.rows[0]?.hasPayment || eligibility.rows[0]?.hasBooking) {
        throw new Error('Hold has a Payment or Booking and cannot be canceled')
      }
      const cancelled = await client.query<Hold>(
        `UPDATE "hold" SET status = 'CANCELLED', "updatedAt" = $3
         WHERE id = $1 AND "organizationId" = $2
         RETURNING id, "organizationId", "tripId", "customerRef", "seatCount", "priceAtHold", "currencyAtHold", status, "expiresAt"`,
        [id, organizationId, now],
      )
      await auditHoldChanges(client, organizationId, 'hold.cancelled', [cancelled.rows[0]], now)
      await client.query('COMMIT')
      return cancelled.rows[0]
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
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

    cancel(organizationId: string, id: string, customerRef: string, now = new Date()): Promise<Hold | null> {
      if (!organizationId || !id || !customerRef) throw new Error('organizationId, id, and customerRef are required')
      return holdStore.cancel(organizationId, id, customerRef, now)
    },

    async get(organizationId: string, id: string, now = new Date()): Promise<Hold | null> {
      const hold = await holdStore.find(organizationId, id)
      if (hold?.status === 'ACTIVE' && hold.expiresAt <= now) {
        await holdStore.expire(organizationId, now)
        return holdStore.find(organizationId, id)
      }
      return hold
    },
  }
}

export const holds = createHoldService()
