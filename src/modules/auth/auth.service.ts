import { MembershipStatus, Plan, Role, SubscriptionStatus } from '@prisma/client';
import { subscriptionSummary, trialEnd } from '../../lib/plans';
import { normalizeInviteCode, uniqueInviteCode } from '../../lib/inviteCode';
import { uniqueCompanySlug } from '../../lib/slug';
import { prisma } from '../../lib/prisma';
import { HttpError } from '../../lib/httpError';
import { comparePassword, hashPassword } from '../../lib/password';
import {
  generateOpaqueToken,
  hashToken,
  refreshTokenExpiryDate,
  signAccessToken,
  signPreAuthToken,
  verifyPreAuthToken,
} from '../../lib/jwt';

// Sessões do Sysora:
// - Admin master (User.isSuperAdmin): entra no painel master (sem empresa) e
//   pode abrir qualquer empresa ativa como administrador.
// - Admin/funcionário: entra direto na empresa; se tiver acesso a mais de
//   uma, escolhe qual (pre-auth token de curta duração).

export type SessionUser = { id: string; name: string; email: string; isSuperAdmin: boolean };
export type SessionCompany = { id: string; name: string; slug: string };

export type SessionResult = {
  accessToken: string;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
  user: SessionUser;
  company: SessionCompany | null;
  role: Role | null;
  // Assinatura da conta dona da empresa (nula no painel master).
  subscription: ReturnType<typeof subscriptionSummary> | null;
};

export type CompanyChoice = SessionCompany & { role: Role };

async function resolveAccess(userId: string, companyId: string | null) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || !user.active) throw HttpError.unauthorized('Usuário inativo.');

  if (!companyId) {
    if (!user.isSuperAdmin) throw HttpError.forbidden('Selecione uma empresa para continuar.');
    return { user, company: null, role: null };
  }

  const company = await prisma.company.findUnique({ where: { id: companyId }, include: { account: true } });
  if (!company) throw HttpError.notFound('Empresa não encontrada.');

  if (user.isSuperAdmin) return { user, company, role: Role.ADMIN };

  if (!company.active) throw HttpError.forbidden('Esta empresa está desativada. Fale com o suporte do Sysora.');
  const membership = await prisma.companyMembership.findUnique({ where: { userId_companyId: { userId, companyId } } });
  if (!membership || !membership.active) throw HttpError.forbidden('Você não tem acesso a esta empresa.');
  if (membership.status === MembershipStatus.PENDING) throw HttpError.forbidden('Seu acesso a esta empresa ainda aguarda a aprovação do administrador.');
  return { user, company, role: membership.role };
}

async function issueSession(userId: string, companyId: string | null): Promise<SessionResult> {
  const { user, company, role } = await resolveAccess(userId, companyId);
  const refreshToken = generateOpaqueToken();
  const refreshTokenExpiresAt = refreshTokenExpiryDate();

  await prisma.refreshToken.create({
    data: { userId, companyId, tokenHash: hashToken(refreshToken), expiresAt: refreshTokenExpiresAt },
  });

  return {
    accessToken: signAccessToken({ sub: userId, companyId, role, isSuperAdmin: user.isSuperAdmin }),
    refreshToken,
    refreshTokenExpiresAt,
    user: { id: user.id, name: user.name, email: user.email, isSuperAdmin: user.isSuperAdmin },
    company: company ? { id: company.id, name: company.name, slug: company.slug } : null,
    role,
    subscription: company ? subscriptionSummary(company.account) : null,
  };
}

async function activeCompanies(userId: string): Promise<CompanyChoice[]> {
  const memberships = await prisma.companyMembership.findMany({
    where: { userId, active: true, status: MembershipStatus.ACTIVE, company: { active: true } },
    include: { company: true },
    orderBy: { company: { name: 'asc' } },
  });
  return memberships.map((m) => ({ id: m.company.id, name: m.company.name, slug: m.company.slug, role: m.role }));
}

export type LoginResult =
  | { status: 'ok'; session: SessionResult }
  | { status: 'select-company'; preAuthToken: string; companies: CompanyChoice[] };

export async function login(input: { email: string; password: string }): Promise<LoginResult> {
  const user = await prisma.user.findUnique({ where: { email: input.email } });
  const invalidCredentials = () => HttpError.unauthorized('E-mail ou senha inválidos.');
  if (!user || !user.active) throw invalidCredentials();
  if (!(await comparePassword(input.password, user.passwordHash))) throw invalidCredentials();

  if (user.isSuperAdmin) return { status: 'ok', session: await issueSession(user.id, null) };

  const companies = await activeCompanies(user.id);
  if (companies.length === 0) {
    const pending = await prisma.companyMembership.count({ where: { userId: user.id, status: MembershipStatus.PENDING } });
    if (pending) throw HttpError.forbidden('Seu cadastro foi recebido e aguarda a aprovação do administrador da empresa.');
    throw HttpError.forbidden('Este usuário não tem acesso a nenhuma empresa ativa.');
  }
  if (companies.length === 1) return { status: 'ok', session: await issueSession(user.id, companies[0].id) };

  return { status: 'select-company', preAuthToken: signPreAuthToken({ sub: user.id }), companies };
}

export async function selectCompany(input: { preAuthToken: string; companyId: string }): Promise<SessionResult> {
  let userId: string;
  try {
    userId = verifyPreAuthToken(input.preAuthToken).sub;
  } catch {
    throw HttpError.unauthorized('Sessão de login expirada. Faça login novamente.');
  }
  return issueSession(userId, input.companyId);
}

// Troca a empresa da sessão atual. companyId nulo volta ao painel master.
export async function switchCompany(userId: string, companyId: string | null): Promise<SessionResult> {
  return issueSession(userId, companyId);
}

export async function listMyCompanies(userId: string, isSuperAdmin: boolean): Promise<CompanyChoice[]> {
  if (!isSuperAdmin) return activeCompanies(userId);
  const companies = await prisma.company.findMany({ where: { active: true }, orderBy: { name: 'asc' } });
  return companies.map((c) => ({ id: c.id, name: c.name, slug: c.slug, role: Role.ADMIN }));
}

export async function refreshSession(rawRefreshToken: string): Promise<SessionResult> {
  const stored = await prisma.refreshToken.findUnique({ where: { tokenHash: hashToken(rawRefreshToken) } });
  if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
    throw HttpError.unauthorized('Sessão expirada. Faça login novamente.');
  }

  const session = await issueSession(stored.userId, stored.companyId);
  await prisma.refreshToken.update({
    where: { id: stored.id },
    data: { revokedAt: new Date(), replacedByTokenHash: hashToken(session.refreshToken) },
  });
  return session;
}

export async function revokeRefreshToken(rawRefreshToken: string): Promise<void> {
  await prisma.refreshToken.updateMany({
    where: { tokenHash: hashToken(rawRefreshToken), revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export async function me(auth: { userId: string; companyId: string | null; role: Role | null }) {
  const [user, company] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { id: auth.userId }, select: { id: true, name: true, email: true, isSuperAdmin: true } }),
    auth.companyId ? prisma.company.findUnique({ where: { id: auth.companyId }, select: { id: true, name: true, slug: true } }) : null,
  ]);
  return { user, company, role: auth.role };
}

const PASSWORD_RESET_EXPIRY_MS = 30 * 60 * 1000;
export const PASSWORD_RESET_MINUTES = PASSWORD_RESET_EXPIRY_MS / 60000;

export async function requestPasswordReset(email: string): Promise<{ token: string; name: string } | null> {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !user.active) return null;

  const token = generateOpaqueToken();
  await prisma.passwordResetToken.create({
    data: { userId: user.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + PASSWORD_RESET_EXPIRY_MS) },
  });
  return { token, name: user.name };
}

export async function resetPassword(rawToken: string, newPassword: string): Promise<void> {
  const record = await prisma.passwordResetToken.findUnique({ where: { tokenHash: hashToken(rawToken) } });
  if (!record || record.usedAt || record.expiresAt < new Date()) {
    throw HttpError.badRequest('Link de recuperação inválido ou expirado.');
  }

  const passwordHash = await hashPassword(newPassword);
  await prisma.$transaction([
    prisma.user.update({ where: { id: record.userId }, data: { passwordHash } }),
    prisma.passwordResetToken.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
    prisma.refreshToken.updateMany({ where: { userId: record.userId, revokedAt: null }, data: { revokedAt: new Date() } }),
  ]);
}

export async function changePassword(userId: string, currentPassword: string, newPassword: string): Promise<void> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (!(await comparePassword(currentPassword, user.passwordHash))) throw HttpError.badRequest('Senha atual incorreta.');

  await prisma.user.update({ where: { id: userId }, data: { passwordHash: await hashPassword(newPassword) } });
}

// ============ Cadastro público ============

// Dono de uma empresa nova: cria a conta (em teste grátis no plano escolhido),
// a empresa e o usuário administrador, e já entra.
export async function registerCompany(input: { companyName: string; name: string; email: string; phone?: string | null; password: string; plan: Plan }) {
  if (await prisma.user.findUnique({ where: { email: input.email } })) {
    throw HttpError.conflict('Este e-mail já tem uma conta no Sysora. Entre com ele ou use outro e-mail.');
  }

  const [slug, inviteCode, passwordHash] = await Promise.all([
    uniqueCompanySlug(input.companyName),
    uniqueInviteCode(),
    hashPassword(input.password),
  ]);

  const created = await prisma.$transaction(async (tx) => {
    const account = await tx.account.create({
      data: { name: input.companyName, plan: input.plan, status: SubscriptionStatus.TRIAL, trialEndsAt: trialEnd() },
    });
    const company = await tx.company.create({
      data: {
        accountId: account.id,
        name: input.companyName,
        slug,
        inviteCode,
        email: input.email,
        phone: input.phone || null,
        selfSignup: true,
        settings: { create: {} },
      },
    });
    const user = await tx.user.create({ data: { name: input.name, email: input.email, phone: input.phone || null, passwordHash } });
    await tx.companyMembership.create({ data: { userId: user.id, companyId: company.id, role: Role.ADMIN } });
    return { userId: user.id, companyId: company.id };
  });

  return issueSession(created.userId, created.companyId);
}

// Nome da empresa de um código de convite (para o funcionário conferir antes de enviar).
export async function lookupInvite(code: string) {
  const company = await prisma.company.findUnique({ where: { inviteCode: normalizeInviteCode(code) }, select: { name: true, active: true } });
  if (!company || !company.active) throw HttpError.notFound('Código não encontrado. Confira com o administrador da empresa.');
  return { name: company.name };
}

// Funcionário pede acesso com o código da empresa; entra só depois que o admin aprovar.
export async function registerEmployee(input: { inviteCode: string; name: string; email: string; phone?: string | null; password: string }) {
  const company = await prisma.company.findUnique({ where: { inviteCode: normalizeInviteCode(input.inviteCode) } });
  if (!company || !company.active) throw HttpError.notFound('Código não encontrado. Confira com o administrador da empresa.');

  let user = await prisma.user.findUnique({ where: { email: input.email } });
  if (user) {
    // Conta já existe (ex.: trabalha em outra empresa): confirma que é o dono dela.
    if (user.isSuperAdmin || !(await comparePassword(input.password, user.passwordHash))) {
      throw HttpError.conflict('Este e-mail já tem uma conta no Sysora. Use a mesma senha dela para pedir acesso a esta empresa.');
    }
    const existing = await prisma.companyMembership.findUnique({ where: { userId_companyId: { userId: user.id, companyId: company.id } } });
    if (existing?.status === MembershipStatus.PENDING) throw HttpError.conflict('Você já pediu acesso a esta empresa. Aguarde a aprovação do administrador.');
    if (existing) throw HttpError.conflict('Você já faz parte desta empresa. É só entrar.');
  } else {
    user = await prisma.user.create({
      data: { name: input.name, email: input.email, phone: input.phone || null, passwordHash: await hashPassword(input.password) },
    });
  }

  await prisma.companyMembership.create({
    data: { userId: user.id, companyId: company.id, role: Role.EMPLOYEE, status: MembershipStatus.PENDING },
  });
  return { companyName: company.name };
}
