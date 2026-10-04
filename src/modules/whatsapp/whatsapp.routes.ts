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
import * as cloud from './whatsapp.cloud';
import * as connection from './whatsapp.connection';
import { defaultFlow, findNode, flowSchema, getFlow } from './whatsapp.flow';
import * as simulator from './whatsapp.simulator';
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

const onboardSchema = z.object({
  code: z.string().trim().min(1, 'Autorização da Meta ausente.'),
  wabaId: z.string().regex(/^\d+$/, 'Conta do WhatsApp inválida.'),
  phoneNumberId: z.string().regex(/^\d+$/, 'Número do WhatsApp inválido.'),
  businessId: z.string().regex(/^\d+$/).nullish(),
  coexistence: z.boolean().default(false),
});

const numericId = (label: string) => z.string().trim().regex(/^\d{5,25}$/, `${label} inválido: são só números.`);
const manualSchema = z.object({
  appId: numericId('ID do app'),
  appSecret: z.string().trim().regex(/^[a-f0-9]{32}$/i, 'Chave secreta do app inválida: são 32 letras e números.'),
  accessToken: z.string().trim().min(50, 'Token de acesso inválido: copie o token inteiro.').max(1000),
  wabaId: numericId('ID da conta do WhatsApp Business'),
  phoneNumberId: numericId('ID do número de telefone'),
});

// Endereço deste backend como o navegador o vê (para a URL do webhook, sem PUBLIC_API_URL).
const requestBase = (req: Request) => `${req.protocol}://${req.get('host')}`;

// provider: 'cloud' = API oficial da Meta; 'qr' = QR Code (WhatsApp Web); null = nada conectado.
async function status(companyId: string, base = '') {
  const official = await cloud.cloudStatus(companyId, base);
  if (official) {
    return { status: 'connected' as const, qr: null, phone: official.phone, error: official.lastError, provider: 'cloud' as const, cloud: official };
  }
  const state = connection.getConnectionState(companyId);
  const provider = state.status === 'disconnected' ? null : 'qr' as const;
  if (state.status !== 'disconnected' || state.error) return { ...state, provider, cloud: null };
  // Sessão salva, mas ainda não aberta neste processo (ex.: servidor acabou de subir).
  const settings = await prisma.companySettings.findUnique({ where: { companyId } });
  if (settings?.whatsappConnected) return { ...state, status: 'connecting' as const, phone: settings.whatsappPhone, provider: 'qr' as const, cloud: null };
  return { ...state, provider, cloud: null };
}

const OFFICIAL_CONNECTED = 'Este número está conectado pelo WhatsApp oficial. Desconecte antes de usar o QR Code.';

export const whatsappRouter = Router();

whatsappRouter.use(authenticate, requireCompany, requireActiveSubscription);

whatsappRouter.get('/status', asyncHandler(async (req: Request, res: Response) => {
  return res.json(await status(companyOf(req), requestBase(req)));
}));

// Gera o QR Code (estilo WhatsApp Web). O frontend consulta /status até conectar.
whatsappRouter.post('/connect', requireRole(Role.ADMIN), asyncHandler(async (req: Request, res: Response) => {
  const companyId = companyOf(req);
  if (await cloud.getCloudAccount(companyId)) throw HttpError.badRequest(OFFICIAL_CONNECTED);
  await connection.connect(companyId);
  return res.json(await status(companyId, requestBase(req)));
}));

// Desconecta o que estiver ligado: API oficial ou QR Code.
whatsappRouter.post('/disconnect', requireRole(Role.ADMIN), asyncHandler(async (req: Request, res: Response) => {
  const companyId = companyOf(req);
  if (await cloud.getCloudAccount(companyId)) await cloud.disconnectCloud(companyId);
  else await connection.disconnect(companyId);
  await prisma.whatsAppSession.deleteMany({ where: { companyId } });
  return res.json(await status(companyId, requestBase(req)));
}));

// ============ API oficial (Cloud API da Meta) ============

// App da Meta para o popup do cadastro incorporado (Embedded Signup).
whatsappRouter.get('/cloud/config', asyncHandler(async (_req: Request, res: Response) => {
  return res.json(cloud.cloudConfig());
}));

// Fim do popup: o frontend manda o código e os IDs que a Meta devolveu.
whatsappRouter.post('/cloud/onboard', requireRole(Role.ADMIN), validate(onboardSchema), asyncHandler(async (req: Request, res: Response) => {
  const companyId = companyOf(req);
  await cloud.onboard(companyId, req.body);
  // Uma conexão por empresa: se estava pelo QR Code, sai dele.
  if (connection.getConnectionState(companyId).status !== 'disconnected') await connection.disconnect(companyId).catch(() => {});
  return res.json(await status(companyId, requestBase(req)));
}));

// Conexão manual: URL e código do webhook para o tutorial (antes de conectar).
whatsappRouter.get('/cloud/manual', requireRole(Role.ADMIN), asyncHandler(async (req: Request, res: Response) => {
  return res.json(cloud.manualWebhook(companyOf(req), requestBase(req)));
}));

// Conexão manual: credenciais do app da Meta da própria empresa.
whatsappRouter.post('/cloud/manual', requireRole(Role.ADMIN), validate(manualSchema), asyncHandler(async (req: Request, res: Response) => {
  const companyId = companyOf(req);
  const result = await cloud.connectManual(companyId, req.body, requestBase(req));
  if (connection.getConnectionState(companyId).status !== 'disconnected') await connection.disconnect(companyId).catch(() => {});
  return res.json({ ...result, state: await status(companyId, requestBase(req)) });
}));

// Mensagens entregues no mês, cota grátis e custo estimado.
whatsappRouter.get('/cloud/usage', asyncHandler(async (req: Request, res: Response) => {
  return res.json(await cloud.usageOf(companyOf(req)));
}));

// Cria os templates que faltam e consulta a situação na Meta.
whatsappRouter.post('/cloud/templates', requireRole(Role.ADMIN), asyncHandler(async (req: Request, res: Response) => {
  await cloud.syncTemplates(companyOf(req));
  return res.json(await status(companyOf(req), requestBase(req)));
}));

whatsappRouter.post('/test', requireRole(Role.ADMIN), validate(sendTestSchema), asyncHandler(async (req: Request, res: Response) => {
  const companyId = companyOf(req);
  if (await cloud.getCloudAccount(companyId)) {
    // Fora da janela de 24 h a Meta descarta texto livre, então o teste é pelo lado do cliente.
    throw HttpError.badRequest('No WhatsApp oficial a empresa não pode puxar conversa com texto livre. Para testar, mande um "oi" do seu celular para o número da empresa: o bot responde na hora.');
  }
  const jid = await connection.findWhatsAppJid(companyId, req.body.to.replace(/\D/g, ''));
  if (!jid) throw HttpError.badRequest('Esse número não tem WhatsApp. Confira o DDI e o DDD (ex.: 5531999999999).');
  await connection.sendText(companyId, jid, 'Mensagem de teste da Sysora. Sua conexão com o WhatsApp está funcionando!');
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

// "Testar conversa" com o bot de verdade (fluxo da tela, catálogo e agenda reais).
// Nada é gravado nem enviado: ver whatsapp.simulator.ts.
const simulateSchema = z.object({
  simId: z.string().uuid().nullish(),
  text: z.string().trim().min(1, 'Escreva uma mensagem.').max(600),
  flow: flowSchema.optional(),
  profileName: z.string().trim().max(60).optional(),
});

whatsappRouter.post('/simulate', requireRole(Role.ADMIN), validate(simulateSchema), asyncHandler(async (req: Request, res: Response) => {
  return res.json(await simulator.simulate(companyOf(req), req.body));
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
  const [settings, company, catalog] = await Promise.all([
    settingsService.getSettings(companyId),
    prisma.company.findUniqueOrThrow({ where: { id: companyId }, select: { name: true } }),
    prisma.service.findMany({ where: { companyId, active: true }, orderBy: [{ position: 'asc' }, { name: 'asc' }] }),
  ]);
  // Como no bot: só serviços são agendados; produtos servem para responder perguntas.
  const services = catalog.filter((s) => s.kind === 'SERVICE');
  const products = catalog.filter((s) => s.kind === 'PRODUCT');
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
    products,
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
