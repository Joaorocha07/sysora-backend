-- IA do atendimento e transcrição de áudio no bot do WhatsApp.
ALTER TABLE "company_settings" ADD COLUMN "botAiEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "company_settings" ADD COLUMN "botAiMonth" TEXT;
ALTER TABLE "company_settings" ADD COLUMN "botAiCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "company_settings" ADD COLUMN "transcribeAudio" BOOLEAN NOT NULL DEFAULT true;
