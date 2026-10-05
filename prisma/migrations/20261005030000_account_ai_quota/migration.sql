-- AlterTable
ALTER TABLE "accounts" ADD COLUMN     "botAiCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "botAiMonth" TEXT,
ADD COLUMN     "soraCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "soraMonth" TEXT;


-- Leva o uso deste mês (antes contado por empresa) para a conta, somando as empresas.
UPDATE "accounts" a SET "soraMonth" = s.month, "soraCount" = s.total
FROM (
  SELECT c."accountId", cs."soraMonth" AS month, SUM(cs."soraCount")::int AS total
  FROM "companies" c JOIN "company_settings" cs ON cs."companyId" = c."id"
  WHERE cs."soraMonth" = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM')
  GROUP BY c."accountId", cs."soraMonth"
) s
WHERE a."id" = s."accountId";

UPDATE "accounts" a SET "botAiMonth" = s.month, "botAiCount" = s.total
FROM (
  SELECT c."accountId", cs."botAiMonth" AS month, SUM(cs."botAiCount")::int AS total
  FROM "companies" c JOIN "company_settings" cs ON cs."companyId" = c."id"
  WHERE cs."botAiMonth" = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM')
  GROUP BY c."accountId", cs."botAiMonth"
) s
WHERE a."id" = s."accountId";
