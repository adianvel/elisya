import { describe, expect, it } from 'bun:test'
import { createDashboardService, type DashboardStore, type MoneyflowSummary, type OperationsSummary } from './dashboard'

const operations: OperationsSummary = {
  trips: [], activeHolds: [], confirmedBookings: [], pendingPaymentReviews: [], cancellationCases: [], vehicles: [],
}
const moneyflow: MoneyflowSummary = {
  payments: { PENDING: 1, APPROVED: 2, REJECTED: 0, REFUND_PENDING: 0, REFUNDED: 0 },
  invoiceCount: 2,
  invoiceTotals: [{ currency: 'IDR', count: 2, amount: 300000 }],
  approvedPaymentTotals: [{ currency: 'IDR', count: 2, amount: 300000 }],
  refundTotals: [],
  invoices: [],
  refunds: [],
  auditEvents: [],
}

function fakeStore(): DashboardStore {
  return {
    isOwner: async (userId, organizationId) => userId === 'owner-1' && organizationId === 'org-1',
    operations: async () => operations,
    moneyflow: async () => moneyflow,
  }
}

describe('Owner dashboard service', () => {
  it('returns organization-scoped operational and moneyflow summaries', async () => {
    const service = createDashboardService(fakeStore())
    expect(await service.operations({ userId: 'owner-1', organizationId: 'org-1' })).toBe(operations)
    expect(await service.moneyflow({ userId: 'owner-1', organizationId: 'org-1' })).toBe(moneyflow)
  })

  it('rejects non-Owners and Owners from another Travel business', async () => {
    const service = createDashboardService(fakeStore())
    await expect(service.operations({ userId: 'customer-1', organizationId: 'org-1' })).rejects.toThrow('Owner access required')
    await expect(service.moneyflow({ userId: 'owner-1', organizationId: 'org-2' })).rejects.toThrow('Owner access required')
  })
})
