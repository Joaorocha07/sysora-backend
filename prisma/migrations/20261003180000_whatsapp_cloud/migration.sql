-- WhatsApp pela API oficial da Meta (Cloud API) e consumo de mensagens por mês.
CREATE TABLE "whatsapp_cloud_accounts" (
    "companyId" TEXT NOT NULL,
    "wabaId" TEXT NOT NULL,
    "phoneNumberId" TEXT NOT NULL,
    "businessId" TEXT,
    "accessToken" TEXT NOT NULL,
    "pin" TEXT,
    "displayPhone" TEXT,
    "verifiedName" TEXT,
    "coexistence" BOOLEAN NOT NULL DEFAULT false,
    "templates" JSONB NOT NULL DEFAULT '{}',
    "lastError" TEXT,
    "lastErrorAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "whatsapp_cloud_accounts_pkey" PRIMARY KEY ("companyId")
);

CREATE UNIQUE INDEX "whatsapp_cloud_accounts_phoneNumberId_key" ON "whatsapp_cloud_accounts"("phoneNumberId");

ALTER TABLE "whatsapp_cloud_accounts" ADD CONSTRAINT "whatsapp_cloud_accounts_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "whatsapp_usage" (
    "companyId" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "serviceTotal" INTEGER NOT NULL DEFAULT 0,
    "serviceBillable" INTEGER NOT NULL DEFAULT 0,
    "utilityTotal" INTEGER NOT NULL DEFAULT 0,
    "utilityBillable" INTEGER NOT NULL DEFAULT 0,
    "marketingTotal" INTEGER NOT NULL DEFAULT 0,
    "marketingBillable" INTEGER NOT NULL DEFAULT 0,
    "authenticationTotal" INTEGER NOT NULL DEFAULT 0,
    "authenticationBillable" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "whatsapp_usage_pkey" PRIMARY KEY ("companyId","month")
);

ALTER TABLE "whatsapp_usage" ADD CONSTRAINT "whatsapp_usage_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Mesmo padrão das outras tabelas (ver 20260930000000_enable_rls): sem acesso pela API pública do Supabase.
ALTER TABLE "whatsapp_cloud_accounts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "whatsapp_usage" ENABLE ROW LEVEL SECURITY;
