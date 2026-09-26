import { pool, zenstack } from '@repo/db'
import type { PaymentStatus } from './payments'

export type DashboardActor = { userId: string; organizationId: string }

export type OperationsSummary = {
  trips: Array<{ id: string; origin: string; destination: string; departureAt: Date; status: string; seatQuota: number; vehicleName: string | null; plateNumber: string | null; vehicleStatus: string | null }>
  activeHolds: Array<{ id: string; tripId: string; customerRef: string; seatCount: number; expiresAt: Date }>
  confirmedBookings: Array<{ id: string; tripId: string; customerRef: string; seatCount: number; confirmedAt: Date | null; invoiceAmount: number | null; currency: string | null }>
  vehicles: Array<{ id: string; name: string; plateNumber: string; status: string }>
}

export type MoneyflowSummary = {
  payments: Record<PaymentStatus, number>
  invoiceCount: number
  confirmedAmount: number
  invoices: Array<{ id: string; bookingId: string; amount: number; currency: string; issuedAt: Date }>
  auditEvents: Array<{ id: string; actorId: string | null; action: string; entityType: string; entityId: string; createdAt: Date }>
}

export type DashboardStore = {
  isOwner(userId: string, organizationId: string): Promise<boolean>
  operations(organizationId: string, now: Date): Promise<OperationsSummary>
  moneyflow(organizationId: string): Promise<MoneyflowSummary>
}

const store: DashboardStore = {
  isOwner: async (userId, organizationId) => Boolean(await zenstack.member.findFirst({
    where: { userId, organizationId, role: 'owner' },
    select: { id: true },
  })),

  async operations(organizationId, now) {
    const [trips, activeHolds, confirmedBookings, vehicles] = await Promise.all([
      pool.query<OperationsSummary['trips'][number]>(
        `SELECT t.id, t.origin, t.destination, t."departureAt", t.status, t."seatQuota",
                v.name AS "vehicleName", v."plateNumber", v.status AS "vehicleStatus"
         FROM "trip" t LEFT JOIN "vehicle" v ON v.id = t."vehicleId"
         WHERE t."organizationId" = $1 ORDER BY t."departureAt" ASC`,
        [organizationId],
      ),
      pool.query<OperationsSummary['activeHolds'][number]>(
        `SELECT id, "tripId", "customerRef", "seatCount", "expiresAt"
         FROM "hold" WHERE "organizationId" = $1 AND status = 'ACTIVE' AND "expiresAt" > $2
         ORDER BY "expiresAt" ASC`,
        [organizationId, now],
      ),
      pool.query<OperationsSummary['confirmedBookings'][number]>(
        `SELECT b.id, b."tripId", b."customerRef", b."seatCount", b."confirmedAt",
                i.amount AS "invoiceAmount", i.currency
         FROM "booking" b LEFT JOIN "invoice" i ON i."bookingId" = b.id
         WHERE b."organizationId" = $1 AND b.status = 'CONFIRMED'
         ORDER BY b."confirmedAt" DESC`,
        [organizationId],
      ),
      pool.query<OperationsSummary['vehicles'][number]>(
        `SELECT id, name, "plateNumber", status FROM "vehicle"
         WHERE "organizationId" = $1 ORDER BY name ASC`,
        [organizationId],
      ),
    ])
    return { trips: trips.rows, activeHolds: activeHolds.rows, confirmedBookings: confirmedBookings.rows, vehicles: vehicles.rows }
  },

  async moneyflow(organizationId) {
    const [payments, invoices, invoiceTotal, auditEvents] = await Promise.all([
      pool.query<{ status: PaymentStatus; count: number }>(
        `SELECT status, COUNT(*)::int AS count FROM "payment" WHERE "organizationId" = $1 GROUP BY status`,
        [organizationId],
      ),
      pool.query<MoneyflowSummary['invoices'][number]>(
        `SELECT id, "bookingId", amount, currency, "issuedAt" FROM "invoice"
         WHERE "organizationId" = $1 ORDER BY "issuedAt" DESC`,
        [organizationId],
      ),
      pool.query<{ count: number; total: number }>(
        `SELECT COUNT(*)::int AS count, COALESCE(SUM(amount), 0)::int AS total
         FROM "invoice" WHERE "organizationId" = $1`,
        [organizationId],
      ),
      pool.query<MoneyflowSummary['auditEvents'][number]>(
        `SELECT id, "actorId", action, "entityType", "entityId", "createdAt"
         FROM "auditEvent" WHERE "organizationId" = $1 ORDER BY "createdAt" DESC LIMIT 100`,
        [organizationId],
      ),
    ])
    const paymentSummary: Record<PaymentStatus, number> = { PENDING: 0, APPROVED: 0, REJECTED: 0, REFUND_PENDING: 0, REFUNDED: 0 }
    for (const row of payments.rows) paymentSummary[row.status] = row.count
    return {
      payments: paymentSummary,
      invoiceCount: invoiceTotal.rows[0]?.count ?? 0,
      confirmedAmount: invoiceTotal.rows[0]?.total ?? 0,
      invoices: invoices.rows,
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
