import { Request, Response, Router } from 'express';
import { asyncHandler } from '../../lib/asyncHandler';
import { prisma } from '../../lib/prisma';
import { invalidateSubscriptionCache } from '../../middlewares/subscription.middleware';
import {
  applyInvoice, applyPixPayment, getMpInvoice, getMpPayment, getMpSubscription,
} from '../subscriptions/subscriptions.service';

export const webhooksRouter = Router();

// POST /api/webhooks/mercadopago — público, sem autenticação.
// O MP envia notificações de mudança de status da assinatura e de pagamentos.
webhooksRouter.post('/mercadopago', asyncHandler(async (req: Request, res: Response) => {
  const { type, data } = req.body as { type?: string; data?: { id?: string } };

  if (type === 'subscription_preapproval' && data?.id) {
    await handleSubscriptionEvent(data.id);
  }

  if (type === 'subscription_authorized_payment' && data?.id) {
    // Uma cobrança da assinatura foi processada (aprovada ou recusada).
    await applyInvoice(await getMpInvoice(String(data.id)));
  }

  if (type === 'payment' && data?.id) {
    // Pagamento avulso (Pix) aprovado; ativa a conta referenciada.
    try { await applyPixPayment(await getMpPayment(String(data.id))); } catch { /* ignora */ }
  }

  // Sempre retorna 200 para o MP não reenviar a notificação.
  return res.sendStatus(200);
}));

// Mudança de estado da assinatura. Não mexe em paidUntil: só cobranças aprovadas
// (subscription_authorized_payment) estendem o acesso.
async function handleSubscriptionEvent(mpSubscriptionId: string) {
  const account = await prisma.account.findFirst({ where: { mpSubscriptionId } });
  if (!account) return;

  const mpSub = await getMpSubscription(mpSubscriptionId);

  if (mpSub.status === 'cancelled') {
    await prisma.account.update({ where: { id: account.id }, data: { status: 'CANCELED', mpSubscriptionId: null } });
  } else if (mpSub.status === 'paused' && account.status === 'ACTIVE') {
    await prisma.account.update({ where: { id: account.id }, data: { status: 'PAST_DUE' } });
  } else {
    return;
  }

  const companies = await prisma.company.findMany({ where: { accountId: account.id }, select: { id: true } });
  invalidateSubscriptionCache(companies.map((c) => c.id));
}
