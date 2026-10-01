import { Request, Response, Router } from 'express';
import { Role } from '@prisma/client';
import { asyncHandler } from '../../lib/asyncHandler';
import { HttpError } from '../../lib/httpError';
import { addMonth, subscriptionSummary } from '../../lib/plans';
import { prisma } from '../../lib/prisma';
import { authenticate, companyOf, requireCompany, requireRole } from '../../middlewares/auth.middleware';
import { invalidateSubscriptionCache } from '../../middlewares/subscription.middleware';
import { validate } from '../../middlewares/validate.middleware';
import { checkoutSchema, pixSchema } from './subscriptions.schema';
import {
  applyPixPayment, cancelMpSubscription, createMpSubscription, createPixPayment, getMpPayment, getMpPlanId, getMpSubscription,
  parsePixReference,
} from './subscriptions.service';

async function accountOfCompany(companyId: string) {
  const company = await prisma.company.findUniqueOrThrow({ where: { id: companyId }, include: { account: true } });
  return company.account;
}

async function invalidateCompanies(accountId: string) {
  const companies = await prisma.company.findMany({ where: { accountId }, select: { id: true } });
  invalidateSubscriptionCache(companies.map((c) => c.id));
}

export const subscriptionsRouter = Router();
subscriptionsRouter.use(authenticate, requireCompany, requireRole(Role.ADMIN));

// POST /api/subscriptions/checkout — assina ou troca de plano.
subscriptionsRouter.post('/checkout', validate(checkoutSchema), asyncHandler(async (req: Request, res: Response) => {
  const { cardTokenId, payerEmail, plan } = req.body;
  const account = await accountOfCompany(companyOf(req));

  if (account.mpSubscriptionId) {
    try { await cancelMpSubscription(account.mpSubscriptionId); } catch { /* ignora erros de cancelamento anterior */ }
  }

  const mpPlanId = await getMpPlanId(plan);
  const mpSub = await createMpSubscription(mpPlanId, cardTokenId, payerEmail);

  const updated = await prisma.account.update({
    where: { id: account.id },
    data: {
      plan,
      mpSubscriptionId: mpSub.id,
      status: 'ACTIVE',
      paidUntil: addMonth(new Date()),
    },
  });

  await invalidateCompanies(account.id);
  return res.json({ subscription: subscriptionSummary(updated) });
}));

// POST /api/subscriptions/cancel — cancela a assinatura corrente.
subscriptionsRouter.post('/cancel', asyncHandler(async (req: Request, res: Response) => {
  const account = await accountOfCompany(companyOf(req));
  if (!account.mpSubscriptionId) throw HttpError.badRequest('Nenhuma assinatura ativa para cancelar.');

  await cancelMpSubscription(account.mpSubscriptionId);

  const updated = await prisma.account.update({
    where: { id: account.id },
    data: { status: 'CANCELED', mpSubscriptionId: null },
  });

  await invalidateCompanies(account.id);
  return res.json({ subscription: subscriptionSummary(updated) });
}));

// GET /api/subscriptions/status — retorna o status atual da assinatura no MP.
subscriptionsRouter.get('/status', asyncHandler(async (req: Request, res: Response) => {
  const account = await accountOfCompany(companyOf(req));
  if (!account.mpSubscriptionId) return res.json({ mpStatus: null });

  const mpSub = await getMpSubscription(account.mpSubscriptionId);
  return res.json({
    mpStatus: mpSub.status,
    nextPaymentDate: (mpSub as unknown as { next_payment_date?: string }).next_payment_date ?? null,
    lastFourDigits: (mpSub as unknown as { card?: { last_four_digits?: string } }).card?.last_four_digits ?? null,
  });
}));

// POST /api/subscriptions/pix — gera um QR Code Pix para pagar 1 mês do plano.
subscriptionsRouter.post('/pix', validate(pixSchema), asyncHandler(async (req: Request, res: Response) => {
  const { payerEmail, plan } = req.body;
  const account = await accountOfCompany(companyOf(req));

  const payment = await createPixPayment(account.id, plan, payerEmail);
  const data = payment.point_of_interaction?.transaction_data;
  if (!payment.id || !data?.qr_code || !data.qr_code_base64) {
    throw HttpError.badRequest('Não foi possível gerar o Pix. Tente novamente.');
  }

  return res.json({ paymentId: String(payment.id), qrCode: data.qr_code, qrCodeBase64: data.qr_code_base64 });
}));

// GET /api/subscriptions/pix/:paymentId/status — consultado pelo front até o Pix ser pago.
subscriptionsRouter.get('/pix/:paymentId/status', asyncHandler(async (req: Request, res: Response) => {
  const account = await accountOfCompany(companyOf(req));
  const payment = await getMpPayment(req.params.paymentId);

  if (parsePixReference(payment.external_reference)?.accountId !== account.id) {
    throw HttpError.notFound('Pagamento não encontrado.');
  }

  const paid = await applyPixPayment(payment);
  return res.json({ paid });
}));
