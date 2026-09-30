import { Account, Plan, SubscriptionStatus } from '@prisma/client';

// Catálogo de planos do Sysora. Os preços são mensais, em centavos.
// maxEmployees: pessoas além do administrador (o dono) em cada empresa. A
// conta é "administrador + N": promover um funcionário a administrador não
// libera vaga, então o limite não pode ser contornado.
export const PLANS: Record<Plan, {
  name: string;
  priceCents: number;
  maxCompanies: number;
  maxEmployees: number;
  features: string[];
}> = {
  INICIAL: {
    name: 'Inicial',
    priceCents: 9700,
    maxCompanies: 1,
    maxEmployees: 2,
    features: [
      '1 empresa com 1 número de WhatsApp',
      'Administrador + até 2 funcionários',
      'Chatbot que cadastra e agenda',
      'Agenda, clientes e serviços ilimitados',
      'Lembretes e confirmação de presença',
    ],
  },
  AVANCADO: {
    name: 'Avançado',
    priceCents: 19700,
    maxCompanies: 2,
    maxEmployees: 5,
    features: [
      'Até 2 empresas, cada uma com o seu WhatsApp',
      'Administrador + até 5 funcionários por empresa',
      'Tudo do plano Inicial',
      'Troca rápida entre as empresas',
      'Suporte prioritário',
    ],
  },
};

export const TRIAL_DAYS = 7;
// Dias de tolerância depois do vencimento antes de bloquear o acesso.
export const GRACE_DAYS = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

type Billing = Pick<Account, 'status' | 'trialEndsAt' | 'paidUntil'>;

// A conta pode usar o sistema (e o bot pode atender)?
export function isAccountActive(account: Billing, now = new Date()): boolean {
  if (account.status === SubscriptionStatus.CANCELED) return false;
  if (account.status === SubscriptionStatus.TRIAL) return Boolean(account.trialEndsAt && account.trialEndsAt > now);
  if (!account.paidUntil) return true;
  return account.paidUntil.getTime() + GRACE_DAYS * DAY_MS > now.getTime();
}

// Resumo da assinatura para o frontend.
export function subscriptionSummary(account: Account) {
  const plan = PLANS[account.plan];
  return {
    accountId: account.id,
    plan: account.plan,
    planName: plan.name,
    priceCents: plan.priceCents,
    status: account.status,
    trialEndsAt: account.trialEndsAt,
    paidUntil: account.paidUntil,
    active: isAccountActive(account),
    maxCompanies: plan.maxCompanies,
    maxEmployees: plan.maxEmployees,
  };
}

export const planCatalog = () => (Object.keys(PLANS) as Plan[]).map((id) => ({ id, ...PLANS[id] }));

export const trialEnd = () => new Date(Date.now() + TRIAL_DAYS * DAY_MS);
export const addMonth = (from: Date) => new Date(from.getTime() + 30 * DAY_MS);
