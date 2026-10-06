-- Link de agendamento de uso único: quando foi usado e qual agendamento gerou.
ALTER TABLE "booking_links" ADD COLUMN "usedAt" TIMESTAMP(3),
ADD COLUMN "appointmentId" TEXT;
