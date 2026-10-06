import { AppointmentStatus, MembershipStatus, Plan, Role, SubscriptionStatus } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { HttpError } from '../../lib/httpError';
import { hashPassword } from '../../lib/password';
import { uniqueCompanySlug } from '../../lib/slug';
import { uniqueInviteCode } from '../../lib/inviteCode';
import { PLANS, addCycle, addMonth, isAccountActive, subscriptionSummary, trialEnd, yearlyPriceCents } from '../../lib/plans';
import { invalidateSubscriptionCache } from '../../middlewares/subscription.middleware';
import { env } from '../../config/env';
import { getPlatformSettings } from '../../lib/platformSettings';
import { disconnectAll as disconnectWhatsApp } from '../whatsapp/whatsapp.transport';

// Painel do admin master: empresas, contas (assinaturas) e o administrador
// inicial de cada empresa. A cobrança é feita fora do sistema: o master
// registra os pagamentos, que estendem o acesso em 30 dias.

type CompanyInput = { name: string; document?: string | null; phone?: string | null; email?: string | null };

// Empresa só do admin master (ex.: ele se cadastrou pelo site): não é cliente
// da Sysora, então fica fora da lista e das métricas do painel.
const customerCompany = {
  NOT: { AND: [{ memberships: { some: { user: { isSuperAdmin: true } } } }, { memberships: { none: { user: { isSuperAdmin: false } } } }] },
};

const monthStart = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
};

export async function stats() {
  const [companies, accounts, users, clients, appointmentsThisMonth, connected] = await Promise.all([
    prisma.company.count({ where: customerCompany }),
    prisma.account.findMany({ where: { companies: { some: customerCompany } }, select: { plan: true, billingCycle: true, status: true, trialEndsAt: true, paidUntil: true, complimentary: true } }),
    prisma.user.count({ where: { isSuperAdmin: false } }),
    prisma.client.count({ where: { company: customerCompany } }),
    prisma.appointment.count({ where: { company: customerCompany, date: { gte: monthStart() }, status: { not: AppointmentStatus.CANCELED } } }),
    prisma.companySettings.count({ where: { company: customerCompany, whatsappConnected: true } }),
  ]);
  // Cortesia (teste, parceiro) tem o plano ativo mas não é venda.
  const paying = accounts.filter((a) => a.status === SubscriptionStatus.ACTIVE && isAccountActive(a) && !a.complimentary);
  return {
    companies,
    accounts: accounts.length,
    payingAccounts: paying.length,
    complimentaryAccounts: accounts.filter((a) => a.complimentary && isAccountActive(a)).length,
    trialAccounts: accounts.filter((a) => a.status === SubscriptionStatus.TRIAL && isAccountActive(a)).length,
    // Receita mensal recorrente das contas pagas (anual entra como 1/12 do valor).
    mrrCents: paying.reduce((sum, a) => sum + (a.billingCycle === 'YEARLY' ? Math.round(yearlyPriceCents(a.plan) / 12) : PLANS[a.plan].priceCents), 0),
    users,
    clients,
    appointmentsThisMonth,
    whatsappConnected: connected,
  };
}

// Todas as pessoas cadastradas na Sysora, com as empresas e o papel em cada uma.
export async function listUsers() {
  const users = await prisma.user.findMany({
    orderBy: { createdAt: 'desc' },
    include: {
      memberships: { include: { company: { select: { id: true, name: true, active: true } } }, orderBy: { createdAt: 'asc' } },
    },
  });
  return users.map((u) => ({
    id: u.id,
    name: u.name,
    email: u.email,
    phone: u.phone,
    avatarUrl: u.avatarUrl,
    isSuperAdmin: u.isSuperAdmin,
    active: u.active,
    google: Boolean(u.googleLinkedAt),
    lastLoginAt: u.lastLoginAt,
    createdAt: u.createdAt,
    companies: u.memberships.map((m) => ({
      id: m.company.id,
      name: m.company.name,
      companyActive: m.company.active,
      role: m.role,
      status: m.status,
      active: m.active,
    })),
  }));
}

export async function listCompanies() {
  const companies = await prisma.company.findMany({
    where: customerCompany,
    orderBy: { createdAt: 'desc' },
    include: {
      account: true,
      settings: { select: { whatsappConnected: true, whatsappPhone: true, emailCodesEnabled: true, clientSubscriptionsEnabled: true } },
      memberships: { where: { status: MembershipStatus.ACTIVE, user: { isSuperAdmin: false } }, include: { user: { select: { id: true, name: true, email: true, avatarUrl: true } } } },
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
    emailCodesEnabled: c.settings?.emailCodesEnabled ?? false,
    clientSubscriptionsEnabled: c.settings?.clientSubscriptionsEnabled ?? false,
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

export async function updateCompany(
  companyId: string,
  { emailCodesEnabled, clientSubscriptionsEnabled, ...input }: Partial<CompanyInput> & { active?: boolean; emailCodesEnabled?: boolean; clientSubscriptionsEnabled?: boolean },
) {
  const company = await prisma.company.findUnique({ where: { id: companyId } });
  if (!company) throw HttpError.notFound('Empresa não encontrada.');

  const updated = await prisma.company.update({ where: { id: companyId }, data: { ...input, email: input.email === '' ? null : input.email } });
  const flags = { emailCodesEnabled, clientSubscriptionsEnabled };
  if (emailCodesEnabled !== undefined || clientSubscriptionsEnabled !== undefined) {
    await prisma.companySettings.upsert({ where: { companyId }, update: flags, create: { companyId, ...flags } });
  }
  if (input.active === false) {
    // Empresa desativada: encerra as sessões e desliga o WhatsApp dela.
    await prisma.refreshToken.updateMany({ where: { companyId, revokedAt: null }, data: { revokedAt: new Date() } });
    await disconnectWhatsApp(companyId);
  }
  return updated;
}

async function accountCompanies(accountId: string) {
  const companies = await prisma.company.findMany({ where: { accountId }, select: { id: true } });
  return companies.map((c) => c.id);
}

// Plano e status da assinatura (ajuste manual pelo master).
export async function updateAccount(accountId: string, input: { plan?: Plan; status?: SubscriptionStatus; trialEndsAt?: string | null; paidUntil?: string | null; complimentary?: boolean }) {
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
      complimentary: input.complimentary,
    },
  });
  invalidateSubscriptionCache(companyIds);
  return subscriptionSummary(updated);
}

// Pagamento recebido: conta ativa por mais um ciclo (30 dias ou, no anual, 365)
// a partir do vencimento atual, se ainda não venceu.
export async function registerPayment(accountId: string) {
  const account = await prisma.account.findUnique({ where: { id: accountId } });
  if (!account) throw HttpError.notFound('Conta não encontrada.');
  const now = new Date();
  const base = account.status === SubscriptionStatus.ACTIVE && account.paidUntil && account.paidUntil > now ? account.paidUntil : now;
  const updated = await prisma.account.update({
    where: { id: accountId },
    data: { status: SubscriptionStatus.ACTIVE, paidUntil: addCycle(base, account.billingCycle), trialEndsAt: null },
  });
  invalidateSubscriptionCache(await accountCompanies(accountId));
  return subscriptionSummary(updated);
}

export async function deleteCompany(companyId: string) {
  const company = await prisma.company.findUnique({ where: { id: companyId } });
  if (!company) throw HttpError.notFound('Empresa não encontrada.');
  await disconnectWhatsApp(companyId);
  await prisma.company.delete({ where: { id: companyId } });
  // Conta sem nenhuma empresa não tem mais o que cobrar.
  if ((await prisma.company.count({ where: { accountId: company.accountId } })) === 0) {
    await prisma.account.delete({ where: { id: company.accountId } });
  }
  invalidateSubscriptionCache([companyId]);
}

// ============ Gastos com IA (Sora) ============

const usd = (micros: number) => micros / 1_000_000;

// Resumo para o painel master: créditos colocados na Anthropic, gasto estimado
// (pelos tokens de cada chamada) e saldo. O valor oficial fica no console da Anthropic.
export async function aiUsageSummary() {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const [settings, total, month, byCompany, recent] = await Promise.all([
    getPlatformSettings(),
    prisma.aiUsage.aggregate({ _sum: { costMicros: true }, _count: true }),
    prisma.aiUsage.aggregate({ where: { createdAt: { gte: monthStart } }, _sum: { costMicros: true, inputTokens: true, outputTokens: true }, _count: true }),
    prisma.aiUsage.groupBy({ by: ['companyId'], where: { createdAt: { gte: monthStart } }, _sum: { costMicros: true }, _count: true }),
    prisma.aiUsage.findMany({ orderBy: { createdAt: 'desc' }, take: 15, include: { company: { select: { name: true } } } }),
  ]);
  const names = await prisma.company.findMany({
    where: { id: { in: byCompany.map((c) => c.companyId).filter((id): id is string => Boolean(id)) } },
    select: { id: true, name: true },
  });
  const spentUsd = usd(total._sum.costMicros ?? 0);
  const creditUsd = settings.aiCreditCents / 100;
  return {
    configured: Boolean(env.ANTHROPIC_API_KEY),
    model: env.SORA_MODEL,
    monthlyLimitPerCompany: env.SORA_MONTHLY_LIMIT,
    creditUsd,
    spentUsd,
    remainingUsd: creditUsd - spentUsd,
    calls: total._count,
    month: {
      spentUsd: usd(month._sum.costMicros ?? 0),
      calls: month._count,
      inputTokens: month._sum.inputTokens ?? 0,
      outputTokens: month._sum.outputTokens ?? 0,
    },
    byCompany: byCompany
      .map((c) => ({ companyId: c.companyId, name: names.find((n) => n.id === c.companyId)?.name ?? 'Empresa excluída', calls: c._count, spentUsd: usd(c._sum.costMicros ?? 0) }))
      .sort((a, b) => b.spentUsd - a.spentUsd),
    recent: recent.map((r) => ({
      id: r.id,
      company: r.company?.name ?? 'Empresa excluída',
      feature: r.feature,
      model: r.model,
      inputTokens: r.inputTokens + r.cacheReadTokens + r.cacheWriteTokens,
      outputTokens: r.outputTokens,
      costUsd: usd(r.costMicros),
      createdAt: r.createdAt,
    })),
  };
}

// ============ Pesquisa inicial ============

export async function surveySummary() {
  const surveys = await prisma.onboardingSurvey.findMany({
    orderBy: { createdAt: 'desc' },
    include: { user: { select: { name: true, email: true } }, company: { select: { name: true } } },
  });
  const tally = (values: string[]) => Object.entries(values.reduce<Record<string, number>>((acc, v) => ({ ...acc, [v]: (acc[v] ?? 0) + 1 }), {}))
    .map(([id, count]) => ({ id, count }))
    .sort((a, b) => b.count - a.count);
  const [users, dismissed] = await Promise.all([
    prisma.user.count({ where: { isSuperAdmin: false, memberships: { some: { status: 'ACTIVE' } } } }),
    prisma.user.count({ where: { surveyDismissedAt: { not: null }, survey: null } }),
  ]);
  return {
    total: surveys.length,
    users,
    dismissed,
    sources: tally(surveys.flatMap((s) => s.sources)),
    business: tally(surveys.map((s) => s.business)),
    teamSize: tally(surveys.map((s) => s.teamSize)),
    features: tally(surveys.flatMap((s) => s.features)),
    responses: surveys.slice(0, 100).map((s) => ({
      id: s.id,
      createdAt: s.createdAt,
      user: s.user,
      company: s.company?.name ?? null,
      sources: s.sources,
      sourceOther: s.sourceOther,
      business: s.business,
      businessOther: s.businessOther,
      teamSize: s.teamSize,
      features: s.features,
      featuresOther: s.featuresOther,
      comment: s.comment,
    })),
  };
}

// ============ LGPD: pedidos dos titulares ============

export async function privacyRequests() {
  const [requests, consents] = await Promise.all([
    prisma.privacyRequest.findMany({
      orderBy: [{ status: 'desc' }, { createdAt: 'asc' }],
      take: 300,
      include: { user: { select: { name: true, email: true, memberships: { select: { role: true, company: { select: { name: true } } } } } } },
    }),
    prisma.cookieConsent.groupBy({ by: ['analytics', 'marketing'], _count: true }),
  ]);
  return {
    requests: requests.map((r) => ({
      id: r.id, type: r.type, message: r.message, status: r.status, response: r.response, createdAt: r.createdAt, resolvedAt: r.resolvedAt,
      // Prazo de 15 dias para a resposta completa (art. 19, II).
      dueAt: new Date(r.createdAt.getTime() + 15 * 24 * 60 * 60 * 1000),
      user: { name: r.user.name, email: r.user.email, companies: r.user.memberships.map((m) => `${m.company.name} (${m.role === 'ADMIN' ? 'administrador' : 'funcionário'})`) },
    })),
    consents: {
      total: consents.reduce((sum, c) => sum + c._count, 0),
      analytics: consents.filter((c) => c.analytics).reduce((sum, c) => sum + c._count, 0),
      marketing: consents.filter((c) => c.marketing).reduce((sum, c) => sum + c._count, 0),
    },
  };
}

export async function resolvePrivacyRequest(id: string, response: string) {
  const request = await prisma.privacyRequest.findUnique({ where: { id } });
  if (!request) throw HttpError.notFound('Pedido não encontrado.');
  return prisma.privacyRequest.update({ where: { id }, data: { status: 'DONE', response, resolvedAt: new Date() } });
}
