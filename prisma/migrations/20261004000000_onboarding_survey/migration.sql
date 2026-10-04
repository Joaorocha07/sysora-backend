-- Pesquisa inicial dos administradores de contas novas.
ALTER TABLE "users" ADD COLUMN "surveyDismissedAt" TIMESTAMP(3);

CREATE TABLE "onboarding_surveys" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "companyId" TEXT,
    "sources" TEXT[],
    "sourceOther" TEXT,
    "business" TEXT NOT NULL,
    "businessOther" TEXT,
    "teamSize" TEXT NOT NULL,
    "features" TEXT[],
    "featuresOther" TEXT,
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "onboarding_surveys_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "onboarding_surveys_userId_key" ON "onboarding_surveys"("userId");
CREATE INDEX "onboarding_surveys_createdAt_idx" ON "onboarding_surveys"("createdAt");

ALTER TABLE "onboarding_surveys" ADD CONSTRAINT "onboarding_surveys_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "onboarding_surveys" ADD CONSTRAINT "onboarding_surveys_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Mesmo padrão das outras tabelas (ver 20260930000000_enable_rls): sem acesso pela API pública do Supabase.
ALTER TABLE "onboarding_surveys" ENABLE ROW LEVEL SECURITY;
