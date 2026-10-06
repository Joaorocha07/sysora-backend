-- Plano anual: ciclo de cobrança da conta e último pagamento avulso aplicado (cartão anual ou Pix).
CREATE TYPE "BillingCycle" AS ENUM ('MONTHLY', 'YEARLY');
ALTER TABLE "accounts" ADD COLUMN "billingCycle" "BillingCycle" NOT NULL DEFAULT 'MONTHLY';
ALTER TABLE "accounts" ADD COLUMN "lastPaymentId" TEXT;
