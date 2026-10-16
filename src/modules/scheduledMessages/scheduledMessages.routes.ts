import { Request, Response, Router } from 'express';
import { Prisma, ScheduledMessageStatus } from '@prisma/client';
import { z } from 'zod';
import { asyncHandler } from '../../lib/asyncHandler';
import { HttpError } from '../../lib/httpError';
import { prisma } from '../../lib/prisma';
import { authenticate, companyOf, requireCompany } from '../../middlewares/auth.middleware';
import { requireActiveSubscription } from '../../middlewares/subscription.middleware';
import { validate } from '../../middlewares/validate.middleware';
import { writeScheduledMessage } from './scheduledMessages.ai';

// Mensagens que a equipe programa para um cliente numa data e hora
// (o envio é feito por sendScheduledMessages, em whatsapp.jobs.ts).
const MAX_PENDING = 500;
const MAX_AHEAD_MS = 366 * 24 * 60 * 60 * 1000;

const messageSchema = z.object({
  clientId: z.string().uuid(),
  text: z.string().trim().min(1, 'Escreva a mensagem.').max(4096, 'Mensagem muito longa.'),
  sendAt: z.coerce.date(),
});

const listSchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  clientId: z.string().uuid().optional(),
  status: z.nativeEnum(ScheduledMessageStatus).optional(),
});

function checkSendAt(sendAt: Date) {
  const now = Date.now();
  if (sendAt.getTime() < now + 60_000) throw HttpError.badRequest('Escolha um horário a partir de daqui a 1 minuto.');
  if (sendAt.getTime() > now + MAX_AHEAD_MS) throw HttpError.badRequest('Dá para agendar até 1 ano à frente.');
}

const include = { client: { select: { id: true, name: true, phone: true, whatsappId: true } } } satisfies Prisma.ScheduledMessageInclude;

export const scheduledMessagesRouter = Router();

scheduledMessagesRouter.use(authenticate, requireCompany, requireActiveSubscription);

scheduledMessagesRouter.get('/', validate(listSchema, 'query'), asyncHandler(async (req: Request, res: Response) => {
  const { from, to, clientId, status } = req.query as unknown as z.infer<typeof listSchema>;
  const messages = await prisma.scheduledMessage.findMany({
    where: {
      companyId: companyOf(req),
      ...(clientId ? { clientId } : {}),
      ...(status ? { status } : {}),
      ...(from || to ? { sendAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
    },
    orderBy: { sendAt: 'asc' },
    include,
    take: 1000,
  });
  return res.json({ messages });
}));

scheduledMessagesRouter.post('/', validate(messageSchema), asyncHandler(async (req: Request, res: Response) => {
  const companyId = companyOf(req);
  const { clientId, text, sendAt } = req.body as z.infer<typeof messageSchema>;
  checkSendAt(sendAt);
  const client = await prisma.client.findFirst({ where: { id: clientId, companyId } });
  if (!client) throw HttpError.notFound('Cliente não encontrado.');
  if (!client.whatsappId) throw HttpError.badRequest('Este cliente não tem um WhatsApp vinculado. Confira o telefone na ficha.');
  if ((await prisma.scheduledMessage.count({ where: { companyId, status: 'PENDING' } })) >= MAX_PENDING) {
    throw HttpError.badRequest(`Limite de ${MAX_PENDING} mensagens agendadas pendentes.`);
  }
  const user = await prisma.user.findUniqueOrThrow({ where: { id: req.auth!.userId }, select: { id: true, name: true } });
  const message = await prisma.scheduledMessage.create({
    data: { companyId, clientId, text, sendAt, createdById: user.id, createdByName: user.name },
    include,
  });
  return res.status(201).json({ message });
}));

// Texto sugerido pela IA para a mensagem (plano Avançado; não salva nada).
const aiSchema = z.object({
  clientId: z.string().uuid(),
  request: z.string().trim().min(3, 'Diga sobre o que é a mensagem.').max(300),
  draft: z.string().max(4096).nullish(),
  sendAt: z.coerce.date().nullish(),
});

scheduledMessagesRouter.post('/ai', validate(aiSchema), asyncHandler(async (req: Request, res: Response) => {
  return res.json(await writeScheduledMessage(companyOf(req), req.body));
}));

async function findPending(companyId: string, id: string) {
  const message = await prisma.scheduledMessage.findFirst({ where: { id, companyId } });
  if (!message) throw HttpError.notFound('Mensagem agendada não encontrada.');
  if (message.status !== 'PENDING') throw HttpError.badRequest('Essa mensagem já foi enviada ou cancelada.');
  return message;
}

scheduledMessagesRouter.patch('/:id', validate(messageSchema.omit({ clientId: true }).partial()), asyncHandler(async (req: Request, res: Response) => {
  const existing = await findPending(companyOf(req), req.params.id);
  if (req.body.sendAt) checkSendAt(req.body.sendAt);
  const message = await prisma.scheduledMessage.update({ where: { id: existing.id }, data: req.body, include });
  return res.json({ message });
}));

scheduledMessagesRouter.post('/:id/cancel', asyncHandler(async (req: Request, res: Response) => {
  const existing = await findPending(companyOf(req), req.params.id);
  const message = await prisma.scheduledMessage.update({ where: { id: existing.id }, data: { status: 'CANCELED' }, include });
  return res.json({ message });
}));

// Apaga do histórico (enviadas, canceladas ou com falha).
scheduledMessagesRouter.delete('/:id', asyncHandler(async (req: Request, res: Response) => {
  const existing = await prisma.scheduledMessage.findFirst({ where: { id: req.params.id, companyId: companyOf(req) } });
  if (!existing) throw HttpError.notFound('Mensagem agendada não encontrada.');
  if (existing.status === 'PENDING') throw HttpError.badRequest('Cancele a mensagem antes de apagar.');
  await prisma.scheduledMessage.delete({ where: { id: existing.id } });
  return res.status(204).send();
}));
