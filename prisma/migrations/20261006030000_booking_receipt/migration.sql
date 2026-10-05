-- Endereço da empresa e comprovante do agendamento pelo link.
ALTER TABLE "companies" ADD COLUMN "address" TEXT;
ALTER TABLE "appointments" ADD COLUMN "receiptToken" TEXT;
CREATE UNIQUE INDEX "appointments_receiptToken_key" ON "appointments"("receiptToken");
