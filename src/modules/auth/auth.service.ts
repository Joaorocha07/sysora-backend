import { MembershipStatus, Plan, Role, SubscriptionStatus } from '@prisma/client';
import { TERMS_VERSION } from '../../lib/legal';
import { isAccountActive, subscriptionSummary, trialEnd } from '../../lib/plans';
import { normalizeInviteCode, uniqueInviteCode } from '../../lib/inviteCode';
import { uniqueCompanySlug } from '../../lib/slug';
import { prisma } from '../../lib/prisma';
import { HttpError } from '../../lib/httpError';
import { comparePassword, hashPassword } from '../../lib/password';
import { verifyGoogleAccessToken } from '../../lib/supabase';
import {
  generateOpaqueToken,
  hashToken,
  refreshTokenExpiryDate,
  signAccessToken,
  signGoogleSignupToken,
  signPreAuthToken,
  verifyGoogleSignupToken,
  verifyPreAuthToken,
} from '../../lib/jwt';

// Sessões da Sysora:
// - Admin master (User.isSuperAdmin): entra no painel master (sem empresa) e
//   pode abrir qualquer empresa ativa como administrador.
// - Admin/funcionário: entra direto na empresa; se tiver acesso a mais de
//   uma, escolhe qual (pre-auth token de curta duração).

export type SessionUser = { id: string; name: string; email: string; isSuperAdmin: boolean; avatarUrl: string | null };
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
  // Aviso para o usuário (ex.: foi levado para outra empresa porque o plano da atual venceu).
  notice?: string;
};

// available = falso quando o funcionário não pode entrar porque o plano da
// empresa venceu (o admin sempre entra, em modo somente leitura).
export type CompanyChoice = SessionCompany & { role: Role; available: boolean };

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

  if (!company.active) throw HttpError.forbidden('Esta empresa está desativada. Fale com o suporte da Sysora.');
  const membership = await prisma.companyMembership.findUnique({ where: { userId_companyId: { userId, companyId } } });
  if (!membership || !membership.active) throw HttpError.forbidden('Você não tem acesso a esta empresa.');
  if (membership.status === MembershipStatus.PENDING) throw HttpError.forbidden('Seu acesso a esta empresa ainda aguarda a aprovação do administrador.');
  if (membership.status !== MembershipStatus.ACTIVE) throw HttpError.forbidden('Seu pedido de acesso a esta empresa foi recusado pelo administrador.');
  // Assinatura vencida: o admin entra em modo somente leitura para regularizar;
  // funcionários ficam de fora até a renovação.
  if (membership.role !== Role.ADMIN && !isAccountActive(company.account)) throw HttpError.companyPlanExpired(company.name);
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
    user: { id: user.id, name: user.name, email: user.email, isSuperAdmin: user.isSuperAdmin, avatarUrl: user.avatarUrl },
    company: company ? { id: company.id, name: company.name, slug: company.slug } : null,
    role,
    subscription: company ? subscriptionSummary(company.account) : null,
  };
}

async function activeCompanies(userId: string): Promise<CompanyChoice[]> {
  const memberships = await prisma.companyMembership.findMany({
    where: { userId, active: true, status: MembershipStatus.ACTIVE, company: { active: true } },
    include: { company: { include: { account: true } } },
    orderBy: { company: { name: 'asc' } },
  });
  return memberships.map((m) => ({
    id: m.company.id,
    name: m.company.name,
    slug: m.company.slug,
    role: m.role,
    available: m.role === Role.ADMIN || isAccountActive(m.company.account),
  }));
}

export type LoginResult =
  | { status: 'ok'; session: SessionResult }
  | { status: 'select-company'; preAuthToken: string; companies: CompanyChoice[] };

export async function login(input: { email: string; password: string }): Promise<LoginResult> {
  const user = await prisma.user.findUnique({ where: { email: input.email } });
  const invalidCredentials = () => HttpError.unauthorized('E-mail ou senha inválidos.');
  if (!user || !user.active) throw invalidCredentials();
  if (!(await comparePassword(input.password, user.passwordHash))) throw invalidCredentials();
  return startLogin(user);
}

export type GoogleLoginResult =
  | LoginResult
  | { status: 'signup-required'; signupToken: string; email: string; name: string; avatarUrl: string | null };

// Login com Google (Supabase Auth). E-mail já cadastrado entra como no login
// por senha (e atualiza a foto); e-mail novo recebe um token para concluir o cadastro.
// intent 'join' (cadastro de funcionário pelo convite): sempre devolve o token,
// para quem já tem conta (ex.: trabalha em outra empresa) pedir acesso a mais uma.
export async function loginWithGoogle(accessToken: string, intent: 'login' | 'join' = 'login'): Promise<GoogleLoginResult> {
  const profile = await verifyGoogleAccessToken(accessToken);
  const user = await prisma.user.findUnique({ where: { email: profile.email } });
  if (!user || (intent === 'join' && !user.isSuperAdmin)) {
    if (user && !user.active) throw HttpError.unauthorized('Usuário inativo.');
    return { status: 'signup-required', signupToken: signGoogleSignupToken(profile), ...profile, name: user?.name ?? profile.name };
  }
  if (!user.active) throw HttpError.unauthorized('Usuário inativo.');
  await prisma.user.update({
    where: { id: user.id },
    data: { avatarUrl: profile.avatarUrl ?? user.avatarUrl, googleLinkedAt: user.googleLinkedAt ?? new Date() },
  });
  return startLogin(user);
}

async function startLogin(user: { id: string; isSuperAdmin: boolean }): Promise<LoginResult> {
  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  if (user.isSuperAdmin) return { status: 'ok', session: await issueSession(user.id, null) };

  const companies = await activeCompanies(user.id);
  if (companies.length === 0) {
    const pending = await prisma.companyMembership.count({ where: { userId: user.id, status: MembershipStatus.PENDING } });
    if (pending) throw HttpError.forbidden('Seu cadastro foi recebido e aguarda a aprovação do administrador da empresa.');
    const rejected = await prisma.companyMembership.count({ where: { userId: user.id, status: MembershipStatus.REJECTED } });
    if (rejected) throw HttpError.forbidden('Seu pedido de acesso foi recusado pelo administrador da empresa. Fale com ele ou peça acesso de novo pelo convite.');
    throw HttpError.forbidden('Este usuário não tem acesso a nenhuma empresa ativa.');
  }

  // Funcionário de várias empresas (de donos diferentes): entra se pelo menos
  // uma estiver com o plano em dia; as vencidas aparecem bloqueadas na escolha.
  const available = companies.filter((c) => c.available);
  if (available.length === 0) throw HttpError.companyPlanExpired(companies[0].name, companies.length > 1);
  if (available.length === 1) return { status: 'ok', session: await issueSession(user.id, available[0].id) };

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
  return companies.map((c) => ({ id: c.id, name: c.name, slug: c.slug, role: Role.ADMIN, available: true }));
}

// Equipes do usuário para o perfil: aprovadas, pendentes e recusadas.
// planActive avisa quando o plano da empresa venceu (o funcionário não entra).
export async function listMyMemberships(userId: string) {
  const memberships = await prisma.companyMembership.findMany({
    where: { userId },
    include: { company: { include: { account: true } } },
    orderBy: [{ createdAt: 'desc' }],
  });
  return memberships.map((m) => ({
    membershipId: m.id,
    company: { id: m.company.id, name: m.company.name, active: m.company.active },
    role: m.role,
    status: m.status,
    // Aprovado, mas desativado pelo admin.
    active: m.active,
    planActive: isAccountActive(m.company.account),
    requestedAt: m.createdAt,
    decidedAt: m.decidedAt,
  }));
}

export async function refreshSession(rawRefreshToken: string): Promise<SessionResult> {
  const stored = await prisma.refreshToken.findUnique({ where: { tokenHash: hashToken(rawRefreshToken) } });
  if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
    throw HttpError.unauthorized('Sessão expirada. Faça login novamente.');
  }

  let session: SessionResult;
  try {
    session = await issueSession(stored.userId, stored.companyId);
  } catch (err) {
    // O plano da empresa atual venceu: se o funcionário trabalha em outra com o
    // plano em dia, a sessão continua nela; senão, sai com o aviso.
    if (!(err instanceof HttpError) || err.code !== 'COMPANY_SUBSCRIPTION_INACTIVE') throw err;
    const fallback = (await activeCompanies(stored.userId)).find((c) => c.available);
    if (!fallback) throw err;
    session = { ...(await issueSession(stored.userId, fallback.id)), notice: `${err.message} Você foi levado para ${fallback.name}.` };
  }
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
    prisma.user.findUniqueOrThrow({ where: { id: auth.userId }, select: { id: true, name: true, email: true, isSuperAdmin: true, avatarUrl: true } }),
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
type Credentials = { email?: string; password?: string; googleToken?: string };

// Cadastro com senha ou com o token de cadastro do login com Google. Quem
// entra pelo Google recebe uma senha aleatória (pode criar uma pelo
// "Esqueci minha senha") e o e-mail vem do token, não do formulário.
// `google` traz a foto e a data do vínculo para gravar no usuário.
function resolveCredentials(input: Credentials): {
  email: string;
  password: string;
  google: { avatarUrl: string | null; googleLinkedAt: Date } | null;
} {
  if (input.googleToken) {
    let token;
    try {
      token = verifyGoogleSignupToken(input.googleToken);
    } catch {
      throw HttpError.unauthorized('O cadastro com Google expirou. Entre com o Google novamente.');
    }
    return { email: token.email, password: generateOpaqueToken(), google: { avatarUrl: token.avatarUrl ?? null, googleLinkedAt: new Date() } };
  }
  if (!input.email || !input.password) throw HttpError.badRequest('Informe o e-mail e a senha.');
  return { email: input.email, password: input.password, google: null };
}

// LGPD: aceite dos Termos e da Política de Privacidade no cadastro pelo site.
const termsAccepted = () => ({ termsAcceptedAt: new Date(), termsVersion: TERMS_VERSION });

export async function registerCompany(input: Credentials & { companyName: string; name: string; phone?: string | null; plan: Plan }) {
  const { email, password, google } = resolveCredentials(input);
  if (await prisma.user.findUnique({ where: { email } })) {
    throw HttpError.conflict('Este e-mail já tem uma conta na Sysora. Entre com ele ou use outro e-mail.');
  }

  const [slug, inviteCode, passwordHash] = await Promise.all([
    uniqueCompanySlug(input.companyName),
    uniqueInviteCode(),
    hashPassword(password),
  ]);

  const created = await prisma.$transaction(async (tx) => {
    const account = await tx.account.create({
      // O teste grátis é sempre o do plano Inicial (a IA do Avançado só libera com o pagamento).
      data: { name: input.companyName, plan: Plan.INICIAL, status: SubscriptionStatus.TRIAL, trialEndsAt: trialEnd() },
    });
    const company = await tx.company.create({
      data: {
        accountId: account.id,
        name: input.companyName,
        slug,
        inviteCode,
        email,
        phone: input.phone || null,
        selfSignup: true,
        settings: { create: {} },
      },
    });
    const user = await tx.user.create({ data: { name: input.name, email, phone: input.phone || null, passwordHash, ...google, lastLoginAt: new Date(), ...termsAccepted() } });
    await tx.companyMembership.create({ data: { userId: user.id, companyId: company.id, role: Role.ADMIN } });
    return { userId: user.id, companyId: company.id };
  });

  return issueSession(created.userId, created.companyId);
}

// Nome da empresa de um código de convite (para o funcionário conferir antes de enviar).
export async function lookupInvite(code: string) {
  const company = await prisma.company.findUnique({ where: { inviteCode: normalizeInviteCode(code) }, include: { account: true } });
  if (!company || !company.active) throw HttpError.notFound('Código não encontrado. Confira com o administrador da empresa.');
  return { name: company.name, subscriptionActive: isAccountActive(company.account) };
}

// Funcionário pede acesso com o código da empresa; entra só depois que o admin aprovar.
export async function registerEmployee(input: Credentials & { inviteCode: string; name: string; phone?: string | null }) {
  // Com o plano vencido o cadastro continua aceito; o acesso só libera depois
  // da aprovação e da renovação (ver resolveAccess).
  const company = await prisma.company.findUnique({ where: { inviteCode: normalizeInviteCode(input.inviteCode) }, include: { account: true } });
  if (!company || !company.active) throw HttpError.notFound('Código não encontrado. Confira com o administrador da empresa.');

  const { email, password, google } = resolveCredentials(input);
  let user = await prisma.user.findUnique({ where: { email } });
  if (user) {
    // Conta já existe (ex.: trabalha em outra empresa): confirma que é o dono
    // dela. Pelo Google o e-mail já foi confirmado.
    if (user.isSuperAdmin || (!google && !(await comparePassword(password, user.passwordHash)))) {
      throw HttpError.conflict(user.googleLinkedAt
        ? 'Este e-mail já tem uma conta na Sysora criada com o Google. Use o botão "Cadastrar com Google" para pedir acesso a esta empresa.'
        : 'Este e-mail já tem uma conta na Sysora. Use a mesma senha dela para pedir acesso a esta empresa.');
    }
    // Aceitou os termos na tela de pedido de acesso (LGPD).
    await prisma.user.update({ where: { id: user.id }, data: termsAccepted() });
    const existing = await prisma.companyMembership.findUnique({ where: { userId_companyId: { userId: user.id, companyId: company.id } } });
    if (existing?.status === MembershipStatus.PENDING) throw HttpError.conflict('Você já pediu acesso a esta empresa. Aguarde a aprovação do administrador.');
    if (existing?.status === MembershipStatus.REJECTED) {
      // Pedido recusado antes: vale pedir de novo (volta para a fila do admin).
      await prisma.companyMembership.update({
        where: { id: existing.id },
        data: { status: MembershipStatus.PENDING, role: Role.EMPLOYEE, createdAt: new Date(), decidedAt: null },
      });
      return { companyName: company.name, subscriptionActive: isAccountActive(company.account) };
    }
    if (existing) throw HttpError.conflict('Você já faz parte desta empresa. É só entrar.');
    if (google) {
      await prisma.user.update({
        where: { id: user.id },
        data: { avatarUrl: google.avatarUrl ?? user.avatarUrl, googleLinkedAt: user.googleLinkedAt ?? google.googleLinkedAt },
      });
    }
  } else {
    user = await prisma.user.create({
      data: { name: input.name, email, phone: input.phone || null, passwordHash: await hashPassword(password), ...google, ...termsAccepted() },
    });
  }

  await prisma.companyMembership.create({
    data: { userId: user.id, companyId: company.id, role: Role.EMPLOYEE, status: MembershipStatus.PENDING },
  });
  return { companyName: company.name, subscriptionActive: isAccountActive(company.account) };
}
