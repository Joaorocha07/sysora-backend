import { Request, Response, Router } from 'express';
import { MembershipStatus, Plan, Role } from '@prisma/client';
import { z } from 'zod';
import { asyncHandler } from '../../lib/asyncHandler';
import { HttpError } from '../../lib/httpError';
import { uniqueInviteCode } from '../../lib/inviteCode';
import { PLANS, planCatalog, subscriptionSummary } from '../../lib/plans';
import { prisma } from '../../lib/prisma';
import { uniqueCompanySlug } from '../../lib/slug';
import { authenticate, companyOf, requireCompany, requireRole } from '../../middlewares/auth.middleware';
import { invalidateSubscriptionCache } from '../../middlewares/subscription.middleware';
import { validate } from '../../middlewares/validate.middleware';

// Assinatura da conta dona da empresa atual: plano, status, empresas da conta
// e criação da segunda empresa (plano Avançado). Fica liberada mesmo com a
// assinatura vencida, para o cliente conseguir regularizar.

const createCompanySchema = z.object({ name: z.string().trim().min(2, 'Informe o nome da empresa.').max(120) });
const changePlanSchema = z.object({ plan: z.nativeEnum(Plan) });

async function accountOf(companyId: string) {
  const company = await prisma.company.findUniqueOrThrow({ where: { id: companyId }, include: { account: true } });
  return company.account;
}

export const accountRouter = Router();

accountRouter.use(authenticate, requireCompany);

accountRouter.get('/', asyncHandler(async (req: Request, res: Response) => {
  const account = await accountOf(companyOf(req));
  const companies = await prisma.company.findMany({
    where: { accountId: account.id },
    orderBy: { createdAt: 'asc' },
    include: {
      settings: { select: { whatsappConnected: true, whatsappPhone: true } },
      _count: { select: { memberships: { where: { status: MembershipStatus.ACTIVE, active: true, user: { isSuperAdmin: false } } } } },
    },
  });
  const summary = subscriptionSummary(account);
  return res.json({
    subscription: summary,
    plans: planCatalog(),
    companies: companies.map((c) => ({
      id: c.id,
      name: c.name,
      active: c.active,
      users: c._count.memberships,
      whatsappConnected: c.settings?.whatsappConnected ?? false,
      whatsappPhone: c.settings?.whatsappPhone ?? null,
    })),
    canCreateCompany: companies.length < summary.maxCompanies,
  });
}));

// Nova empresa na mesma conta (plano Avançado), com o próprio WhatsApp.
accountRouter.post('/companies', requireRole(Role.ADMIN), validate(createCompanySchema), asyncHandler(async (req: Request, res: Response) => {
  const account = await accountOf(companyOf(req));
  const plan = PLANS[account.plan];
  const count = await prisma.company.count({ where: { accountId: account.id } });
  if (count >= plan.maxCompanies) {
    throw HttpError.forbidden(account.plan === Plan.INICIAL
      ? 'O plano Inicial inclui 1 empresa. Passe para o Avançado para ter até 2 empresas, cada uma com o seu WhatsApp.'
      : `O plano ${plan.name} permite até ${plan.maxCompanies} empresas.`);
  }

  const [slug, inviteCode] = await Promise.all([uniqueCompanySlug(req.body.name), uniqueInviteCode()]);
  const company = await prisma.company.create({
    data: {
      accountId: account.id,
      name: req.body.name,
      slug,
      inviteCode,
      settings: { create: {} },
      // Quem criou já entra como administrador da nova empresa.
      memberships: req.auth!.isSuperAdmin ? undefined : { create: { userId: req.auth!.userId, role: Role.ADMIN } },
    },
  });
  return res.status(201).json({ company: { id: company.id, name: company.name, slug: company.slug } });
}));

// Troca de plano. A cobrança é feita fora do sistema (o admin master registra
// os pagamentos); aqui só valem os limites do novo plano.
accountRouter.patch('/plan', requireRole(Role.ADMIN), validate(changePlanSchema), asyncHandler(async (req: Request, res: Response) => {
  const account = await accountOf(companyOf(req));
  const target = PLANS[req.body.plan as Plan];
  const companies = await prisma.company.findMany({ where: { accountId: account.id }, select: { id: true } });
  if (companies.length > target.maxCompanies) {
    throw HttpError.badRequest(`O plano ${target.name} permite ${target.maxCompanies} empresa. Exclua ou transfira a outra empresa antes de mudar.`);
  }
  const updated = await prisma.account.update({ where: { id: account.id }, data: { plan: req.body.plan } });
  invalidateSubscriptionCache(companies.map((c) => c.id));
  return res.json({ subscription: subscriptionSummary(updated) });
}));
