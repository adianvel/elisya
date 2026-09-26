CREATE TABLE IF NOT EXISTS "whatsappOutbox" (
  id text PRIMARY KEY,
  "organizationId" text NOT NULL REFERENCES "organization"(id) ON DELETE CASCADE,
  "eventKey" text NOT NULL,
  "customerRef" text NOT NULL,
  text text NOT NULL,
  "sentAt" timestamp(3),
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("organizationId", "eventKey")
);

CREATE INDEX IF NOT EXISTS "whatsappOutbox_organizationId_sentAt_createdAt_idx"
  ON "whatsappOutbox"("organizationId", "sentAt", "createdAt");
