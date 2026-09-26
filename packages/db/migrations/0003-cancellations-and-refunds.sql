ALTER TYPE "PaymentStatus" ADD VALUE IF NOT EXISTS 'REFUND_PENDING';
ALTER TYPE "PaymentStatus" ADD VALUE IF NOT EXISTS 'REFUNDED';
ALTER TYPE "BookingStatus" ADD VALUE IF NOT EXISTS 'CANCELLED';

CREATE TYPE "CancellationRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');
CREATE TYPE "RefundStatus" AS ENUM ('PENDING', 'COMPLETED');

CREATE TABLE "cancellationRequest" (
  id text PRIMARY KEY,
  "organizationId" text NOT NULL REFERENCES "organization"(id) ON DELETE CASCADE,
  "bookingId" text REFERENCES "booking"(id) ON DELETE CASCADE,
  "paymentId" text REFERENCES "payment"(id) ON DELETE CASCADE,
  "customerRef" text NOT NULL,
  "idempotencyKey" text NOT NULL,
  status "CancellationRequestStatus" NOT NULL DEFAULT 'PENDING',
  reason text,
  "requestedAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reviewedBy" text,
  "reviewedAt" timestamp(3),
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("organizationId", "customerRef", "idempotencyKey"),
  CHECK (num_nonnulls("bookingId", "paymentId") = 1)
);

CREATE INDEX "cancellationRequest_organizationId_status_requestedAt_idx"
  ON "cancellationRequest"("organizationId", status, "requestedAt");
CREATE INDEX "cancellationRequest_bookingId_status_idx"
  ON "cancellationRequest"("bookingId", status);
CREATE INDEX "cancellationRequest_paymentId_status_idx"
  ON "cancellationRequest"("paymentId", status);

CREATE TABLE "refund" (
  id text PRIMARY KEY,
  "organizationId" text NOT NULL REFERENCES "organization"(id) ON DELETE CASCADE,
  "bookingId" text UNIQUE REFERENCES "booking"(id) ON DELETE CASCADE,
  "paymentId" text UNIQUE REFERENCES "payment"(id) ON DELETE CASCADE,
  "customerRef" text NOT NULL,
  amount integer NOT NULL CHECK (amount >= 0),
  currency text NOT NULL,
  status "RefundStatus" NOT NULL DEFAULT 'PENDING',
  "transferredAt" timestamp(3),
  "transferReference" text,
  "recordedBy" text,
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (num_nonnulls("bookingId", "paymentId") = 1),
  CHECK (
    (status = 'PENDING' AND "transferredAt" IS NULL AND "transferReference" IS NULL AND "recordedBy" IS NULL)
    OR (status = 'COMPLETED' AND "transferredAt" IS NOT NULL AND "transferReference" IS NOT NULL AND "recordedBy" IS NOT NULL)
  )
);

CREATE INDEX "refund_organizationId_status_createdAt_idx"
  ON "refund"("organizationId", status, "createdAt");
