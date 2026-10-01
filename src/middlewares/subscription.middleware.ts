import { NextFunction, Request, Response } from 'express';
import { Role } from '@prisma/client';
import { HttpError } from '../lib/httpError';
import { isAccountActive } from '../lib/plans';
import { prisma } from '../lib/prisma';

// Assinatura vencida (teste grátis acabou ou pagamento atrasado além da
// tolerância):
// - Admin: modo somente leitura. Consultas (GET) seguem liberadas para ver o que
//   cadastrou; criar, editar e excluir é bloqueado (402).
// - Funcionário: sem acesso nenhum até o admin renovar (403). O login também
//   recusa (ver resolveAccess em auth.service.ts); aqui cobre quem já estava logado.
// O bot do WhatsApp para de responder (ver whatsapp.bot.ts). A tela de
// assinatura (/api/account, /api/subscriptions) continua liberada para o admin
// regularizar. O admin master sempre passa, para dar suporte.

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

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
    const isAdmin = req.auth.role === Role.ADMIN;
    if (isAdmin && READ_METHODS.has(req.method)) return next();
    if (await isCompanySubscriptionActive(req.auth.companyId)) return next();
    if (!isAdmin) return next(HttpError.companyPlanExpired());
    next(new HttpError(402, 'SUBSCRIPTION_INACTIVE', 'Sua assinatura não está ativa. Você pode consultar seus dados, mas para cadastrar ou editar assine um plano em Assinatura.'));
  } catch (err) {
    next(err);
  }
}
