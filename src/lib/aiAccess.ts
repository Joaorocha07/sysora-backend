import { HttpError } from './httpError';
import { hasAi } from './plans';
import { prisma } from './prisma';

// Recursos de IA ficam no plano Avançado pago (lib/plans.ts -> hasAi).
export const AI_PLAN_MESSAGE = 'Os recursos de IA fazem parte do plano Avançado. No teste grátis e no plano Inicial, monte e escreva tudo pelo editor manual.';

export async function companyHasAi(companyId: string): Promise<boolean> {
  const company = await prisma.company.findUnique({ where: { id: companyId }, select: { account: true } });
  return Boolean(company && hasAi(company.account));
}

export async function requireAiPlan(companyId: string) {
  if (!(await companyHasAi(companyId))) throw new HttpError(403, 'PLAN_AI_REQUIRED', AI_PLAN_MESSAGE);
}
