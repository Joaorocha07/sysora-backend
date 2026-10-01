-- Consumo da IA (Claude) por chamada e créditos colocados na Anthropic, para
-- o painel master de gastos com IA.
ALTER TABLE "platform_settings" ADD COLUMN "aiCreditCents" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "ai_usage" (
    "id" TEXT NOT NULL,
    "companyId" TEXT,
    "feature" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL,
    "outputTokens" INTEGER NOT NULL,
    "cacheReadTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheWriteTokens" INTEGER NOT NULL DEFAULT 0,
    "costMicros" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_usage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ai_usage_createdAt_idx" ON "ai_usage"("createdAt");
CREATE INDEX "ai_usage_companyId_idx" ON "ai_usage"("companyId");

ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Mesmo padrão das outras tabelas (ver 20260930000000_enable_rls): sem acesso pela API pública do Supabase.
ALTER TABLE "ai_usage" ENABLE ROW LEVEL SECURITY;
