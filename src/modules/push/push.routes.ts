import { Request, Response, Router } from 'express';
import { z } from 'zod';
import { env } from '../../config/env';
import { asyncHandler } from '../../lib/asyncHandler';
import { HttpError } from '../../lib/httpError';
import { prisma } from '../../lib/prisma';
import { pushEnabled, sendTestPush } from '../../lib/push';
import { authenticate, requireCompany } from '../../middlewares/auth.middleware';
import { validate } from '../../middlewares/validate.middleware';

// Notificações de mensagens novas no navegador/celular (Web Push), por aparelho.
const scope = z.enum(['all', 'handoff']);

const subscribeSchema = z.object({
  endpoint: z.string().url().max(1000),
  keys: z.object({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(100) }),
  scope: scope.default('all'),
  test: z.boolean().optional(),
});
const endpointSchema = z.object({ endpoint: z.string().url().max(1000) });

export const pushRouter = Router();

pushRouter.use(authenticate, requireCompany);

pushRouter.get('/config', (_req: Request, res: Response) => {
  res.json({ enabled: pushEnabled(), publicKey: env.VAPID_PUBLIC_KEY ?? null });
});

// Situação deste aparelho (o navegador diz o endpoint).
pushRouter.post('/status', validate(endpointSchema), asyncHandler(async (req: Request, res: Response) => {
  const found = await prisma.pushSubscription.findUnique({ where: { endpoint: req.body.endpoint } });
  const mine = found?.userId === req.auth!.userId;
  return res.json({ subscribed: mine, scope: mine ? found!.scope : null });
}));

pushRouter.post('/subscribe', validate(subscribeSchema), asyncHandler(async (req: Request, res: Response) => {
  if (!pushEnabled()) throw HttpError.badRequest('As notificações ainda não estão configuradas no servidor.');
  const { endpoint, keys, scope: chosen, test } = req.body as z.infer<typeof subscribeSchema>;
  const userId = req.auth!.userId;
  // O mesmo aparelho pode trocar de usuário: a inscrição passa para quem ativou agora.
  const subscription = await prisma.pushSubscription.upsert({
    where: { endpoint },
    update: { userId, p256dh: keys.p256dh, auth: keys.auth, scope: chosen },
    create: { userId, endpoint, p256dh: keys.p256dh, auth: keys.auth, scope: chosen },
  });
  if (test) await sendTestPush(subscription.id).catch((err) => console.error('Falha no teste de notificação:', (err as Error).message));
  return res.json({ subscribed: true, scope: subscription.scope });
}));

pushRouter.post('/unsubscribe', validate(endpointSchema), asyncHandler(async (req: Request, res: Response) => {
  await prisma.pushSubscription.deleteMany({ where: { endpoint: req.body.endpoint, userId: req.auth!.userId } });
  return res.json({ subscribed: false, scope: null });
}));
