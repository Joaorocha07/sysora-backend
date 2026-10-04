ALTER TABLE "company_settings" ADD COLUMN IF NOT EXISTS "emailCodesEnabled" BOOLEAN NOT NULL DEFAULT false;
