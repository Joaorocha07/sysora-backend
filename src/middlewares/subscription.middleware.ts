import { NextFunction, Request, Response } from 'express';
import { HttpError } from '../lib/httpError';
import { isAccountActive } from '../lib/plans';
import { prisma } from '../lib/prisma';

// Bloqueia os dados da empresa quando a assinatura venceu (teste grátis
// acabou ou pagamento atrasado além da tolerância). A tela de assinatura
// (/api/account) continua liberada para o cliente regularizar. O admin master
// sempre passa, para dar suporte.

const CACHE_MS = 30_000;
const cache = new Map<string, { active: boolean; at: number }>();

export function invalidateSubscriptionCache(companyIds?: string[]) {
  if (!companyIds) cache.clear();
  else companyIds.forEach((id) => cache.delete(id));
}

export async function isCompanySubscriptionActive(companyId: string): Promise<boolean> {
  const hit = cache.get(companyId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.active;
  const company = await prisma.company.findUnique({ where: { id: companyId }, include: { account: true } });
  const active = Boolean(company && isAccountActive(company.account));
  cache.set(companyId, { active, at: Date.now() });
  return active;
}

export async function requireActiveSubscription(req: Request, _res: Response, next: NextFunction) {
  try {
    if (!req.auth?.companyId || req.auth.isSuperAdmin) return next();
    if (await isCompanySubscriptionActive(req.auth.companyId)) return next();
    next(new HttpError(402, 'SUBSCRIPTION_INACTIVE', 'Sua assinatura está vencida. Regularize em Assinatura para voltar a usar o Sysora.'));
  } catch (err) {
    next(err);
  }
}
