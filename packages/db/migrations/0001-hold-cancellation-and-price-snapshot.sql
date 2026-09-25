ALTER TYPE "HoldStatus" ADD VALUE IF NOT EXISTS 'CANCELLED';

ALTER TABLE "hold"
  ADD COLUMN IF NOT EXISTS "priceAtHold" integer,
  ADD COLUMN IF NOT EXISTS "currencyAtHold" text;

UPDATE "hold" h
SET "priceAtHold" = COALESCE(h."priceAtHold", t.price),
    "currencyAtHold" = COALESCE(h."currencyAtHold", t.currency)
FROM "trip" t
WHERE t.id = h."tripId"
  AND (h."priceAtHold" IS NULL OR h."currencyAtHold" IS NULL);
