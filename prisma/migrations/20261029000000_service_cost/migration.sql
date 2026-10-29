-- Custo mensal da conta de acesso (ex.: R$ 100 do ChatGPT), em centavos.
-- Usado no catálogo para calcular lucro; só é cobrado quando a conta tem ao
-- menos uma pessoa ativa.

-- AlterTable
ALTER TABLE "services" ADD COLUMN     "costCents" INTEGER NOT NULL DEFAULT 0;
