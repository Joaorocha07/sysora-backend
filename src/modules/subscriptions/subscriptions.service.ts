import { randomUUID } from 'crypto';
import { MercadoPagoConfig, Payment, PreApproval, PreApprovalPlan } from 'mercadopago';
import { Plan } from '@prisma/client';
import { env } from '../../config/env';
import { addMonth, PLANS } from '../../lib/plans';
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

// ---------- Pix (pagamento avulso de 1 mês) ----------

// external_reference no formato "pix:<accountId>:<plan>" liga o pagamento à conta.
export function pixReference(accountId: string, plan: Plan) {
  return `pix:${accountId}:${plan}`;
}

export function parsePixReference(ref: string | null | undefined): { accountId: string; plan: Plan } | null {
  const [prefix, accountId, plan] = (ref ?? '').split(':');
  if (prefix !== 'pix' || !accountId || !(plan in Plan)) return null;
  return { accountId, plan: plan as Plan };
}

export async function createPixPayment(accountId: string, plan: Plan, payerEmail: string) {
  const client = getClient();
  const planData = PLANS[plan];
  return new Payment(client).create({
    body: {
      transaction_amount: planData.priceCents / 100,
      description: `Sysora ${planData.name} - 1 mês`,
      payment_method_id: 'pix',
      payer: { email: payerEmail },
      external_reference: pixReference(accountId, plan),
    },
    requestOptions: { idempotencyKey: randomUUID() },
  });
}

export async function getMpPayment(paymentId: string) {
  const client = getClient();
  return new Payment(client).get({ id: paymentId });
}

// Ativa a conta a partir de um pagamento Pix aprovado. Idempotente: paidUntil é
// calculado a partir da data de aprovação, então reprocessar não estende o prazo.
export async function applyPixPayment(payment: Awaited<ReturnType<typeof getMpPayment>>) {
  const ref = parsePixReference(payment.external_reference);
  if (!ref || payment.status !== 'approved') return false;

  const account = await prisma.account.findUnique({ where: { id: ref.accountId } });
  if (!account) return false;

  // Pix substitui a assinatura recorrente no cartão, para não cobrar em dobro.
  if (account.mpSubscriptionId) {
    try { await cancelMpSubscription(account.mpSubscriptionId); } catch { /* ignora */ }
  }

  const approvedAt = payment.date_approved ? new Date(payment.date_approved) : new Date();
  await prisma.account.update({
    where: { id: account.id },
    data: { plan: ref.plan, status: 'ACTIVE', paidUntil: addMonth(approvedAt), mpSubscriptionId: null },
  });

  const companies = await prisma.company.findMany({ where: { accountId: account.id }, select: { id: true } });
  invalidateSubscriptionCache(companies.map((c) => c.id));
  return true;
}
