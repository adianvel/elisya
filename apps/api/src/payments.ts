import { persistWhatsAppNotification, pool, zenstack } from '@repo/db'
import { ulid } from 'ulid'
import { materializeBooking } from './bookings'
import { notifyWhatsApp } from './notifications'
import type { NotificationSink } from './holds'

export type PaymentStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'REFUND_PENDING' | 'REFUNDED'

export type Payment = {
  id: string
  organizationId: string
  holdId: string
  customerRef: string
  status: PaymentStatus
  rejectionReason: string | null
  submittedAt: Date
  reviewedAt: Date | null
}

export type PaymentRecord = Payment & { proofKey: string }

export type SubmitPaymentInput = {
  organizationId: string
  holdId: string
  customerRef: string
  proofKey: string
  idempotencyKey: string
  now?: Date
}

export type PaymentActor = { userId: string; organizationId: string }
export type PaymentReview = { status: 'APPROVED' | 'REJECTED'; reason?: string }

export type PaymentStore = {
  isOwner(userId: string, organizationId: string): Promise<boolean>
  submit(input: SubmitPaymentInput): Promise<PaymentRecord>
  listPending(organizationId: string): Promise<PaymentRecord[]>
  review(actor: PaymentActor, id: string, review: PaymentReview, now: Date): Promise<PaymentRecord>
  proofKey(organizationId: string, id: string): Promise<string | null>
}

function publicPayment(payment: PaymentRecord): Payment {
  const { proofKey: _proofKey, ...safe } = payment
  return safe
}

function validate(input: SubmitPaymentInput): void {
  if (!input.organizationId || !input.holdId || !input.customerRef || !input.proofKey || !input.idempotencyKey) {
    throw new Error('organizationId, holdId, customerRef, proofKey, and idempotencyKey are required')
  }
  if (input.proofKey.length > 1024 || input.proofKey.includes('..') || input.proofKey.startsWith('/')) {
    throw new Error('proofKey is invalid')
  }
}

const store: PaymentStore = {
  isOwner: async (userId, organizationId) => Boolean(await zenstack.member.findFirst({
    where: { userId, organizationId, role: 'owner' },
    select: { id: true },
  })),

  async submit(input) {
    const now = input.now ?? new Date()
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const hold = await client.query<{ customerRef: string; status: string; expiresAt: Date }>(
        `SELECT "customerRef", status, "expiresAt"
         FROM "hold" WHERE id = $1 AND "organizationId" = $2 FOR UPDATE`,
        [input.holdId, input.organizationId],
      )
      if (!hold.rows[0]) throw new Error('Hold not found')

      const existing = await client.query<PaymentRecord>(
        `SELECT id, "organizationId", "holdId", "customerRef", "proofKey", status, "rejectionReason", "submittedAt", "reviewedAt"
         FROM "payment"
         WHERE "organizationId" = $1 AND "customerRef" = $2 AND "idempotencyKey" = $3`,
        [input.organizationId, input.customerRef, input.idempotencyKey],
      )
      if (existing.rows[0]) {
        await client.query('COMMIT')
        return existing.rows[0]
      }
      if (hold.rows[0].customerRef !== input.customerRef) throw new Error('Hold does not belong to Customer')
      if (hold.rows[0].status !== 'ACTIVE' || hold.rows[0].expiresAt <= now) throw new Error('Hold is no longer eligible for Payment')

      const result = await client.query<PaymentRecord>(
        `INSERT INTO "payment" (id, "organizationId", "holdId", "customerRef", "proofKey", status, "idempotencyKey", "submittedAt", "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, 'PENDING', $6, $7, $7, $7)
         RETURNING id, "organizationId", "holdId", "customerRef", "proofKey", status, "rejectionReason", "submittedAt", "reviewedAt"`,
        [ulid(), input.organizationId, input.holdId, input.customerRef, input.proofKey, input.idempotencyKey, now],
      )
      await client.query(
        `INSERT INTO "auditEvent" (id, "organizationId", action, "entityType", "entityId", metadata, "createdAt")
         VALUES ($1, $2, 'payment.submitted', 'Payment', $3, $4, $5)`,
        [ulid(), input.organizationId, result.rows[0].id, JSON.stringify({ customerRef: input.customerRef }), now],
      )
      await persistWhatsAppNotification(client, {
        organizationId: input.organizationId,
        eventKey: `payment:${result.rows[0].id}:submitted`,
        customerRef: input.customerRef,
        text: `Payment proof for Hold ${input.holdId} was received and is pending Owner review. The seats remain reserved while it is reviewed.`,
      }, now)
      await client.query('COMMIT')
      return result.rows[0]
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  },

  async listPending(organizationId) {
    const result = await pool.query<PaymentRecord>(
      `SELECT id, "organizationId", "holdId", "customerRef", "proofKey", status, "rejectionReason", "submittedAt", "reviewedAt"
       FROM "payment" WHERE "organizationId" = $1 AND status = 'PENDING' ORDER BY "submittedAt" ASC`,
      [organizationId],
    )
    return result.rows
  },

  async review(actor, id, review, now) {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const current = await client.query<PaymentRecord>(
        `SELECT id, "organizationId", "holdId", "customerRef", "proofKey", status, "rejectionReason", "submittedAt", "reviewedAt"
         FROM "payment" WHERE id = $1 AND "organizationId" = $2 FOR UPDATE`,
        [id, actor.organizationId],
      )
      if (!current.rows[0]) throw new Error('Payment not found')
      if (current.rows[0].status !== 'PENDING') {
        await client.query('COMMIT')
        return current.rows[0]
      }
      // This Payment row is locked; read the case without locking it to avoid a cycle with cancellation review.
      const cancellation = await client.query<{ id: string }>(
        `SELECT id FROM "cancellationRequest"
         WHERE "organizationId" = $1 AND "paymentId" = $2 AND status = 'PENDING'`,
        [actor.organizationId, id],
      )
      if (cancellation.rows[0]) throw new Error('Payment has a pending cancellation request; review that request first')
      await client.query(
        `UPDATE "payment"
         SET status = $3, "rejectionReason" = $4, "reviewedBy" = $5, "reviewedAt" = $6, "updatedAt" = $6
         WHERE id = $1 AND "organizationId" = $2`,
        [id, actor.organizationId, review.status, review.status === 'REJECTED' ? review.reason : null, actor.userId, now],
      )
      if (review.status === 'APPROVED') {
        const booking = await materializeBooking(client, {
          paymentId: id,
          organizationId: actor.organizationId,
          actorId: actor.userId,
          now,
        })
        await persistWhatsAppNotification(client, {
          organizationId: actor.organizationId,
          eventKey: `booking:${id}:confirmed`,
          customerRef: current.rows[0].customerRef,
          text: `Your payment was approved. Booking ${booking.id} is confirmed.${booking.invoice ? ` Total: ${booking.invoice.amount} ${booking.invoice.currency}.` : ''}`,
        }, now)
      } else {
        await client.query(
          `UPDATE "hold" SET status = 'CANCELLED', "updatedAt" = $3
           WHERE id = $1 AND "organizationId" = $2 AND status = 'ACTIVE'`,
          [current.rows[0].holdId, actor.organizationId, now],
        )
        await client.query(
          `INSERT INTO "auditEvent" (id, "organizationId", "actorId", action, "entityType", "entityId", metadata, "createdAt")
           VALUES ($1, $2, $3, 'payment.rejected', 'Payment', $4, $5, $6)`,
          [ulid(), actor.organizationId, actor.userId, id, JSON.stringify({ reason: review.reason }), now],
        )
        await persistWhatsAppNotification(client, {
          organizationId: actor.organizationId,
          eventKey: `payment:${id}:rejected`,
          customerRef: current.rows[0].customerRef,
          text: `Your Payment was rejected: ${review.reason}. The Hold seats were released. Please create a new Hold to try again.`,
        }, now)
      }
      const updated = await client.query<PaymentRecord>(
        `SELECT id, "organizationId", "holdId", "customerRef", "proofKey", status, "rejectionReason", "submittedAt", "reviewedAt"
         FROM "payment" WHERE id = $1`,
        [id],
      )
      await client.query('COMMIT')
      return updated.rows[0]
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  },

  async proofKey(organizationId, id) {
    const result = await pool.query<{ proofKey: string }>(
      `SELECT "proofKey" FROM "payment" WHERE id = $1 AND "organizationId" = $2`,
      [id, organizationId],
    )
    return result.rows[0]?.proofKey ?? null
  },
}

async function requireOwner(actor: PaymentActor, paymentStore: PaymentStore): Promise<void> {
  if (!await paymentStore.isOwner(actor.userId, actor.organizationId)) throw new Error('Owner access required')
}

export function createPaymentService(paymentStore: PaymentStore = store, notify: NotificationSink = notifyWhatsApp) {
  return {
    async getForCustomer(organizationId: string, customerRef: string, id?: string): Promise<Payment | null> {
      const result = await pool.query<Payment>(
        `SELECT id, "organizationId", "holdId", "customerRef", status, "rejectionReason", "submittedAt", "reviewedAt"
         FROM "payment" WHERE "organizationId" = $1 AND "customerRef" = $2
         ${id ? 'AND id = $3' : ''} ORDER BY "submittedAt" DESC LIMIT 1`,
        id ? [organizationId, customerRef, id] : [organizationId, customerRef],
      )
      return result.rows[0] ?? null
    },

    async submit(input: SubmitPaymentInput): Promise<Payment> {
      validate(input)
      const payment = publicPayment(await paymentStore.submit(input))
      notify({ organizationId: payment.organizationId, eventKey: `payment:${payment.id}:submitted`, customerRef: payment.customerRef, text: `Payment proof for Hold ${payment.holdId} was received and is pending Owner review. The seats remain reserved while it is reviewed.` })
      return payment
    },

    async listPending(actor: PaymentActor): Promise<Payment[]> {
      await requireOwner(actor, paymentStore)
      return (await paymentStore.listPending(actor.organizationId)).map(publicPayment)
    },

    async review(actor: PaymentActor, id: string, review: PaymentReview, now = new Date()): Promise<Payment> {
      await requireOwner(actor, paymentStore)
      if (review.status === 'REJECTED' && !review.reason?.trim()) throw new Error('Rejection reason is required')
      if (review.status === 'APPROVED' && review.reason) throw new Error('Approval cannot include a rejection reason')
      const payment = publicPayment(await paymentStore.review(actor, id, review, now))
      if (payment.status === 'APPROVED') notify({ organizationId: payment.organizationId, eventKey: `booking:${payment.id}:confirmed`, customerRef: payment.customerRef, text: 'Your payment was approved and your Booking is confirmed.' })
      if (payment.status === 'REJECTED') notify({ organizationId: payment.organizationId, eventKey: `payment:${payment.id}:rejected`, customerRef: payment.customerRef, text: `Your Payment was rejected: ${payment.rejectionReason}. The Hold seats were released. Please create a new Hold to try again.` })
      return payment
    },

    async getProof(actor: PaymentActor, id: string): Promise<string> {
      await requireOwner(actor, paymentStore)
      const proofKey = await paymentStore.proofKey(actor.organizationId, id)
      if (!proofKey) throw new Error('Payment proof not found')
      return proofKey
    },
  }
}

export const payments = createPaymentService()
