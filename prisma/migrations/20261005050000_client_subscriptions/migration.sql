-- Assinaturas dos clientes (venda mensal com data da compra e vencimento).
ALTER TABLE "company_settings" ADD COLUMN "clientSubscriptionsEnabled" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "client_subscriptions" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "serviceId" TEXT,
    "name" TEXT NOT NULL,
    "priceCents" INTEGER NOT NULL DEFAULT 0,
    "startDate" TEXT NOT NULL,
    "dueDate" TEXT NOT NULL,
    "source" "Source" NOT NULL DEFAULT 'STAFF',
    "notes" TEXT,
    "canceledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "client_subscriptions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "client_subscriptions_companyId_dueDate_idx" ON "client_subscriptions"("companyId", "dueDate");
CREATE INDEX "client_subscriptions_clientId_idx" ON "client_subscriptions"("clientId");

ALTER TABLE "client_subscriptions" ADD CONSTRAINT "client_subscriptions_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "client_subscriptions" ADD CONSTRAINT "client_subscriptions_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "client_subscriptions" ADD CONSTRAINT "client_subscriptions_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "services"("id") ON DELETE SET NULL ON UPDATE CASCADE;
