import { describe, expect, it } from 'bun:test'
import { createPaymentService, type PaymentRecord, type PaymentStore } from './payments'

function fakeStore(): PaymentStore {
  const rows: PaymentRecord[] = []
  return {
    isOwner: async (userId, organizationId) => userId === 'owner-1' && organizationId === 'org-1',
    submit: async (input) => {
      const existing = rows.find((row) => row.organizationId === input.organizationId && row.customerRef === input.customerRef && row.id === input.idempotencyKey)
      if (existing) return existing
      const row: PaymentRecord = {
        id: input.idempotencyKey,
        organizationId: input.organizationId,
        holdId: input.holdId,
        customerRef: input.customerRef,
        proofKey: input.proofKey,
        status: 'PENDING',
        rejectionReason: null,
        submittedAt: input.now ?? new Date(),
        reviewedAt: null,
      }
      rows.push(row)
      return row
    },
    listPending: async (organizationId) => rows.filter((row) => row.organizationId === organizationId && row.status === 'PENDING'),
    review: async (actor, id, review, now) => {
      const row = rows.find((item) => item.organizationId === actor.organizationId && item.id === id && item.status === 'PENDING')
      if (!row) throw new Error('Pending Payment not found')
      row.status = review.status
      row.rejectionReason = review.status === 'REJECTED' ? review.reason ?? null : null
      row.reviewedAt = now
      return row
    },
    proofKey: async (organizationId, id) => rows.find((row) => row.organizationId === organizationId && row.id === id)?.proofKey ?? null,
  }
}

const input = { organizationId: 'org-1', holdId: 'hold-1', customerRef: '+6281', proofKey: 'payments/proof.jpg', idempotencyKey: 'payment-1' }

describe('Payment service', () => {
  it('submits valid proof without exposing the protected storage key and retries idempotently', async () => {
    const service = createPaymentService(fakeStore())
    const first = await service.submit(input)
    const retry = await service.submit(input)
    expect(first).toEqual(retry)
    expect(first.status).toBe('PENDING')
    expect(first).not.toHaveProperty('proofKey')
  })

  it('rejects invalid proof keys', async () => {
    const service = createPaymentService(fakeStore())
    await expect(service.submit({ ...input, proofKey: '../private.jpg' })).rejects.toThrow('proofKey is invalid')
  })

  it('allows only an Owner in the same Travel business to review Payment', async () => {
    const service = createPaymentService(fakeStore())
    const payment = await service.submit(input)
    await expect(service.review({ userId: 'customer-1', organizationId: 'org-1' }, payment.id, { status: 'APPROVED' })).rejects.toThrow('Owner access required')
    await expect(service.listPending({ userId: 'owner-1', organizationId: 'org-2' })).rejects.toThrow('Owner access required')
    const approved = await service.review({ userId: 'owner-1', organizationId: 'org-1' }, payment.id, { status: 'APPROVED' })
    expect(approved.status).toBe('APPROVED')
  })

  it('requires a rejection reason and records it', async () => {
    const service = createPaymentService(fakeStore())
    const payment = await service.submit({ ...input, idempotencyKey: 'payment-2' })
    await expect(service.review({ userId: 'owner-1', organizationId: 'org-1' }, payment.id, { status: 'REJECTED' })).rejects.toThrow('Rejection reason is required')
    const rejected = await service.review({ userId: 'owner-1', organizationId: 'org-1' }, payment.id, { status: 'REJECTED', reason: 'Amount does not match' })
    expect(rejected).toMatchObject({ status: 'REJECTED', rejectionReason: 'Amount does not match' })
  })
})
