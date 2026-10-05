-- Vários fluxos do bot por empresa (até 5), um em uso.
CREATE TABLE "bot_flows" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "flow" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bot_flows_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "bot_flows_companyId_idx" ON "bot_flows"("companyId");

ALTER TABLE "bot_flows" ADD CONSTRAINT "bot_flows_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "company_settings" ADD COLUMN "activeFlowId" TEXT;
