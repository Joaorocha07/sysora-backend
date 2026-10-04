import { Request, Response, Router } from 'express';
import { env } from '../../config/env';
import { asyncHandler } from '../../lib/asyncHandler';
import { prisma } from '../../lib/prisma';
import { invalidateSubscriptionCache } from '../../middlewares/subscription.middleware';
import {
  applyInvoice, applyPixPayment, getMpInvoice, getMpPayment, getMpSubscription,
} from '../subscriptions/subscriptions.service';
import { handleWebhook, markWebhookReceived, verifyCompanySignature, verifySignature, webhookVerifyToken } from '../whatsapp/whatsapp.cloud';

export const webhooksRouter = Router();

// GET /api/webhooks/whatsapp — verificação da URL ao salvar o webhook no painel do app da Meta.
webhooksRouter.get('/whatsapp', (req: Request, res: Response) => {
  const ok = req.query['hub.mode'] === 'subscribe'
    && Boolean(env.META_WEBHOOK_VERIFY_TOKEN)
    && req.query['hub.verify_token'] === env.META_WEBHOOK_VERIFY_TOKEN;
  if (!ok) return res.sendStatus(403);
  return res.status(200).send(String(req.query['hub.challenge'] ?? ''));
});

// POST /api/webhooks/whatsapp — mensagens e status da API oficial do WhatsApp.
// Assinado pela Meta com o segredo do app (X-Hub-Signature-256). Responde 200
// na hora e processa depois, senão a Meta reenvia.
webhooksRouter.post('/whatsapp', (req: Request, res: Response) => {
  if (!verifySignature(req.rawBody, req.get('x-hub-signature-256'))) return res.sendStatus(401);
  handleWebhook(req.body).catch((err) => console.error('Erro no webhook do WhatsApp:', err));
  return res.sendStatus(200);
});

// Conexão manual: cada empresa aponta o app da Meta dela para a própria URL.
// O verify token é derivado do id da empresa; a assinatura usa o segredo do app dela.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

webhooksRouter.get('/whatsapp/:companyId', (req: Request, res: Response) => {
  const { companyId } = req.params;
  const ok = UUID.test(companyId) && req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === webhookVerifyToken(companyId);
  if (!ok) return res.sendStatus(403);
  return res.status(200).send(String(req.query['hub.challenge'] ?? ''));
});

webhooksRouter.post('/whatsapp/:companyId', asyncHandler(async (req: Request, res: Response) => {
  const { companyId } = req.params;
  if (!UUID.test(companyId) || !(await verifyCompanySignature(companyId, req.rawBody, req.get('x-hub-signature-256')))) return res.sendStatus(401);
  markWebhookReceived(companyId).catch(() => {});
  handleWebhook(req.body, companyId).catch((err) => console.error('Erro no webhook do WhatsApp:', err));
  return res.sendStatus(200);
}));

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
