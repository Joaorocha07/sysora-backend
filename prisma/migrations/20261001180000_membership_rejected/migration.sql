-- Pedido de acesso recusado passa a ficar registrado (antes era apagado),
-- para o funcionário ver no perfil o histórico das equipes.
ALTER TYPE "MembershipStatus" ADD VALUE 'REJECTED';

ALTER TABLE "company_memberships" ADD COLUMN "decidedAt" TIMESTAMP(3);
