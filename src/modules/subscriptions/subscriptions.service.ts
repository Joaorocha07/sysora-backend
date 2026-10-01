import { MercadoPagoConfig, PreApproval, PreApprovalPlan } from 'mercadopago';
import { Plan } from '@prisma/client';
import { env } from '../../config/env';
import { PLANS } from '../../lib/plans';
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
      back_url: env.APP_URL || 'https://sysora.app',
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
