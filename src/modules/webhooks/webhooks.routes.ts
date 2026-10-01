import { Request, Response, Router } from 'express';
import { asyncHandler } from '../../lib/asyncHandler';
import { addMonth } from '../../lib/plans';
import { prisma } from '../../lib/prisma';
import { invalidateSubscriptionCache } from '../../middlewares/subscription.middleware';
import { getMpSubscription } from '../subscriptions/subscriptions.service';

export const webhooksRouter = Router();

// POST /api/webhooks/mercadopago — público, sem autenticação.
// O MP envia notificações de mudança de status da assinatura e de pagamentos.
webhooksRouter.post('/mercadopago', asyncHandler(async (req: Request, res: Response) => {
  const { type, data } = req.body as { type?: string; data?: { id?: string } };

  if (type === 'subscription_preapproval' && data?.id) {
    await handleSubscriptionEvent(data.id);
  }

  if (type === 'subscription_authorized_payment' && data?.id) {
    // Um pagamento recorrente foi processado; sincroniza o status da assinatura.
    await handleAuthorizedPayment(data.id);
  }

  // Sempre retorna 200 para o MP não reenviar a notificação.
  return res.sendStatus(200);
}));

async function handleSubscriptionEvent(mpSubscriptionId: string) {
  const account = await prisma.account.findFirst({ where: { mpSubscriptionId } });
  if (!account) return;

  const mpSub = await getMpSubscription(mpSubscriptionId);

  let status: 'ACTIVE' | 'PAST_DUE' | 'CANCELED';
  if (mpSub.status === 'cancelled') {
    status = 'CANCELED';
  } else if (mpSub.status === 'paused') {
    status = 'PAST_DUE';
  } else {
    status = 'ACTIVE';
  }

  await prisma.account.update({
    where: { id: account.id },
    data: {
      status,
      paidUntil: status === 'ACTIVE' ? addMonth(new Date()) : undefined,
      mpSubscriptionId: status === 'CANCELED' ? null : undefined,
    },
  });

  const companies = await prisma.company.findMany({ where: { accountId: account.id }, select: { id: true } });
  invalidateSubscriptionCache(companies.map((c) => c.id));
}

async function handleAuthorizedPayment(_id: string) {
  // Um pagamento recorrente foi aprovado; sincroniza paidUntil de todas as contas ativas no MP.
  const accounts = await prisma.account.findMany({
    where: { mpSubscriptionId: { not: null }, status: { in: ['ACTIVE', 'PAST_DUE'] } },
    select: { id: true, mpSubscriptionId: true },
  });

  for (const account of accounts) {
    try {
      const mpSub = await getMpSubscription(account.mpSubscriptionId!);
      if (mpSub.status === 'authorized') {
        await prisma.account.update({
          where: { id: account.id },
          data: { status: 'ACTIVE', paidUntil: addMonth(new Date()) },
        });
      }
    } catch { /* continua para a próxima conta */ }
  }
}
