import { pool, zenstack } from '@repo/db'
import { ulid } from 'ulid'

export type BookingStatus = 'CONFIRMED' | 'PAYMENT_REJECTED'

export type Invoice = {
  id: string
  bookingId: string
  amount: number
  currency: string
  status: 'ISSUED'
  issuedAt: Date
}

export type Booking = {
  id: string
  organizationId: string
  holdId: string
  tripId: string
  paymentId: string
  customerRef: string
  seatCount: number
  status: BookingStatus
  confirmedAt: Date | null
  invoice: Invoice | null
}

export type BookingActor = { userId: string; organizationId: string }

export function invoiceAmount(price: number, seatCount: number): number {
  if (!Number.isInteger(price) || price < 0 || !Number.isInteger(seatCount) || seatCount < 1) {
    throw new Error('price and seatCount must be valid integers')
  }
  return price * seatCount
}

type MaterializeInput = {
  paymentId: string
  organizationId: string
  status: 'CONFIRMED' | 'PAYMENT_REJECTED'
  actorId: string
  now: Date
}

type DbClient = {
  query<T>(text: string, values?: unknown[]): Promise<{ rows: T[] }>
}

export async function materializeBooking(client: DbClient, input: MaterializeInput): Promise<Booking> {
  const source = await client.query<{
    holdId: string
    tripId: string
    customerRef: string
    seatCount: number
    price: number
    currency: string
    holdStatus: string
    expiresAt: Date
  }>(
    `SELECT p."holdId", h."tripId", p."customerRef", h."seatCount", t.price, t.currency, h.status AS "holdStatus", h."expiresAt"
     FROM "payment" p
     JOIN "hold" h ON h.id = p."holdId"
     JOIN "trip" t ON t.id = h."tripId"
     WHERE p.id = $1 AND p."organizationId" = $2
     FOR UPDATE`,
    [input.paymentId, input.organizationId],
  )
  if (!source.rows[0]) throw new Error('Payment not found')
  const row = source.rows[0]
  if (input.status === 'CONFIRMED' && (row.holdStatus !== 'ACTIVE' || row.expiresAt <= input.now)) {
    throw new Error('Hold is no longer eligible for Booking confirmation')
  }
  const created = await client.query<Booking>(
    `INSERT INTO "booking" (id, "organizationId", "holdId", "tripId", "paymentId", "customerRef", "seatCount", status, "confirmedAt", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)
     ON CONFLICT ("paymentId") DO NOTHING
     RETURNING id, "organizationId", "holdId", "tripId", "paymentId", "customerRef", "seatCount", status, "confirmedAt"`,
    [ulid(), input.organizationId, row.holdId, row.tripId, input.paymentId, row.customerRef, row.seatCount, input.status, input.status === 'CONFIRMED' ? input.now : null, input.now],
  )
  const booking = created.rows[0] ?? (await client.query<Booking>(
    `SELECT id, "organizationId", "holdId", "tripId", "paymentId", "customerRef", "seatCount", status, "confirmedAt"
     FROM "booking" WHERE "paymentId" = $1 AND "organizationId" = $2`,
    [input.paymentId, input.organizationId],
  )).rows[0]
  if (!booking) throw new Error('Booking could not be created')

  let invoice: Invoice | null = null
  if (input.status === 'CONFIRMED') {
    const invoiceResult = await client.query<Invoice>(
      `INSERT INTO "invoice" (id, "organizationId", "bookingId", amount, currency, status, "issuedAt", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, 'ISSUED', $6, $6, $6)
       ON CONFLICT ("bookingId") DO NOTHING
       RETURNING id, "bookingId", amount, currency, status, "issuedAt"`,
      [ulid(), input.organizationId, booking.id, invoiceAmount(row.price, row.seatCount), row.currency, input.now],
    )
    invoice = invoiceResult.rows[0] ?? (await client.query<Invoice>(
      `SELECT id, "bookingId", amount, currency, status, "issuedAt" FROM "invoice" WHERE "bookingId" = $1`,
      [booking.id],
    )).rows[0] ?? null
  }

  await client.query(
    `INSERT INTO "auditEvent" (id, "organizationId", "actorId", action, "entityType", "entityId", metadata, "createdAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [ulid(), input.organizationId, input.actorId, input.status === 'CONFIRMED' ? 'booking.confirmed' : 'payment.rejected', input.status === 'CONFIRMED' ? 'Booking' : 'Payment', input.status === 'CONFIRMED' ? booking.id : input.paymentId, JSON.stringify({ paymentId: input.paymentId }), input.now],
  )
  return { ...booking, invoice }
}

function mapBooking(row: Booking & { invoiceId?: string; invoiceAmount?: number; invoiceCurrency?: string; invoiceStatus?: 'ISSUED'; invoiceIssuedAt?: Date }): Booking {
  return {
    ...row,
    invoice: row.invoiceId ? {
      id: row.invoiceId,
      bookingId: row.id,
      amount: row.invoiceAmount!,
      currency: row.invoiceCurrency!,
      status: row.invoiceStatus!,
      issuedAt: row.invoiceIssuedAt!,
    } : null,
  }
}

const SELECT_BOOKING = `SELECT b.id, b."organizationId", b."holdId", b."tripId", b."paymentId", b."customerRef", b."seatCount", b.status, b."confirmedAt",
  i.id AS "invoiceId", i.amount AS "invoiceAmount", i.currency AS "invoiceCurrency", i.status AS "invoiceStatus", i."issuedAt" AS "invoiceIssuedAt"
  FROM "booking" b LEFT JOIN "invoice" i ON i."bookingId" = b.id`

export function createBookingService() {
  return {
    async getForCustomer(organizationId: string, customerRef: string, id: string): Promise<Booking | null> {
      const result = await pool.query<Booking & { invoiceId?: string; invoiceAmount?: number; invoiceCurrency?: string; invoiceStatus?: 'ISSUED'; invoiceIssuedAt?: Date }>(
        `${SELECT_BOOKING} WHERE b.id = $1 AND b."organizationId" = $2 AND b."customerRef" = $3`,
        [id, organizationId, customerRef],
      )
      return result.rows[0] ? mapBooking(result.rows[0]) : null
    },

    async listOwner(actor: BookingActor): Promise<Booking[]> {
      const owner = await zenstack.member.findFirst({ where: { userId: actor.userId, organizationId: actor.organizationId, role: 'owner' }, select: { id: true } })
      if (!owner) throw new Error('Owner access required')
      const result = await pool.query<Booking & { invoiceId?: string; invoiceAmount?: number; invoiceCurrency?: string; invoiceStatus?: 'ISSUED'; invoiceIssuedAt?: Date }>(
        `${SELECT_BOOKING} WHERE b."organizationId" = $1 AND b.status = 'CONFIRMED' ORDER BY b."createdAt" DESC`,
        [actor.organizationId],
      )
      return result.rows.map(mapBooking)
    },
  }
}

export const bookings = createBookingService()
