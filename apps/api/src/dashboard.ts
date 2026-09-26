import { pool } from '@repo/db'
import { isAuthorizedOwner } from './authz'
import type { CancellationRequest, Refund } from './cancellations'
import type { PaymentStatus } from './payments'
import { RESERVED_SEATS_BY_TRIP } from './reserved-seats'

export type DashboardActor = { userId: string; organizationId: string }
export type OperationsSummary = {
  trips: Array<{
    id: string
    origin: string
    destination: string
    departureAt: Date
    status: string
    seatQuota: number
    reservedSeats: number
    remainingSeats: number
    vehicleId: string | null
    vehicleName: string | null
    plateNumber: string | null
    vehicleStatus: string | null
  }>
  activeHolds: Array<{ id: string; tripId: string; customerRef: string; seatCount: number; expiresAt: Date }>
  confirmedBookings: Array<{ id: string; tripId: string; customerRef: string; seatCount: number; confirmedAt: Date | null; invoiceAmount: number | null; currency: string | null }>
  pendingPaymentReviews: Array<{ id: string; holdId: string; tripId: string; customerRef: string; submittedAt: Date; origin: string; destination: string }>
  cancellationCases: Array<Pick<CancellationRequest, 'id' | 'bookingId' | 'paymentId' | 'customerRef' | 'source' | 'status' | 'requestedAt'>>
  vehicles: Array<{ id: string; name: string; plateNumber: string; status: string }>
}

export type CurrencyTotal = { currency: string; count: number; amount: number }
export type MoneyflowSummary = {
  payments: Record<PaymentStatus, number>
  invoiceCount: number
  invoiceTotals: CurrencyTotal[]
  approvedPaymentTotals: CurrencyTotal[]
  refundTotals: Array<CurrencyTotal & { status: Refund['status'] }>
  invoices: Array<{ id: string; bookingId: string; amount: number; currency: string; issuedAt: Date }>
  refunds: Refund[]
  auditEvents: Array<{ id: string; actorId: string | null; actorName: string | null; action: string; entityType: string; entityId: string; createdAt: Date }>
}

export type DashboardStore = {
  isOwner(userId: string, organizationId: string): Promise<boolean>
  operations(organizationId: string, now: Date): Promise<OperationsSummary>
  moneyflow(organizationId: string): Promise<MoneyflowSummary>
}

const store: DashboardStore = {
  isOwner: isAuthorizedOwner,

  async operations(organizationId, now) {
    const [trips, activeHolds, confirmedBookings, pendingPaymentReviews, cancellationCases, vehicles] = await Promise.all([
      pool.query<OperationsSummary['trips'][number]>(
        `SELECT t.id, t.origin, t.destination, t."departureAt", t.status, t."seatQuota", t."vehicleId",
                COALESCE(reserved.seats, 0)::int AS "reservedSeats",
                GREATEST(t."seatQuota" - COALESCE(reserved.seats, 0), 0)::int AS "remainingSeats",
                v.name AS "vehicleName", v."plateNumber", v.status AS "vehicleStatus"
         FROM "trip" t
         LEFT JOIN (${RESERVED_SEATS_BY_TRIP}) reserved
           ON reserved."organizationId" = t."organizationId" AND reserved."tripId" = t.id
         LEFT JOIN "vehicle" v ON v.id = t."vehicleId" AND v."organizationId" = t."organizationId"
         WHERE t."organizationId" = $2 ORDER BY t."departureAt" ASC`,
        [now, organizationId],
      ),
      pool.query<OperationsSummary['activeHolds'][number]>(
        `SELECT id, "tripId", "customerRef", "seatCount", "expiresAt"
         FROM "hold" h WHERE "organizationId" = $1 AND status = 'ACTIVE' AND "expiresAt" > $2
           AND NOT EXISTS (SELECT 1 FROM "booking" b WHERE b."holdId" = h.id AND b."organizationId" = h."organizationId" AND b.status = 'CONFIRMED')
         ORDER BY "expiresAt" ASC`,
        [organizationId, now],
      ),
      pool.query<OperationsSummary['confirmedBookings'][number]>(
        `SELECT b.id, b."tripId", b."customerRef", b."seatCount", b."confirmedAt",
                i.amount AS "invoiceAmount", i.currency
         FROM "booking" b LEFT JOIN "invoice" i ON i."bookingId" = b.id AND i."organizationId" = b."organizationId"
         WHERE b."organizationId" = $1 AND b.status = 'CONFIRMED'
         ORDER BY b."confirmedAt" DESC`,
        [organizationId],
      ),
      pool.query<OperationsSummary['pendingPaymentReviews'][number]>(
        `SELECT p.id, p."holdId", h."tripId", p."customerRef", p."submittedAt", t.origin, t.destination
         FROM "payment" p
         JOIN "hold" h ON h.id = p."holdId" AND h."organizationId" = p."organizationId"
         JOIN "trip" t ON t.id = h."tripId" AND t."organizationId" = h."organizationId"
         WHERE p."organizationId" = $1 AND p.status = 'PENDING' ORDER BY p."submittedAt" ASC`,
        [organizationId],
      ),
      pool.query<OperationsSummary['cancellationCases'][number]>(
        `SELECT id, "bookingId", "paymentId", "customerRef", source, status, "requestedAt"
         FROM "cancellationRequest" WHERE "organizationId" = $1 AND status = 'PENDING'
         ORDER BY "requestedAt" ASC`,
        [organizationId],
      ),
      pool.query<OperationsSummary['vehicles'][number]>(
        `SELECT id, name, "plateNumber", status FROM "vehicle"
         WHERE "organizationId" = $1 ORDER BY name ASC`,
        [organizationId],
      ),
    ])
    return {
      trips: trips.rows,
      activeHolds: activeHolds.rows,
      confirmedBookings: confirmedBookings.rows,
      pendingPaymentReviews: pendingPaymentReviews.rows,
      cancellationCases: cancellationCases.rows,
      vehicles: vehicles.rows,
    }
  },

  async moneyflow(organizationId) {
    const [payments, invoices, invoiceTotals, approvedPaymentTotals, refundTotals, refunds, auditEvents] = await Promise.all([
      pool.query<{ status: PaymentStatus; count: number }>(
        `SELECT status, COUNT(*)::int AS count FROM "payment" WHERE "organizationId" = $1 GROUP BY status`,
        [organizationId],
      ),
      pool.query<MoneyflowSummary['invoices'][number]>(
        `SELECT id, "bookingId", amount, currency, "issuedAt" FROM "invoice"
         WHERE "organizationId" = $1 ORDER BY "issuedAt" DESC LIMIT 100`,
        [organizationId],
      ),
      pool.query<{ currency: string; count: number; amount: string }>(
        `SELECT currency, COUNT(*)::int AS count, COALESCE(SUM(amount), 0)::text AS amount
         FROM "invoice" WHERE "organizationId" = $1 GROUP BY currency ORDER BY currency`,
        [organizationId],
      ),
      pool.query<{ currency: string; count: number; amount: string }>(
        `SELECT COALESCE(h."currencyAtHold", t.currency) AS currency, COUNT(*)::int AS count,
                COALESCE(SUM(COALESCE(h."priceAtHold", t.price)::numeric * h."seatCount"), 0)::text AS amount
         FROM "payment" p
         JOIN "hold" h ON h.id = p."holdId" AND h."organizationId" = p."organizationId"
         JOIN "trip" t ON t.id = h."tripId" AND t."organizationId" = h."organizationId"
         WHERE p."organizationId" = $1 AND p.status = 'APPROVED'
         GROUP BY COALESCE(h."currencyAtHold", t.currency) ORDER BY currency`,
        [organizationId],
      ),
      pool.query<{ status: Refund['status']; currency: string; count: number; amount: string }>(
        `SELECT status, currency, COUNT(*)::int AS count, COALESCE(SUM(amount), 0)::text AS amount
         FROM "refund" WHERE "organizationId" = $1 GROUP BY status, currency ORDER BY status, currency`,
        [organizationId],
      ),
      pool.query<Refund>(
        `SELECT id, "organizationId", "bookingId", "paymentId", "customerRef", amount, currency, status,
                "transferredAt", "transferReference", "recordedBy", "createdAt", "updatedAt"
         FROM "refund" WHERE "organizationId" = $1 ORDER BY "createdAt" DESC LIMIT 100`,
        [organizationId],
      ),
      pool.query<MoneyflowSummary['auditEvents'][number]>(
        `SELECT a.id, a."actorId", COALESCE(u.name, u.email) AS "actorName", a.action, a."entityType", a."entityId", a."createdAt"
         FROM "auditEvent" a LEFT JOIN "user" u ON u.id = a."actorId"
         WHERE a."organizationId" = $1 ORDER BY a."createdAt" DESC LIMIT 100`,
        [organizationId],
      ),
    ])
    const paymentSummary: Record<PaymentStatus, number> = { PENDING: 0, APPROVED: 0, REJECTED: 0, REFUND_PENDING: 0, REFUNDED: 0 }
    for (const row of payments.rows) paymentSummary[row.status] = row.count
    return {
      payments: paymentSummary,
      invoiceCount: invoiceTotals.rows.reduce((count, row) => count + row.count, 0),
      invoiceTotals: invoiceTotals.rows.map((row) => ({ ...row, amount: Number(row.amount) })),
      approvedPaymentTotals: approvedPaymentTotals.rows.map((row) => ({ ...row, amount: Number(row.amount) })),
      refundTotals: refundTotals.rows.map((row) => ({ ...row, amount: Number(row.amount) })),
      invoices: invoices.rows,
      refunds: refunds.rows,
      auditEvents: auditEvents.rows,
    }
  },
}

async function requireOwner(actor: DashboardActor, dashboardStore: DashboardStore): Promise<void> {
  if (!await dashboardStore.isOwner(actor.userId, actor.organizationId)) throw new Error('Owner access required')
}

export function createDashboardService(dashboardStore: DashboardStore = store) {
  return {
    async operations(actor: DashboardActor, now = new Date()): Promise<OperationsSummary> {
      await requireOwner(actor, dashboardStore)
      return dashboardStore.operations(actor.organizationId, now)
    },
    async moneyflow(actor: DashboardActor): Promise<MoneyflowSummary> {
      await requireOwner(actor, dashboardStore)
      return dashboardStore.moneyflow(actor.organizationId)
    },
  }
}

export const dashboard = createDashboardService()
