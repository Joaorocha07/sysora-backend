-- LGPD: aceite dos termos, consentimento de cookies e pedidos dos titulares.
ALTER TABLE "users" ADD COLUMN "termsAcceptedAt" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN "termsVersion" TEXT;

CREATE TABLE "cookie_consents" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "analytics" BOOLEAN NOT NULL DEFAULT false,
    "marketing" BOOLEAN NOT NULL DEFAULT false,
    "policyVersion" TEXT NOT NULL,
    "ipHash" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cookie_consents_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "cookie_consents_userId_idx" ON "cookie_consents"("userId");

CREATE TABLE "privacy_requests" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "message" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "response" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "privacy_requests_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "privacy_requests_status_createdAt_idx" ON "privacy_requests"("status", "createdAt");
ALTER TABLE "privacy_requests" ADD CONSTRAINT "privacy_requests_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Mesmo padrão das outras tabelas (ver 20260930000000_enable_rls): sem acesso pela API pública do Supabase.
ALTER TABLE "cookie_consents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "privacy_requests" ENABLE ROW LEVEL SECURITY;
