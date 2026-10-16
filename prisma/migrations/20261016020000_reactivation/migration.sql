-- Reativação de clientes: o bot convida para agendar quem não manda mensagem há X dias.

-- AlterTable
ALTER TABLE "clients" ADD COLUMN     "reactivatedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "company_settings" ADD COLUMN     "reactivationDays" INTEGER NOT NULL DEFAULT 30,
ADD COLUMN     "reactivationEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "reactivationMessage" TEXT NOT NULL DEFAULT 'Oi, {nome}! Faz um tempinho que a gente não se fala. Que tal marcar um horário? É só escolher o melhor dia por aqui: {link}';

