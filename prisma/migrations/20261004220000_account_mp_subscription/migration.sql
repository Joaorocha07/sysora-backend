-- Coluna que existia no schema sem migration (criada fora do fluxo de migrations).
ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "mpSubscriptionId" TEXT;
