import { MembershipStatus, Role } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { HttpError } from '../../lib/httpError';
import { hashPassword } from '../../lib/password';
import { PLANS } from '../../lib/plans';

// Equipe de uma empresa: administradores e funcionários. O admin master não
// aparece aqui (ele acessa qualquer empresa sem vínculo).

type MemberWithUser = {
  id: string;
  role: Role;
  active: boolean;
  createdAt: Date;
  user: { id: string; name: string; email: string; phone: string | null; active: boolean };
};

function toMember(m: MemberWithUser) {
  return {
    membershipId: m.id,
    id: m.user.id,
    name: m.user.name,
    email: m.user.email,
    phone: m.user.phone,
    role: m.role,
    active: m.active && m.user.active,
    createdAt: m.createdAt,
  };
}

export async function listMembers(companyId: string) {
  const memberships = await prisma.companyMembership.findMany({
    where: { companyId, status: MembershipStatus.ACTIVE, user: { isSuperAdmin: false } },
    include: { user: true },
    orderBy: { createdAt: 'asc' },
  });
  return memberships.map(toMember);
}

async function assertSeatAvailable(companyId: string) {
  const [company, used] = await Promise.all([
    prisma.company.findUniqueOrThrow({ where: { id: companyId }, include: { account: true } }),
    prisma.companyMembership.count({ where: { companyId, active: true, status: MembershipStatus.ACTIVE, user: { isSuperAdmin: false } } }),
  ]);
  const plan = PLANS[company.account.plan];
  // Vagas = o administrador (dono) + maxEmployees funcionários.
  if (used >= plan.maxEmployees + 1) {
    const hint = company.account.plan === 'INICIAL' ? ` Passe para o plano Avançado para ter até ${PLANS.AVANCADO.maxEmployees}.` : '';
    throw HttpError.forbidden(`O plano ${plan.name} permite o administrador e até ${plan.maxEmployees} funcionários ativos por empresa.${hint}`);
  }
}

export async function createMember(companyId: string, input: { name: string; email: string; phone?: string | null; password: string; role: Role }) {
  await assertSeatAvailable(companyId);

  let user = await prisma.user.findUnique({ where: { email: input.email } });
  if (user?.isSuperAdmin) throw HttpError.conflict('Este e-mail pertence a um administrador master.');
  if (user) {
    const existing = await prisma.companyMembership.findUnique({ where: { userId_companyId: { userId: user.id, companyId } } });
    // Já tinha pedido acesso pelo cadastro: cadastrar à mão equivale a aprovar.
    if (existing?.status === MembershipStatus.PENDING) return approveMember(companyId, existing.id, input.role);
    if (existing) throw HttpError.conflict('Este e-mail já faz parte da equipe.');
  } else {
    user = await prisma.user.create({
      data: { name: input.name, email: input.email, phone: input.phone || null, passwordHash: await hashPassword(input.password) },
    });
  }

  const membership = await prisma.companyMembership.create({
    data: { userId: user.id, companyId, role: input.role },
    include: { user: true },
  });
  return toMember(membership);
}

async function findMembership(companyId: string, membershipId: string) {
  const membership = await prisma.companyMembership.findFirst({
    where: { id: membershipId, companyId, status: MembershipStatus.ACTIVE, user: { isSuperAdmin: false } },
    include: { user: true },
  });
  if (!membership) throw HttpError.notFound('Usuário não encontrado nesta empresa.');
  return membership;
}

// Toda empresa precisa manter um administrador ativo.
async function protectLastAdmin(companyId: string, membershipId: string) {
  const target = await findMembership(companyId, membershipId);
  if (target.role !== Role.ADMIN || !target.active) return;
  const admins = await prisma.companyMembership.count({ where: { companyId, role: Role.ADMIN, active: true, status: MembershipStatus.ACTIVE, user: { isSuperAdmin: false } } });
  if (admins <= 1) throw HttpError.badRequest('Mantenha pelo menos um administrador ativo na empresa.');
}

export async function updateMember(
  requesterId: string,
  companyId: string,
  membershipId: string,
  input: { name?: string; phone?: string | null; role?: Role; active?: boolean; password?: string },
) {
  const membership = await findMembership(companyId, membershipId);
  if (membership.userId === requesterId && (input.active === false || input.role === Role.EMPLOYEE)) {
    throw HttpError.badRequest('Você não pode remover o seu próprio acesso de administrador.');
  }
  if (input.active === false || input.role === Role.EMPLOYEE) await protectLastAdmin(companyId, membershipId);
  if (input.active === true && !membership.active) await assertSeatAvailable(companyId);

  if (input.password) {
    // Senha é da conta, não da empresa: só troca se a pessoa não tiver acesso a outras empresas.
    const others = await prisma.companyMembership.count({ where: { userId: membership.userId, companyId: { not: companyId } } });
    if (others > 0) throw HttpError.forbidden('Este usuário também acessa outra empresa. Ele deve trocar a senha em "Esqueci minha senha".');
  }

  await prisma.$transaction([
    prisma.user.update({
      where: { id: membership.userId },
      data: {
        name: input.name,
        phone: input.phone,
        ...(input.password ? { passwordHash: await hashPassword(input.password) } : {}),
      },
    }),
    prisma.companyMembership.update({ where: { id: membershipId }, data: { role: input.role, active: input.active } }),
    ...(input.active === false || input.password
      ? [prisma.refreshToken.updateMany({ where: { userId: membership.userId, companyId, revokedAt: null }, data: { revokedAt: new Date() } })]
      : []),
  ]);

  return toMember(await findMembership(companyId, membershipId));
}

export async function removeMember(requesterId: string, companyId: string, membershipId: string) {
  const membership = await findMembership(companyId, membershipId);
  if (membership.userId === requesterId) throw HttpError.badRequest('Você não pode remover a si mesmo.');
  await protectLastAdmin(companyId, membershipId);
  await prisma.$transaction([
    prisma.companyMembership.delete({ where: { id: membershipId } }),
    prisma.refreshToken.updateMany({ where: { userId: membership.userId, companyId, revokedAt: null }, data: { revokedAt: new Date() } }),
  ]);
}

// ============ Pedidos de acesso (cadastro do funcionário) ============

export async function listPending(companyId: string) {
  const memberships = await prisma.companyMembership.findMany({
    where: { companyId, status: MembershipStatus.PENDING },
    include: { user: true },
    orderBy: { createdAt: 'asc' },
  });
  return memberships.map(toMember);
}

async function findPending(companyId: string, membershipId: string) {
  const membership = await prisma.companyMembership.findFirst({ where: { id: membershipId, companyId, status: MembershipStatus.PENDING } });
  if (!membership) throw HttpError.notFound('Pedido de acesso não encontrado.');
  return membership;
}

export async function approveMember(companyId: string, membershipId: string, role: Role = Role.EMPLOYEE) {
  await findPending(companyId, membershipId);
  await assertSeatAvailable(companyId);
  const membership = await prisma.companyMembership.update({
    where: { id: membershipId },
    data: { status: MembershipStatus.ACTIVE, active: true, role },
    include: { user: true },
  });
  return toMember(membership);
}

// Recusar apaga o pedido: a pessoa pode pedir de novo, se foi engano.
export async function rejectMember(companyId: string, membershipId: string) {
  await findPending(companyId, membershipId);
  await prisma.companyMembership.delete({ where: { id: membershipId } });
}
