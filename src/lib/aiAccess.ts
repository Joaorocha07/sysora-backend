import { HttpError } from './httpError';
import { hasAi, hasSora } from './plans';
import { prisma } from './prisma';

// IA no atendimento fica no plano Avançado pago (lib/plans.ts -> hasAi); a Sora,
// em qualquer plano pago (hasSora), com limite de gasto por plano.
export const AI_PLAN_MESSAGE = 'Este recurso de IA faz parte do plano Avançado. No teste grátis e no plano Inicial, monte e escreva tudo pelo editor manual.';
export const SORA_PLAN_MESSAGE = 'A Sora faz parte dos planos pagos. No teste grátis, monte o fluxo pelo editor manual.';

export async function companyHasAi(companyId: string): Promise<boolean> {
  const company = await prisma.company.findUnique({ where: { id: companyId }, select: { account: true } });
  return Boolean(company && hasAi(company.account));
}

export async function requireAiPlan(companyId: string) {
  if (!(await companyHasAi(companyId))) throw new HttpError(403, 'PLAN_AI_REQUIRED', AI_PLAN_MESSAGE);
}

export async function companyHasSora(companyId: string): Promise<boolean> {
  const company = await prisma.company.findUnique({ where: { id: companyId }, select: { account: true } });
  return Boolean(company && hasSora(company.account));
}

export async function requireSoraPlan(companyId: string) {
  if (!(await companyHasSora(companyId))) throw new HttpError(403, 'PLAN_AI_REQUIRED', SORA_PLAN_MESSAGE);
}
