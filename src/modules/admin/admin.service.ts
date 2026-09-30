import { AppointmentStatus, MembershipStatus, Plan, Role, SubscriptionStatus } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { HttpError } from '../../lib/httpError';
import { hashPassword } from '../../lib/password';
import { uniqueCompanySlug } from '../../lib/slug';
import { uniqueInviteCode } from '../../lib/inviteCode';
import { PLANS, addMonth, isAccountActive, subscriptionSummary, trialEnd } from '../../lib/plans';
import { invalidateSubscriptionCache } from '../../middlewares/subscription.middleware';
import * as whatsappConnection from '../whatsapp/whatsapp.connection';

// Painel do admin master: empresas, contas (assinaturas) e o administrador
// inicial de cada empresa. A cobrança é feita fora do sistema: o master
// registra os pagamentos, que estendem o acesso em 30 dias.

type CompanyInput = { name: string; document?: string | null; phone?: string | null; email?: string | null };

const monthStart = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
};

export async function stats() {
  const [companies, accounts, users, clients, appointmentsThisMonth, connected] = await Promise.all([
    prisma.company.count(),
    prisma.account.findMany({ select: { plan: true, status: true, trialEndsAt: true, paidUntil: true } }),
    prisma.user.count({ where: { isSuperAdmin: false } }),
    prisma.client.count(),
    prisma.appointment.count({ where: { date: { gte: monthStart() }, status: { not: AppointmentStatus.CANCELED } } }),
    prisma.companySettings.count({ where: { whatsappConnected: true } }),
  ]);
  const paying = accounts.filter((a) => a.status === SubscriptionStatus.ACTIVE && isAccountActive(a));
  return {
    companies,
    accounts: accounts.length,
    payingAccounts: paying.length,
    trialAccounts: accounts.filter((a) => a.status === SubscriptionStatus.TRIAL && isAccountActive(a)).length,
    // Receita mensal recorrente das contas pagas.
    mrrCents: paying.reduce((sum, a) => sum + PLANS[a.plan].priceCents, 0),
    users,
    clients,
    appointmentsThisMonth,
    whatsappConnected: connected,
  };
}

export async function listCompanies() {
  const companies = await prisma.company.findMany({
    orderBy: { createdAt: 'desc' },
    include: {
      account: true,
      settings: { select: { whatsappConnected: true, whatsappPhone: true } },
      memberships: { where: { status: MembershipStatus.ACTIVE, user: { isSuperAdmin: false } }, include: { user: { select: { id: true, name: true, email: true } } } },
      _count: { select: { clients: true, appointments: true, services: true } },
    },
  });
  return companies.map((c) => ({
    id: c.id,
    name: c.name,
    slug: c.slug,
    document: c.document,
    phone: c.phone,
    email: c.email,
    active: c.active,
    selfSignup: c.selfSignup,
    inviteCode: c.inviteCode,
    createdAt: c.createdAt,
    subscription: subscriptionSummary(c.account),
    whatsappConnected: c.settings?.whatsappConnected ?? false,
    whatsappPhone: c.settings?.whatsappPhone ?? null,
    users: c.memberships.length,
    admins: c.memberships.filter((m) => m.role === Role.ADMIN).map((m) => m.user),
    clients: c._count.clients,
    appointments: c._count.appointments,
    services: c._count.services,
  }));
}

export async function createCompany(input: CompanyInput & { plan: Plan; trial: boolean; admin: { name: string; email: string; password: string } }) {
  const existing = await prisma.user.findUnique({ where: { email: input.admin.email } });
  if (existing?.isSuperAdmin) throw HttpError.conflict('Este e-mail pertence a um administrador master.');

  const [slug, inviteCode] = await Promise.all([uniqueCompanySlug(input.name), uniqueInviteCode()]);
  const passwordHash = existing ? null : await hashPassword(input.admin.password);

  const company = await prisma.$transaction(async (tx) => {
    const account = await tx.account.create({
      data: input.trial
        ? { name: input.name, plan: input.plan, status: SubscriptionStatus.TRIAL, trialEndsAt: trialEnd() }
        : { name: input.name, plan: input.plan, status: SubscriptionStatus.ACTIVE, paidUntil: addMonth(new Date()) },
    });
    const created = await tx.company.create({
      data: {
        accountId: account.id,
        name: input.name,
        slug,
        inviteCode,
        document: input.document || null,
        phone: input.phone || null,
        email: input.email || null,
        settings: { create: {} },
      },
    });
    const user = existing ?? await tx.user.create({
      data: { name: input.admin.name, email: input.admin.email, passwordHash: passwordHash! },
    });
    await tx.companyMembership.create({ data: { userId: user.id, companyId: created.id, role: Role.ADMIN } });
    return created;
  });

  return { company, adminAlreadyExisted: Boolean(existing) };
}

export async function updateCompany(companyId: string, input: Partial<CompanyInput> & { active?: boolean }) {
  const company = await prisma.company.findUnique({ where: { id: companyId } });
  if (!company) throw HttpError.notFound('Empresa não encontrada.');

  const updated = await prisma.company.update({ where: { id: companyId }, data: { ...input, email: input.email === '' ? null : input.email } });
  if (input.active === false) {
    // Empresa desativada: encerra as sessões e desliga o WhatsApp dela.
    await prisma.refreshToken.updateMany({ where: { companyId, revokedAt: null }, data: { revokedAt: new Date() } });
    await whatsappConnection.disconnect(companyId).catch(() => {});
  }
  return updated;
}

async function accountCompanies(accountId: string) {
  const companies = await prisma.company.findMany({ where: { accountId }, select: { id: true } });
  return companies.map((c) => c.id);
}

// Plano e status da assinatura (ajuste manual pelo master).
export async function updateAccount(accountId: string, input: { plan?: Plan; status?: SubscriptionStatus; trialEndsAt?: string | null; paidUntil?: string | null }) {
  const account = await prisma.account.findUnique({ where: { id: accountId } });
  if (!account) throw HttpError.notFound('Conta não encontrada.');
  const companyIds = await accountCompanies(accountId);
  if (input.plan && companyIds.length > PLANS[input.plan].maxCompanies) {
    throw HttpError.badRequest(`Esta conta tem ${companyIds.length} empresas; o plano ${PLANS[input.plan].name} permite ${PLANS[input.plan].maxCompanies}.`);
  }
  const updated = await prisma.account.update({
    where: { id: accountId },
    data: {
      plan: input.plan,
      status: input.status,
      trialEndsAt: input.trialEndsAt === undefined ? undefined : input.trialEndsAt ? new Date(input.trialEndsAt) : null,
      paidUntil: input.paidUntil === undefined ? undefined : input.paidUntil ? new Date(input.paidUntil) : null,
    },
  });
  invalidateSubscriptionCache(companyIds);
  return subscriptionSummary(updated);
}

// Pagamento recebido: conta ativa por mais 30 dias (a partir do vencimento
// atual, se ainda não venceu).
export async function registerPayment(accountId: string) {
  const account = await prisma.account.findUnique({ where: { id: accountId } });
  if (!account) throw HttpError.notFound('Conta não encontrada.');
  const now = new Date();
  const base = account.status === SubscriptionStatus.ACTIVE && account.paidUntil && account.paidUntil > now ? account.paidUntil : now;
  const updated = await prisma.account.update({
    where: { id: accountId },
    data: { status: SubscriptionStatus.ACTIVE, paidUntil: addMonth(base), trialEndsAt: null },
  });
  invalidateSubscriptionCache(await accountCompanies(accountId));
  return subscriptionSummary(updated);
}

export async function deleteCompany(companyId: string) {
  const company = await prisma.company.findUnique({ where: { id: companyId } });
  if (!company) throw HttpError.notFound('Empresa não encontrada.');
  await whatsappConnection.disconnect(companyId).catch(() => {});
  await prisma.company.delete({ where: { id: companyId } });
  // Conta sem nenhuma empresa não tem mais o que cobrar.
  if ((await prisma.company.count({ where: { accountId: company.accountId } })) === 0) {
    await prisma.account.delete({ where: { id: company.accountId } });
  }
  invalidateSubscriptionCache([companyId]);
}
