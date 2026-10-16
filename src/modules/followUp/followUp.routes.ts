import { Request, Response, Router } from 'express';
import { Role } from '@prisma/client';
import { z } from 'zod';
import { asyncHandler } from '../../lib/asyncHandler';
import { HttpError } from '../../lib/httpError';
import { prisma } from '../../lib/prisma';
import { authenticate, companyOf, requireCompany, requireRole } from '../../middlewares/auth.middleware';
import { requireActiveSubscription } from '../../middlewares/subscription.middleware';
import { validate } from '../../middlewares/validate.middleware';
import { writeFollowUps } from './followUp.ai';

// Follow-up automático: até 3 mensagens para quem parou de responder. Cada
// uma sai delayMinutes depois da última mensagem do cliente, se a conversa
// parou do nosso lado (ver sendFollowUps em whatsapp.jobs.ts).
export const MAX_FOLLOW_UP_STEPS = 3;
const MIN_DELAY = 30;
const MAX_DELAY = 7 * 24 * 60;

const followUpSchema = z.object({
  enabled: z.boolean(),
  steps: z.array(z.object({
    delayMinutes: z.number().int().min(MIN_DELAY, 'O primeiro envio é no mínimo 30 minutos depois.').max(MAX_DELAY, 'O prazo máximo é de 7 dias.'),
    text: z.string().trim().min(1, 'Escreva a mensagem de cada etapa.').max(1000),
  })).max(MAX_FOLLOW_UP_STEPS, `Use até ${MAX_FOLLOW_UP_STEPS} mensagens.`),
});

export const followUpRouter = Router();

followUpRouter.use(authenticate, requireCompany, requireActiveSubscription);

async function current(companyId: string) {
  const [settings, steps] = await Promise.all([
    prisma.companySettings.findUnique({ where: { companyId }, select: { followUpEnabled: true } }),
    prisma.followUpStep.findMany({ where: { companyId }, orderBy: { position: 'asc' } }),
  ]);
  return { enabled: settings?.followUpEnabled ?? false, steps, maxSteps: MAX_FOLLOW_UP_STEPS };
}

// Textos sugeridos pela IA para as etapas (plano Avançado; não salva nada).
const aiSchema = z.object({
  request: z.string().trim().max(300).nullish(),
  steps: z.array(z.object({
    delayMinutes: z.number().int().min(1).max(MAX_DELAY),
    text: z.string().max(1000).nullish(),
  })).min(1, 'Crie pelo menos uma mensagem.').max(MAX_FOLLOW_UP_STEPS),
});

followUpRouter.post('/ai', requireRole(Role.ADMIN), validate(aiSchema), asyncHandler(async (req: Request, res: Response) => {
  return res.json(await writeFollowUps(companyOf(req), req.body));
}));

followUpRouter.get('/', asyncHandler(async (req: Request, res: Response) => res.json(await current(companyOf(req)))));

followUpRouter.put('/', requireRole(Role.ADMIN), validate(followUpSchema), asyncHandler(async (req: Request, res: Response) => {
  const companyId = companyOf(req);
  const { enabled, steps } = req.body as z.infer<typeof followUpSchema>;
  if (enabled && !steps.length) throw HttpError.badRequest('Crie pelo menos uma mensagem antes de ligar o follow-up.');
  for (let i = 1; i < steps.length; i += 1) {
    if (steps[i].delayMinutes <= steps[i - 1].delayMinutes) throw HttpError.badRequest('Cada mensagem precisa sair depois da anterior.');
  }
  const wasEnabled = (await current(companyId)).enabled;
  await prisma.$transaction([
    prisma.followUpStep.deleteMany({ where: { companyId } }),
    prisma.followUpStep.createMany({ data: steps.map((s, position) => ({ ...s, position, companyId })) }),
    prisma.companySettings.upsert({ where: { companyId }, update: { followUpEnabled: enabled }, create: { companyId, followUpEnabled: enabled } }),
  ]);
  // Ao ligar, não manda nada para conversas antigas: só vale para quem escrever a partir de agora.
  if (enabled && !wasEnabled) {
    await prisma.client.updateMany({
      where: { companyId, lastInboundAt: { lt: new Date() }, followUpStep: { lt: MAX_FOLLOW_UP_STEPS } },
      data: { followUpStep: MAX_FOLLOW_UP_STEPS },
    });
  }
  return res.json(await current(companyId));
}));
