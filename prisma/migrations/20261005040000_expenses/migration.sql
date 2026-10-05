-- Gastos cadastrados pelo admin master (página Gastos).
CREATE TABLE "expenses" (
    "id" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'outros',
    "amountCents" INTEGER NOT NULL,
    "date" DATE NOT NULL,
    "recurring" BOOLEAN NOT NULL DEFAULT false,
    "endDate" DATE,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "expenses_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "expenses_date_idx" ON "expenses"("date");

-- Cotação do dólar para mostrar o gasto da IA em reais.
ALTER TABLE "platform_settings" ADD COLUMN "usdBrlRate" DOUBLE PRECISION NOT NULL DEFAULT 5.5;
