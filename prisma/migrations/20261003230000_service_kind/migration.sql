-- Produtos de pronta entrega no catálogo, ao lado dos serviços com horário.
CREATE TYPE "ServiceKind" AS ENUM ('SERVICE', 'PRODUCT');
ALTER TABLE "services" ADD COLUMN "kind" "ServiceKind" NOT NULL DEFAULT 'SERVICE';
ALTER TABLE "appointment_items" ADD COLUMN "kind" "ServiceKind" NOT NULL DEFAULT 'SERVICE';
