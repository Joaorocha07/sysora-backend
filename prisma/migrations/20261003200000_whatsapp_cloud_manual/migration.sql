-- Conexão manual do WhatsApp oficial: a empresa usa o próprio app da Meta.
ALTER TABLE "whatsapp_cloud_accounts" ADD COLUMN "manual" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "whatsapp_cloud_accounts" ADD COLUMN "appId" TEXT;
ALTER TABLE "whatsapp_cloud_accounts" ADD COLUMN "appSecret" TEXT;
ALTER TABLE "whatsapp_cloud_accounts" ADD COLUMN "lastWebhookAt" TIMESTAMP(3);
