-- Uso mensal da Sora (IA que monta o fluxo do bot), para o limite por empresa.
ALTER TABLE "company_settings" ADD COLUMN "soraMonth" TEXT;
ALTER TABLE "company_settings" ADD COLUMN "soraCount" INTEGER NOT NULL DEFAULT 0;
