-- Link aberto de agendamento da empresa (/reservar/[token]).

-- AlterTable
ALTER TABLE "company_settings" ADD COLUMN     "publicBookingEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "publicBookingToken" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "company_settings_publicBookingToken_key" ON "company_settings"("publicBookingToken");

