import { Request, Response, Router } from 'express';
import { MessageSender } from '@prisma/client';
import { z } from 'zod';
import { asyncHandler } from '../../lib/asyncHandler';
import { HttpError } from '../../lib/httpError';
import { prisma } from '../../lib/prisma';
import { authenticate, companyOf, requireCompany } from '../../middlewares/auth.middleware';
import { requireActiveSubscription } from '../../middlewares/subscription.middleware';
import { validate } from '../../middlewares/validate.middleware';
import { humanState, logMessage, pauseBotForStaff } from '../whatsapp/whatsapp.bot';
import { customerWindowEndsAt, customerWindowOpen, getCloudAccount, HIDDEN_NUMBER_ERROR } from '../whatsapp/whatsapp.cloud';
import { sendText } from '../whatsapp/whatsapp.transport';

// Caixa de conversas do WhatsApp: a equipe acompanha o que o bot conversou e
// assume o atendimento quando precisa (o bot pausa com aquele cliente).

const replySchema = z.object({
  text: z.string().trim().min(1, 'Mensagem vazia.').max(4096, 'Mensagem muito longa.'),
});

async function findClient(companyId: string, clientId: string) {
  const client = await prisma.client.findFirst({ where: { id: clientId, companyId } });
  if (!client) throw HttpError.notFound('Cliente não encontrado.');
  return client;
}

const NOT_PAUSED = { paused: false, pausedUntil: null, waitingForStaff: false };

export const conversationsRouter = Router();

conversationsRouter.use(authenticate, requireCompany, requireActiveSubscription);

// Clientes com mensagens, da conversa mais recente para a mais antiga.
conversationsRouter.get('/', asyncHandler(async (req: Request, res: Response) => {
  const companyId = companyOf(req);
  const clients = await prisma.client.findMany({
    where: { companyId, lastMessageAt: { not: null } },
    orderBy: { lastMessageAt: 'desc' },
    take: 200,
    select: {
      id: true, name: true, phone: true, whatsappId: true, lastMessageAt: true, unreadCount: true,
      messages: { orderBy: { createdAt: 'desc' }, take: 1, select: { text: true, sender: true, createdAt: true } },
    },
  });
  const handoffs = await prisma.whatsAppSession.findMany({
    where: { companyId, step: 'HUMAN', phone: { in: clients.map((c) => c.whatsappId).filter((id): id is string => Boolean(id)) } },
    select: { phone: true },
  });
  const human = new Set(handoffs.map((h) => h.phone));
  return res.json({
    conversations: clients.map(({ messages, ...c }) => ({ ...c, lastMessage: messages[0] ?? null, withStaff: Boolean(c.whatsappId && human.has(c.whatsappId)) })),
  });
}));

conversationsRouter.get('/:clientId', asyncHandler(async (req: Request, res: Response) => {
  const companyId = companyOf(req);
  const client = await findClient(companyId, req.params.clientId);
  const [messages, bot] = await Promise.all([
    prisma.message.findMany({ where: { clientId: client.id }, orderBy: { createdAt: 'desc' }, take: 300 }),
    client.whatsappId ? humanState(companyId, client.whatsappId) : NOT_PAUSED,
  ]);
  if (client.unreadCount) await prisma.client.update({ where: { id: client.id }, data: { unreadCount: 0 } });
  // API oficial: a equipe só pode escrever até 24 h depois da última mensagem do cliente.
  const official = Boolean(await getCloudAccount(companyId));
  const windowEndsAt = official ? await customerWindowEndsAt(companyId, client.id) : null;
  const channel = {
    official,
    windowEndsAt,
    canReply: Boolean(client.whatsappId) && (!official || (Boolean(windowEndsAt && windowEndsAt.getTime() > Date.now()) && !client.whatsappId!.includes('@'))),
    hiddenNumber: official && Boolean(client.whatsappId?.includes('@')),
  };
  return res.json({ client: { ...client, unreadCount: 0 }, messages: messages.reverse(), bot, channel });
}));

conversationsRouter.post('/:clientId/reply', validate(replySchema), asyncHandler(async (req: Request, res: Response) => {
  const companyId = companyOf(req);
  const client = await findClient(companyId, req.params.clientId);
  if (!client.whatsappId) throw HttpError.badRequest('Este cliente não tem um WhatsApp vinculado.');

  // A API oficial só envia para números e só aceita texto livre até 24 h depois da última mensagem do cliente.
  if (await getCloudAccount(companyId)) {
    if (client.whatsappId.includes('@')) throw HttpError.badRequest(HIDDEN_NUMBER_ERROR);
    if (!(await customerWindowOpen(companyId, client.id))) {
      throw HttpError.badRequest('Pelo WhatsApp oficial só dá para responder até 24 horas depois da última mensagem do cliente. Quando ele escrever de novo, você pode responder por aqui.');
    }
  }
  const user = await prisma.user.findUniqueOrThrow({ where: { id: req.auth!.userId }, select: { name: true } });
  await sendText(companyId, client.whatsappId, req.body.text);
  await pauseBotForStaff(companyId, client.whatsappId);
  await logMessage(companyId, client.id, req.body.text, MessageSender.STAFF, user.name);
  return res.status(201).json({ bot: await humanState(companyId, client.whatsappId) });
}));

// Devolve o cliente para o bot antes do prazo de inatividade.
conversationsRouter.post('/:clientId/resume-bot', asyncHandler(async (req: Request, res: Response) => {
  const companyId = companyOf(req);
  const client = await findClient(companyId, req.params.clientId);
  if (client.whatsappId) await prisma.whatsAppSession.deleteMany({ where: { companyId, phone: client.whatsappId, step: 'HUMAN' } });
  return res.json({ bot: NOT_PAUSED });
}));
