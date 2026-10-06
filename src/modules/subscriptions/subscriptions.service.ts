import { randomUUID } from 'crypto';
import { Invoice, MercadoPagoConfig, Payment, PreApproval, PreApprovalPlan } from 'mercadopago';
import { BillingCycle, Plan } from '@prisma/client';
import { env } from '../../config/env';
import { addCycle, addMonth, cyclePriceCents, PLANS, yearlyPriceCents } from '../../lib/plans';
import { prisma } from '../../lib/prisma';
import { invalidateSubscriptionCache } from '../../middlewares/subscription.middleware';
import { HttpError } from '../../lib/httpError';

function getClient(): MercadoPagoConfig {
  if (!env.MP_ACCESS_TOKEN) throw HttpError.badRequest('Pagamento via cartão não configurado. Entre em contato com o suporte.');
  return new MercadoPagoConfig({ accessToken: env.MP_ACCESS_TOKEN });
}

// Retorna o ID do plano no Mercado Pago, criando-o automaticamente se não existir.
export async function getMpPlanId(plan: Plan): Promise<string> {
  const envId = plan === Plan.INICIAL ? env.MP_PLAN_INICIAL_ID : env.MP_PLAN_AVANCADO_ID;
  if (envId) return envId;

  const client = getClient();
  const planData = PLANS[plan];
  const created = await new PreApprovalPlan(client).create({
    body: {
      reason: `Sysora ${planData.name}`,
      auto_recurring: {
        frequency: 1,
        frequency_type: 'months',
        transaction_amount: planData.priceCents / 100,
        currency_id: 'BRL',
      },
      payment_methods_allowed: {
        payment_types: [{ id: 'credit_card' }],
      },
      // O MP só aceita URL pública https (localhost é recusado).
      back_url: env.APP_URL?.startsWith('https://') ? env.APP_URL : 'https://sysora.app',
      status: 'active',
    },
  });

  console.warn(
    `[MP] Plano ${plan} criado com ID: ${created.id}. ` +
    `Adicione ao .env: MP_PLAN_${plan}_ID=${created.id}`,
  );

  return created.id!;
}

export async function createMpSubscription(mpPlanId: string, cardTokenId: string, payerEmail: string) {
  const client = getClient();
  return new PreApproval(client).create({
    body: {
      preapproval_plan_id: mpPlanId,
      payer_email: payerEmail,
      card_token_id: cardTokenId,
      status: 'authorized',
    },
  });
}

export async function cancelMpSubscription(mpSubscriptionId: string) {
  const client = getClient();
  return new PreApproval(client).update({
    id: mpSubscriptionId,
    body: { status: 'cancelled' },
  });
}

export async function getMpSubscription(mpSubscriptionId: string) {
  const client = getClient();
  return new PreApproval(client).get({ id: mpSubscriptionId });
}

// ---------- Cobranças da assinatura (authorized payments) ----------

export type ChargeResult = 'approved' | 'rejected' | 'pending';
type MpInvoice = Awaited<ReturnType<typeof getMpInvoice>>;

export async function getMpInvoice(invoiceId: string) {
  const client = getClient();
  return new Invoice(client).get({ id: invoiceId });
}

function chargeResult(invoice: MpInvoice): ChargeResult {
  if (invoice.payment?.status === 'approved') return 'approved';
  if (invoice.payment?.status === 'rejected' || invoice.status === 'cancelled') return 'rejected';
  return 'pending';
}

// A primeira cobrança de uma assinatura nova é processada pelo MP alguns segundos
// depois da criação. Espera até ~12s; se não sair, o webhook conclui depois.
export async function waitFirstCharge(mpSubscriptionId: string): Promise<ChargeResult> {
  const client = getClient();
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const { results } = await new Invoice(client).search({ options: { preapproval_id: mpSubscriptionId } });
    const invoices = results ?? [];
    if (invoices.some((i) => chargeResult(i) === 'approved')) return 'approved';
    if (invoices.length && invoices.every((i) => chargeResult(i) === 'rejected')) return 'rejected';
  }
  return 'pending';
}

// Aplica na conta o resultado de uma cobrança recorrente. Idempotente: paidUntil
// vem da data da cobrança e nunca é reduzido, então reprocessar não muda nada.
export async function applyInvoice(invoice: MpInvoice) {
  if (!invoice.preapproval_id) return;
  const account = await prisma.account.findFirst({ where: { mpSubscriptionId: invoice.preapproval_id } });
  if (!account) return;

  const result = chargeResult(invoice);
  if (result === 'approved') {
    const chargedAt = new Date(invoice.debit_date ?? invoice.last_modified ?? invoice.date_created ?? Date.now());
    const paidUntil = addMonth(chargedAt);
    await prisma.account.update({
      where: { id: account.id },
      data: {
        status: 'ACTIVE',
        paidUntil: account.paidUntil && account.paidUntil > paidUntil ? account.paidUntil : paidUntil,
      },
    });
  } else if (result === 'rejected' && account.status === 'ACTIVE') {
    // Renovação recusada: o MP tenta de novo nos próximos dias; a conta segue
    // ativa até paidUntil + carência.
    await prisma.account.update({ where: { id: account.id }, data: { status: 'PAST_DUE' } });
  } else {
    return;
  }

  const companies = await prisma.company.findMany({ where: { accountId: account.id }, select: { id: true } });
  invalidateSubscriptionCache(companies.map((c) => c.id));
}

// ---------- Pagamentos avulsos: Pix (1 mês ou 1 ano) e cartão no plano anual ----------

// external_reference "pay:<accountId>:<plan>:<ciclo>" liga o pagamento à conta.
// Pix gerado antes do plano anual usa "pix:<accountId>:<plan>" (sempre mensal).
export function paymentReference(accountId: string, plan: Plan, cycle: BillingCycle) {
  return `pay:${accountId}:${plan}:${cycle}`;
}

export function parsePaymentReference(ref: string | null | undefined): { accountId: string; plan: Plan; cycle: BillingCycle } | null {
  const [prefix, accountId, plan, cycle = BillingCycle.MONTHLY] = (ref ?? '').split(':');
  if ((prefix !== 'pay' && prefix !== 'pix') || !accountId || !(plan in Plan) || !(cycle in BillingCycle)) return null;
  return { accountId, plan: plan as Plan, cycle: cycle as BillingCycle };
}

function paymentDescription(plan: Plan, cycle: BillingCycle) {
  return `Sysora ${PLANS[plan].name} - ${cycle === BillingCycle.YEARLY ? '12 meses' : '1 mês'}`;
}

export async function createPixPayment(accountId: string, plan: Plan, cycle: BillingCycle, payerEmail: string) {
  const client = getClient();
  return new Payment(client).create({
    body: {
      transaction_amount: cyclePriceCents(plan, cycle) / 100,
      description: paymentDescription(plan, cycle),
      payment_method_id: 'pix',
      payer: { email: payerEmail },
      external_reference: paymentReference(accountId, plan, cycle),
    },
    requestOptions: { idempotencyKey: randomUUID() },
  });
}

// Plano anual no cartão: cobrança única, parcelada pelo Mercado Pago (juros do cliente).
export async function createYearlyCardPayment(accountId: string, plan: Plan, input: {
  cardTokenId: string; payerEmail: string; installments: number; paymentMethodId: string; issuerId?: string;
}) {
  const client = getClient();
  return new Payment(client).create({
    body: {
      transaction_amount: yearlyPriceCents(plan) / 100,
      description: paymentDescription(plan, BillingCycle.YEARLY),
      token: input.cardTokenId,
      installments: input.installments,
      payment_method_id: input.paymentMethodId,
      ...(input.issuerId ? { issuer_id: Number(input.issuerId) } : {}),
      payer: { email: input.payerEmail },
      external_reference: paymentReference(accountId, plan, BillingCycle.YEARLY),
    },
    requestOptions: { idempotencyKey: randomUUID() },
  });
}

export async function getMpPayment(paymentId: string) {
  const client = getClient();
  return new Payment(client).get({ id: paymentId });
}

// Ativa a conta a partir de um pagamento avulso aprovado. Soma o ciclo ao que
// ainda restava (pagar antes de vencer não perde dias). Idempotente: o id do
// pagamento fica em lastPaymentId e o mesmo pagamento não é somado duas vezes
// (webhook e consulta da tela podem chegar juntos).
export async function applyOneTimePayment(payment: Awaited<ReturnType<typeof getMpPayment>>) {
  const ref = parsePaymentReference(payment.external_reference);
  if (!ref || payment.status !== 'approved' || !payment.id) return false;
  const paymentId = String(payment.id);

  const account = await prisma.account.findUnique({ where: { id: ref.accountId } });
  if (!account) return false;
  if (account.lastPaymentId === paymentId) return true;

  const approvedAt = payment.date_approved ? new Date(payment.date_approved) : new Date();
  const base = account.paidUntil && account.paidUntil > approvedAt ? account.paidUntil : approvedAt;
  const { count } = await prisma.account.updateMany({
    where: { id: account.id, OR: [{ lastPaymentId: null }, { lastPaymentId: { not: paymentId } }] },
    data: {
      plan: ref.plan, billingCycle: ref.cycle, status: 'ACTIVE', paidUntil: addCycle(base, ref.cycle),
      trialEndsAt: null, mpSubscriptionId: null, lastPaymentId: paymentId,
    },
  });
  if (!count) return true;

  // O pagamento avulso substitui a assinatura recorrente no cartão, para não cobrar em dobro.
  if (account.mpSubscriptionId) {
    try { await cancelMpSubscription(account.mpSubscriptionId); } catch { /* ignora */ }
  }

  const companies = await prisma.company.findMany({ where: { accountId: account.id }, select: { id: true } });
  invalidateSubscriptionCache(companies.map((c) => c.id));
  return true;
}
