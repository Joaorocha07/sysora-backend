import { Request, Response, Router } from 'express';
import { Prisma, Role } from '@prisma/client';
import { z } from 'zod';
import { asyncHandler } from '../../lib/asyncHandler';
import { HttpError } from '../../lib/httpError';
import { prisma } from '../../lib/prisma';
import { authenticate, companyOf, requireCompany, requireRole } from '../../middlewares/auth.middleware';
import { requireActiveSubscription } from '../../middlewares/subscription.middleware';
import { validate } from '../../middlewares/validate.middleware';
import { companyHasAi, requireAiPlan } from '../../lib/aiAccess';
import { transcriptionEnabled } from '../../lib/transcription';
import * as settingsService from '../settings/settings.service';
import * as ai from './whatsapp.ai';
import * as connection from './whatsapp.connection';
import { defaultFlow, findNode, flowSchema, getFlow } from './whatsapp.flow';
import * as sora from './whatsapp.sora';

const saveFlowSchema = z.object({ flow: flowSchema });

const understandSchema = z.object({
  flow: flowSchema,
  // Menu em que o cliente está no simulador (vazio = menu principal).
  nodeId: z.string().max(40).optional(),
  text: z.string().trim().min(1, 'Escreva uma mensagem.').max(600),
});

const soraSchema = z.object({
  messages: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    text: z.string().trim().min(1).max(2000, 'Mensagem muito longa para a Sora (até 2000 caracteres).'),
  })).min(1).max(40),
  flow: flowSchema,
});

const sendTestSchema = z.object({
  to: z.string().trim().min(8, 'Informe um número de WhatsApp válido.'),
});

async function status(companyId: string) {
  const state = connection.getConnectionState(companyId);
  if (state.status !== 'disconnected' || state.error) return state;
  // Sessão salva, mas ainda não aberta neste processo (ex.: servidor acabou de subir).
  const settings = await prisma.companySettings.findUnique({ where: { companyId } });
  if (settings?.whatsappConnected) return { ...state, status: 'connecting' as const, phone: settings.whatsappPhone };
  return state;
}

export const whatsappRouter = Router();

whatsappRouter.use(authenticate, requireCompany, requireActiveSubscription);

whatsappRouter.get('/status', asyncHandler(async (req: Request, res: Response) => {
  return res.json(await status(companyOf(req)));
}));

// Gera o QR Code (estilo WhatsApp Web). O frontend consulta /status até conectar.
whatsappRouter.post('/connect', requireRole(Role.ADMIN), asyncHandler(async (req: Request, res: Response) => {
  return res.json(await connection.connect(companyOf(req)));
}));

whatsappRouter.post('/disconnect', requireRole(Role.ADMIN), asyncHandler(async (req: Request, res: Response) => {
  const companyId = companyOf(req);
  await connection.disconnect(companyId);
  await prisma.whatsAppSession.deleteMany({ where: { companyId } });
  return res.json(connection.getConnectionState(companyId));
}));

whatsappRouter.post('/test', requireRole(Role.ADMIN), validate(sendTestSchema), asyncHandler(async (req: Request, res: Response) => {
  const companyId = companyOf(req);
  const jid = await connection.findWhatsAppJid(companyId, req.body.to.replace(/\D/g, ''));
  if (!jid) throw HttpError.badRequest('Esse número não tem WhatsApp. Confira o DDI e o DDD (ex.: 5531999999999).');
  await connection.sendText(companyId, jid, 'Mensagem de teste do Sysora. Sua conexão com o WhatsApp está funcionando!');
  return res.json({ message: 'Mensagem de teste enviada.' });
}));

// Fluxo do bot (aba "Fluxo do bot"). Sem fluxo salvo, devolve o padrão.
whatsappRouter.get('/flow', asyncHandler(async (req: Request, res: Response) => {
  const settings = await settingsService.getSettings(companyOf(req));
  return res.json({ flow: getFlow(settings), custom: Boolean(settings.botFlow) });
}));

whatsappRouter.put('/flow', requireRole(Role.ADMIN), validate(saveFlowSchema), asyncHandler(async (req: Request, res: Response) => {
  const companyId = companyOf(req);
  await settingsService.getSettings(companyId);
  await prisma.companySettings.update({ where: { companyId }, data: { botFlow: req.body.flow } });
  // Conversas no meio do fluxo antigo podem apontar para etapas que não existem mais.
  await prisma.whatsAppSession.deleteMany({ where: { companyId, step: 'MENU' } });
  return res.json({ flow: req.body.flow, custom: true });
}));

whatsappRouter.delete('/flow', requireRole(Role.ADMIN), asyncHandler(async (req: Request, res: Response) => {
  const companyId = companyOf(req);
  await settingsService.getSettings(companyId);
  const settings = await prisma.companySettings.update({ where: { companyId }, data: { botFlow: Prisma.DbNull } });
  await prisma.whatsAppSession.deleteMany({ where: { companyId, step: 'MENU' } });
  return res.json({ flow: defaultFlow(settings), custom: false });
}));

// Sora (IA que monta o fluxo): uso do mês e conversa. A resposta traz um fluxo
// em rascunho; quem salva é o PUT /flow, depois que o dono revisa no editor.
whatsappRouter.get('/flow/sora', requireRole(Role.ADMIN), asyncHandler(async (req: Request, res: Response) => {
  return res.json(await sora.soraUsage(companyOf(req)));
}));

whatsappRouter.post('/flow/sora', requireRole(Role.ADMIN), validate(soraSchema), asyncHandler(async (req: Request, res: Response) => {
  return res.json(await sora.askSora(companyOf(req), req.body.messages, req.body.flow));
}));

// IA do atendimento: disponível no servidor, uso do mês e transcrição de áudio.
whatsappRouter.get('/ai', asyncHandler(async (req: Request, res: Response) => {
  const companyId = companyOf(req);
  return res.json({ ...(await ai.botAiUsage(companyId)), transcription: transcriptionEnabled(), allowed: await companyHasAi(companyId) });
}));

// "Testar conversa" do editor: o que a IA entenderia de uma mensagem escrita
// no menu atual (conta no limite do mês, como no WhatsApp).
whatsappRouter.post('/flow/understand', requireRole(Role.ADMIN), validate(understandSchema), asyncHandler(async (req: Request, res: Response) => {
  const companyId = companyOf(req);
  await requireAiPlan(companyId);
  const flow = req.body.flow;
  const found = findNode(flow, req.body.nodeId);
  const menu = found?.node.type === 'menu' ? found.node : flow;
  const [settings, company, services] = await Promise.all([
    settingsService.getSettings(companyId),
    prisma.company.findUniqueOrThrow({ where: { id: companyId }, select: { name: true } }),
    prisma.service.findMany({ where: { companyId, active: true }, orderBy: [{ position: 'asc' }, { name: 'asc' }] }),
  ]);
  if (!settings.botAiEnabled) throw HttpError.badRequest('A IA do atendimento está desligada. Ligue em "Configurações do bot".');
  const usage = await ai.botAiUsage(companyId);
  if (!usage.available) throw HttpError.badRequest('A IA ainda não está configurada neste servidor.');
  if (usage.used >= usage.limit) throw HttpError.forbidden(`A IA já interpretou ${usage.limit} mensagens este mês. O limite renova no dia 1º.`);

  const options: { id: string; label: string; type: string; action?: string }[] = menu.options ?? [];
  const result = await ai.understand({
    companyId,
    companyName: company.name,
    settings,
    flow,
    services,
    question: menu.prompt ?? '',
    options: options.map((o) => o.label),
    text: req.body.text,
  });
  if (!result) throw HttpError.badRequest('A IA não conseguiu responder agora. Tente de novo.');

  // Mesma escolha que o bot faria: número da opção ou função pela intenção.
  const actionIntent = ['confirmar', 'remarcar', 'cancelar'].includes(result.intent) ? 'meus' : result.intent;
  const option = result.option ? options[result.option - 1] : options.find((o) => o.type === 'action' && o.action === actionIntent);
  return res.json({
    optionId: option?.id ?? null,
    intent: result.intent,
    answer: result.answer,
    services: result.services.map((n) => services[n - 1]?.name).filter(Boolean),
    date: result.date,
    time: result.time,
    usage: await ai.botAiUsage(companyId),
  });
}));
