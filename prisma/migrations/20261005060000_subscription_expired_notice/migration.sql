-- Aviso do bot de assinatura vencida (uma vez por período).
ALTER TABLE "client_subscriptions" ADD COLUMN "expiredNoticeAt" TIMESTAMP(3);
