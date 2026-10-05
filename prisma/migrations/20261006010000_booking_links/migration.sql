-- Link pessoal de agendamento mandado pelo bot.
ALTER TABLE "company_settings" ADD COLUMN "bookingLinkEnabled" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "booking_links" (
    "token" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "booking_links_pkey" PRIMARY KEY ("token")
);

CREATE INDEX "booking_links_clientId_idx" ON "booking_links"("clientId");

ALTER TABLE "booking_links" ADD CONSTRAINT "booking_links_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "booking_links" ADD CONSTRAINT "booking_links_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;
