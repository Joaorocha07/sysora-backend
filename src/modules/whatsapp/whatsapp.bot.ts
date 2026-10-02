import { AppointmentStatus, CompanySettings, MessageSender, Service, Source } from '@prisma/client';
import { env } from '../../config/env';
import { isAccountActive } from '../../lib/plans';
import { prisma } from '../../lib/prisma';
import { HttpError } from '../../lib/httpError';
import { brDate, dateTime, durationLabel, toIsoDate, weekdayOf } from '../../lib/time';
import { transcribeAudio, transcriptionEnabled } from '../../lib/transcription';
import * as appointmentsService from '../appointments/appointments.service';
import { freeTimes, isTimeFree, nextFreeDays } from '../appointments/availability';
import { Understanding, understand } from './whatsapp.ai';
import { FlowAction, FlowNode, findNode, getFlow } from './whatsapp.flow';

// Chatbot do WhatsApp. Toda mensagem recebida: encontra (ou cria) o cliente
// pelo número, salva a mensagem na conversa dele e, se o bot estiver ligado,
// avança o atendimento. Os menus seguem o fluxo montado pela empresa
// (whatsapp.flow.ts); as funções prontas que ele pode usar são:
//   agendar: [ASK_NAME] -> ASK_SERVICE -> ASK_DATE -> ASK_TIME -> agendado
//   meus agendamentos: MANAGE (confirmar / remarcar / cancelar)
//   serviços e valores
//   falar com a equipe: HUMAN (bot em silêncio enquanto a equipe atende)
// A equipe responder (pelo Sysora ou pelo celular) também abre HUMAN. Se a
// equipe passar humanTimeoutMinutes sem escrever, o bot encerra o atendimento.
// O lembrete da véspera (whatsapp.jobs.ts) abre a etapa CONFIRM:
//   1) confirmar  2) remarcar -> ASK_DATE  3) cancelar
// Quando a resposta não é um número nem uma palavra conhecida, a IA do
// atendimento (whatsapp.ai.ts) interpreta o texto: escolhe a opção, os
// serviços, o dia e o horário ("quero cortar o cabelo sexta às 15h" agenda
// direto se o horário estiver livre) ou responde uma pergunta com os dados da
// empresa. Áudios são transcritos (lib/transcription.ts) e seguem igual.

type BotStep = 'MENU' | 'ASK_NAME' | 'ASK_SERVICE' | 'ASK_DATE' | 'ASK_TIME' | 'CONFIRM' | 'MANAGE' | 'HUMAN';
type SessionData = {
  askName?: boolean;
  // MENU depois de concluir algo: o cliente pode escolher uma opção direto;
  // outra mensagem recebe as boas-vindas, como numa conversa nova.
  idle?: boolean;
  // MENU: submenu do fluxo em que o cliente está (vazio = menu principal).
  nodeId?: string;
  serviceIds?: string[];
  // Opções oferecidas na última mensagem, para o cliente responder pelo número.
  days?: string[];
  date?: string;
  times?: string[];
  manage?: ManageAction[];
  // Agendamento sendo remarcado (MANAGE/CONFIRM -> ASK_DATE).
  appointmentId?: string;
  // Dia/horário que o cliente já adiantou ("amanhã às 14h"), usados assim que o serviço for escolhido.
  wish?: { date?: string; time?: string };
  // HUMAN: última mensagem da equipe e quando o cliente pediu atendimento (ISO).
  staffAt?: string;
  requestedAt?: string;
};
type BotContext = {
  companyId: string;
  companyName: string;
  // Número do contato só com dígitos (ex.: 5531999999999). Se o WhatsApp não
  // revelar o número, é o JID anônimo do contato (termina em @lid).
  waId: string;
  send: (text: string) => Promise<void>;
  saveContact?: (name: string) => Promise<void>;
  settings: CompanySettings;
  clientId: string | null;
};
export type IncomingWhatsAppMessage = {
  companyId: string;
  contactId: string;
  messageId?: string;
  text: string | null;
  mediaType?: string;
  // Áudio recebido: baixado só se a transcrição estiver ligada.
  audio?: { seconds: number; mimetype: string; load: () => Promise<Buffer> };
  profileName?: string;
  send: (text: string) => Promise<void>;
  // Salva o cliente nos contatos do WhatsApp da empresa.
  saveContact?: (name: string) => Promise<void>;
};

// Cliente parou no meio do agendamento: depois desse tempo começa do zero.
const FLOW_TIMEOUT_MS = 30 * 60 * 1000;
// O cliente pode responder o lembrete horas depois.
const CONFIRM_TIMEOUT_MS = 48 * 60 * 60 * 1000;
// Cliente pediu a equipe e ninguém respondeu: depois disso o bot volta.
const HANDOFF_MAX_WAIT_MS = 12 * 60 * 60 * 1000;
const RESET_WORDS = new Set(['sair', 'recomecar', 'reiniciar']);
const BACK_WORDS = new Set(['0', 'voltar', 'menu', 'inicio', 'menu principal']);
const BACK_OPTION = '0) Voltar ao menu principal';
const WEEKDAYS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
const MEDIA_LABELS: Record<string, string> = {
  audio: 'áudio', image: 'imagem', video: 'vídeo', document: 'documento', sticker: 'figurinha', location: 'localização', contact: 'contato',
};
const DAYS_OFFERED = 6;
const PLACEHOLDER_PREFIX = 'Cliente WhatsApp';

// Palavras que o cliente pode digitar em vez do número (opções com função pronta).
const MENU_KEYWORDS: [FlowAction, RegExp][] = [
  ['meus', /remarc|cancel|desmarc|meu horario|meus horarios|meu agendamento|meus agendamentos|confirm/],
  ['agendar', /agend|marcar|horario/],
  ['servicos', /servico|preco|valor|quanto|tabela/],
  ['equipe', /atend|equipe|falar|pessoa|humano/],
];

type ManageAction = 'confirmar' | 'remarcar' | 'cancelar';
const MANAGE_LABELS: Record<ManageAction, string> = {
  confirmar: 'Confirmar presença',
  remarcar: 'Remarcar',
  cancelar: 'Cancelar',
};

const MANAGE_CODES: Record<ManageAction, string> = { confirmar: '1', remarcar: '2', cancelar: '3' };
const CONFIRM_ACTIONS: ManageAction[] = ['confirmar', 'remarcar', 'cancelar'];

// Cumprimentos e agradecimentos: não vale gastar IA (vão para as boas-vindas).
const SMALL_TALK = /^((oi+e?|ola+|opa|eai|e ai|hey|bom dia|boa tarde|boa noite|tudo bem|tudo bom|td bem|obrigad[oa]|obg|brigad[oa]|valeu|vlw|ok|okay|blz|beleza|tchau|ate mais|ate logo|[\p{Extended_Pictographic}])[\s!.,?]*)+$/u;

export const CONFIRM_OPTIONS = `Responda com o número:\n\n1) Confirmar\n2) Remarcar\n3) Cancelar\n\n${BACK_OPTION}`;
const CONFIRM_WORDS = new Set(['1', 'sim', 's', 'confirmo', 'confirmar', 'confirmado', 'confirmada', 'ok', 'certo', 'tudo certo', 'combinado', '👍']);

// Blocos da mensagem separados por uma linha em branco (os vazios são ignorados).
const blocks = (...parts: (string | undefined | false | null)[]) => parts.filter(Boolean).join('\n\n');
const numbered = (items: string[]) => items.map((item, i) => `${i + 1}) ${item}`).join('\n');
const isHiddenNumber = (waId: string) => waId.includes('@');
const onlyDigits = (value: string) => value.replace(/\D/g, '');
const firstName = (name: string | null | undefined) => (name ?? '').trim().split(/\s+/)[0] ?? '';
const money = (cents: number) => (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
export const isPlaceholderName = (name: string | null | undefined) => !name?.trim() || name.startsWith(PLACEHOLDER_PREFIX);

function normalize(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

// Nome como o cliente escreveu, sem emojis ("João Rocha ❤️" -> "João Rocha").
export function cleanName(raw: string | null | undefined): string {
  return (raw ?? '')
    .replace(/[\p{Extended_Pictographic}\p{Emoji_Modifier}\u{1F1E6}-\u{1F1FF}‍︎️⃣]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

type TemplateVars = { nome?: string; empresa?: string; servico?: string; data?: string; hora?: string };
export function fillTemplate(template: string, vars: TemplateVars): string {
  return template
    .replace(/\{(nome|empresa|servico|serviço|data|hora)\}/gi, (_, key: string) => vars[normalize(key) as keyof TemplateVars] ?? '')
    // "Olá, !" quando o nome é desconhecido -> "Olá!"
    .replace(/,\s*([!.?])/g, '$1')
    .replace(/\s{2,}/g, ' ');
}

// "sexta, 26/09" — ou "hoje (sexta, 26/09)" / "amanhã (sábado, 27/09)".
function dayLabel(isoDate: string, now = new Date()): string {
  const label = `${WEEKDAYS[weekdayOf(isoDate)]}, ${brDate(isoDate)}`;
  if (isoDate === toIsoDate(now)) return `hoje (${label})`;
  if (isoDate === toIsoDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1))) return `amanhã (${label})`;
  return label;
}

// Para o meio da frase: "hoje (sexta, 26/09)", "na sexta, 26/09", "no sábado, 27/09".
function onDay(isoDate: string): string {
  const label = dayLabel(isoDate);
  if (label.startsWith('hoje') || label.startsWith('amanhã')) return label;
  return `${[0, 6].includes(weekdayOf(isoDate)) ? 'no' : 'na'} ${label}`;
}

// Resposta "2" escolhe o 2º item da lista oferecida.
function pickFromList<T>(answer: string, list: T[] | undefined): T | undefined {
  if (!list || !/^\d{1,2}$/.test(answer)) return undefined;
  return list[Number(answer) - 1];
}

function pickMenuOption(answer: string, menu: FlowNode): FlowNode | undefined {
  const options = menu.options ?? [];
  const byNumber = pickFromList(answer, options);
  if (byNumber) return byNumber;
  const byLabel = options.find((o) => normalize(o.label) === answer);
  if (byLabel) return byLabel;
  const action = MENU_KEYWORDS.find(([a, pattern]) => pattern.test(answer) && options.some((o) => o.action === a))?.[0];
  return options.find((o) => o.type === 'action' && o.action === action);
}

const flowOf = (ctx: BotContext) => getFlow(ctx.settings);

// Texto do menu: pergunta e opções numeradas (submenus também oferecem o 0).
function menuText(ctx: BotContext, menu: FlowNode = flowOf(ctx)): string {
  const vars = { empresa: ctx.companyName };
  return blocks(
    fillTemplate(menu.prompt || 'Responda com o número:', vars),
    numbered((menu.options ?? []).map((o) => fillTemplate(o.label, vars))),
    menu.id !== flowOf(ctx).id && BACK_OPTION,
  );
}

const mainMenu = (ctx: BotContext) => menuText(ctx);

// Envia as partes num balão só (juntas) ou uma mensagem para cada.
async function sayParts(ctx: BotContext, parts: (string | undefined | false | null)[], together: boolean) {
  const list = parts.filter((p): p is string => Boolean(p));
  if (together) {
    if (list.length) await say(ctx, blocks(...list));
    return;
  }
  for (const part of list) await say(ctx, part);
}

// Cliente escolheu uma etapa do fluxo (ou começou a conversa, na raiz).
async function runNode(ctx: BotContext, node: FlowNode, parent: FlowNode | null, data: SessionData, name: string) {
  const root = flowOf(ctx);
  const messages = node.messages.map((m) => fillTemplate(m, { nome: name, empresa: ctx.companyName }));
  const base: SessionData = { askName: data.askName };
  const menuId = (menu: FlowNode) => (menu.id === root.id ? undefined : menu.id);

  if (node.type === 'menu') {
    await setSession(ctx, 'MENU', { ...base, nodeId: menuId(node) });
    await sayParts(ctx, [...messages, menuText(ctx, node)], node.together);
    return;
  }
  if (node.type === 'message') {
    const target = node.next === 'parent' && parent ? parent : root;
    await setSession(ctx, 'MENU', { ...base, nodeId: menuId(target) });
    await sayParts(ctx, [...messages, menuText(ctx, target)], node.together);
    return;
  }
  if (node.type === 'end') {
    await setSession(ctx, 'MENU', { ...base, idle: true });
    await sayParts(ctx, messages, node.together);
    return;
  }

  // Função pronta: as mensagens da etapa vêm antes (no mesmo balão, se juntas).
  if (!node.together) await sayParts(ctx, messages, false);
  const prefix = node.together ? blocks(...messages) : '';
  const intro = prefix || (messages.length ? '' : 'Ótimo!');
  if (node.action === 'agendar') {
    // Serviço, dia e horário que o cliente já disse (IA) seguem para o agendamento.
    const booking: SessionData = { ...base, serviceIds: data.serviceIds, wish: data.wish };
    if (data.askName) {
      await setSession(ctx, 'ASK_NAME', booking);
      await say(ctx, blocks(intro, 'Para fazer seu cadastro, qual é o seu nome?', BACK_OPTION));
    } else {
      await offerServices(ctx, booking, intro);
    }
  } else if (node.action === 'meus') {
    await showAppointments(ctx, base, prefix);
  } else if (node.action === 'servicos') {
    await showCatalog(ctx, base, prefix);
  } else {
    await handOff(ctx, prefix);
  }
}

export function parseBrDate(text: string, now = new Date()): string | null {
  const t = normalize(text);
  if (t === 'hoje') return toIsoDate(now);
  if (t === 'amanha') return toIsoDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));

  const match = /^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2}|\d{4}))?$/.exec(t);
  if (!match) return null;
  const day = Number(match[1]);
  const month = Number(match[2]);
  let year = match[3] ? Number(match[3].length === 2 ? `20${match[3]}` : match[3]) : now.getFullYear();
  // "05/01" pedido em dezembro = janeiro do ano que vem.
  if (!match[3] && month < now.getMonth() + 1) year += 1;

  const date = new Date(year, month - 1, day, 12);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  if (new Date(year, month - 1, day, 23, 59, 59).getTime() < now.getTime()) return null;
  return toIsoDate(date);
}

// Aceita "14", "14h", "14:30", "14h30", "14hs".
export function parseTime(text: string): string | null {
  const match = /^(\d{1,2})(?:[:h](\d{2}))?(?:h|hs|horas)?$/.exec(normalize(text).replace(/\s/g, ''));
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  if (hour > 23 || minute > 59) return null;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

// wa_id brasileiro (55 + DDD + número) -> DDD + número com 9º dígito.
function brLocalNumber(waId: string): string | null {
  const digits = onlyDigits(waId);
  if (!digits.startsWith('55') || (digits.length !== 12 && digits.length !== 13)) return null;
  const local = digits.slice(2);
  // Contas antigas do WhatsApp chegam sem o nono dígito dos celulares.
  if (local.length === 10 && /[6-9]/.test(local[2])) return `${local.slice(0, 2)}9${local.slice(2)}`;
  return local;
}

// Mesmo formato da máscara de telefone do frontend: (31) 99999-9999.
export function formatPhone(waId: string): string {
  if (isHiddenNumber(waId)) return 'Não informado';
  const local = brLocalNumber(waId);
  if (!local) return `+${onlyDigits(waId)}`;
  return local.length === 11
    ? `(${local.slice(0, 2)}) ${local.slice(2, 7)}-${local.slice(7)}`
    : `(${local.slice(0, 2)}) ${local.slice(2, 6)}-${local.slice(6)}`;
}

const placeholderName = (waId: string) => `${PLACEHOLDER_PREFIX} ${onlyDigits(waId).slice(-4)}`;

// O WhatsApp pode entregar a mesma mensagem de novo após uma reconexão.
const recentMessageIds = new Set<string>();
function alreadyProcessed(id: string | undefined): boolean {
  if (!id) return false;
  if (recentMessageIds.has(id)) return true;
  recentMessageIds.add(id);
  if (recentMessageIds.size > 2000) recentMessageIds.delete(recentMessageIds.values().next().value!);
  return false;
}

// Mensagens do mesmo número são processadas em fila, para duas mensagens
// seguidas não avançarem a mesma sessão ao mesmo tempo.
const contactQueues = new Map<string, Promise<void>>();
export function withContactLock(companyId: string, contactId: string, task: () => Promise<void>): Promise<void> {
  const key = `${companyId}:${contactId}`;
  const next = (contactQueues.get(key) ?? Promise.resolve()).catch(() => {}).then(task);
  contactQueues.set(key, next);
  next.finally(() => { if (contactQueues.get(key) === next) contactQueues.delete(key); }).catch(() => {});
  return next;
}

export async function findClientByWhatsApp(companyId: string, waId: string) {
  const linked = await prisma.client.findFirst({ where: { companyId, whatsappId: waId }, orderBy: { createdAt: 'desc' } });
  if (linked || isHiddenNumber(waId)) return linked;

  // Cliente cadastrado à mão com o número em outro formato (ex.: sem o nono
  // dígito): casa pelos últimos 8 dígitos + DDD e vincula o wa_id.
  const local = brLocalNumber(waId) ?? onlyDigits(waId);
  const candidates = await prisma.$queryRaw<{ id: string; phone: string }[]>`
    SELECT id, phone FROM clients
    WHERE "companyId" = ${companyId}
      AND right(regexp_replace(phone, '[^0-9]', '', 'g'), 8) = ${local.slice(-8)}
    ORDER BY "createdAt" DESC`;
  const ddd = local.length >= 10 ? local.slice(0, 2) : null;
  const match = candidates.find((c) => {
    const digits = onlyDigits(c.phone).replace(/^55(?=\d{10,11}$)/, '');
    return !ddd || digits.length < 10 || digits.startsWith(ddd);
  });
  if (!match) return null;
  return prisma.client.update({ where: { id: match.id }, data: { whatsappId: waId } });
}

export async function logMessage(companyId: string, clientId: string | null, text: string, sender: MessageSender, staffName?: string) {
  if (!clientId) return;
  await prisma.$transaction([
    prisma.message.create({ data: { companyId, clientId, text, sender, staffName } }),
    prisma.client.update({
      where: { id: clientId },
      data: { lastMessageAt: new Date(), ...(sender === MessageSender.CLIENT ? { unreadCount: { increment: 1 } } : {}) },
    }),
  ]);
}

async function say(ctx: BotContext, text: string) {
  await ctx.send(text);
  await logMessage(ctx.companyId, ctx.clientId, text, MessageSender.BOT);
}

async function upsertSession(companyId: string, phone: string, step: BotStep, data: SessionData) {
  await prisma.whatsAppSession.upsert({
    where: { companyId_phone: { companyId, phone } },
    update: { step, data },
    create: { companyId, phone, step, data },
  });
}

const setSession = (ctx: BotContext, step: BotStep, data: SessionData) => upsertSession(ctx.companyId, ctx.waId, step, data);

async function clearSession(ctx: BotContext) {
  await prisma.whatsAppSession.deleteMany({ where: { companyId: ctx.companyId, phone: ctx.waId } });
}

async function saveContact(ctx: BotContext, name: string) {
  if (!ctx.saveContact || isPlaceholderName(name)) return;
  // Salvar o contato é um extra: se o WhatsApp recusar, o cliente continua no sistema.
  await ctx.saveContact(name).catch((err) => console.error('Não foi possível salvar o contato no WhatsApp:', err));
}

async function activeServices(companyId: string) {
  return prisma.service.findMany({ where: { companyId, active: true }, orderBy: [{ position: 'asc' }, { name: 'asc' }] });
}

// Começo de conversa: boas-vindas e menu principal do fluxo.
async function sendWelcome(ctx: BotContext, name: string, data: SessionData) {
  await runNode(ctx, flowOf(ctx), null, { askName: data.askName }, name);
}

// Terminou algo: continua ouvindo o menu, para o cliente poder mandar outra opção.
const finishConversation = (ctx: BotContext) => setSession(ctx, 'MENU', { idle: true });

async function handOff(ctx: BotContext, prefix?: string) {
  await setSession(ctx, 'HUMAN', { requestedAt: new Date().toISOString() });
  await say(ctx, blocks(prefix, ctx.settings.handoffMessage));
}

// A equipe mandou mensagem: o bot fica em silêncio com esse cliente e o prazo
// de inatividade (humanTimeoutMinutes) recomeça a contar.
export async function pauseBotForStaff(companyId: string, contactId: string) {
  const settings = await prisma.companySettings.findUnique({ where: { companyId } });
  if (settings && !settings.pauseOnStaffReply) return;
  await upsertSession(companyId, contactId, 'HUMAN', { staffAt: new Date().toISOString() });
}

type SessionRow = { step: string; data: unknown; updatedAt: Date };

// Quando o atendimento pela equipe acaba. Sem nenhuma mensagem da equipe
// ainda (cliente pediu e está esperando), o bot não encerra por inatividade.
export function humanSessionEndsAt(session: SessionRow, settings: CompanySettings): { endsAt: Date; waitingForStaff: boolean } {
  const data = (session.data ?? {}) as SessionData;
  const timeout = settings.humanTimeoutMinutes * 60 * 1000;
  if (data.staffAt) return { endsAt: new Date(Date.parse(data.staffAt) + timeout), waitingForStaff: false };
  if (data.requestedAt) return { endsAt: new Date(Date.parse(data.requestedAt) + HANDOFF_MAX_WAIT_MS), waitingForStaff: true };
  return { endsAt: new Date(session.updatedAt.getTime() + timeout), waitingForStaff: false };
}

function sessionExpired(session: SessionRow, settings: CompanySettings): boolean {
  if (session.step === 'HUMAN') return humanSessionEndsAt(session, settings).endsAt.getTime() <= Date.now();
  const timeout = session.step === 'CONFIRM' ? CONFIRM_TIMEOUT_MS : FLOW_TIMEOUT_MS;
  return Date.now() - session.updatedAt.getTime() > timeout;
}

// Situação do atendimento pela equipe com esse contato (tela de conversas).
export async function humanState(companyId: string, contactId: string) {
  const [session, settings] = await Promise.all([
    prisma.whatsAppSession.findUnique({ where: { companyId_phone: { companyId, phone: contactId } } }),
    prisma.companySettings.findUnique({ where: { companyId } }),
  ]);
  const idle = { paused: false, pausedUntil: null, waitingForStaff: false };
  if (session?.step !== 'HUMAN' || !settings) return idle;
  const { endsAt, waitingForStaff } = humanSessionEndsAt(session, settings);
  if (endsAt.getTime() <= Date.now()) return idle;
  return { paused: true, pausedUntil: endsAt, waitingForStaff };
}

// Chamado periodicamente (whatsapp.jobs.ts). Se a equipe ficou sem escrever
// além do prazo, avisa o cliente que o atendimento terminou.
export async function endIdleHumanSession(companyId: string, contactId: string, send: (text: string) => Promise<void>): Promise<boolean> {
  let ended = false;
  await withContactLock(companyId, contactId, async () => {
    const [session, settings] = await Promise.all([
      prisma.whatsAppSession.findUnique({ where: { companyId_phone: { companyId, phone: contactId } } }),
      prisma.companySettings.findUnique({ where: { companyId } }),
    ]);
    if (session?.step !== 'HUMAN' || !settings?.botEnabled) return;
    const { endsAt, waitingForStaff } = humanSessionEndsAt(session, settings);
    if (endsAt.getTime() > Date.now()) return;

    const client = await findClientByWhatsApp(companyId, contactId);
    const ctx: BotContext = { companyId, companyName: '', waId: contactId, send, settings, clientId: client?.id ?? null };
    await clearSession(ctx);
    // Ninguém da equipe respondeu: só libera o bot para a próxima mensagem.
    if (waitingForStaff) return;
    await say(ctx, fillTemplate(settings.humanEndMessage, { nome: isPlaceholderName(client?.name) ? '' : firstName(client?.name) }));
    ended = true;
  });
  return ended;
}

export async function handleIncomingMessage(message: IncomingWhatsAppMessage): Promise<void> {
  if (alreadyProcessed(message.messageId)) return;
  const company = await prisma.company.findUnique({ where: { id: message.companyId }, include: { settings: true, account: true } });
  // Empresa desativada ou assinatura vencida: o bot não atende.
  if (!company?.active || !company.settings || !isAccountActive(company.account)) return;

  const ctx: BotContext = {
    companyId: company.id,
    companyName: company.name,
    waId: message.contactId,
    send: message.send,
    saveContact: message.saveContact,
    settings: company.settings,
    clientId: null,
  };
  await withContactLock(ctx.companyId, ctx.waId, () => processMessage(ctx, message));
}

// Alguém da equipe respondeu direto pelo celular: registra a mensagem na
// conversa e pausa o bot com esse cliente, igual à resposta pelo sistema.
export async function handleMessageFromPhone(companyId: string, contactId: string, text: string): Promise<void> {
  await withContactLock(companyId, contactId, async () => {
    const client = await findClientByWhatsApp(companyId, contactId);
    if (client) await logMessage(companyId, client.id, text, MessageSender.STAFF, 'Celular da empresa');
    await pauseBotForStaff(companyId, contactId);
  });
}

type FullAppointment = appointmentsService.AppointmentWithRelations;
const servicesOf = (a: FullAppointment) => a.items.map((i) => i.name).join(' + ') || 'Atendimento';

function appointmentVars(a: FullAppointment, companyName = ''): TemplateVars {
  return { nome: firstName(a.client.name), empresa: companyName, servico: servicesOf(a), data: brDate(a.date), hora: a.startTime };
}

// Fim da confirmação do agendamento: quais lembretes o cliente vai receber.
function reminderNote(settings: CompanySettings, date: string, time: string): string {
  const now = new Date();
  const dayBefore = new Date(`${date}T12:00:00`);
  dayBefore.setDate(dayBefore.getDate() - 1);
  const withDayBefore = settings.reminderEnabled && toIsoDate(dayBefore) > toIsoDate(now);
  const withHour = settings.hourReminderEnabled && dateTime(date, time).getTime() - settings.hourReminderMinutes * 60_000 > now.getTime();
  const before = `${durationLabel(settings.hourReminderMinutes)} antes`;
  if (withDayBefore && withHour) return `Vou te mandar um lembrete na véspera e outro ${before}.`;
  if (withDayBefore) return 'Na véspera eu te mando uma mensagem para confirmar.';
  if (withHour) return `Vou te mandar um lembrete ${before}.`;
  return '';
}

// Lembretes (chamados por whatsapp.jobs.ts, dentro do lock do contato).
export async function sendDayBeforeReminder(settings: CompanySettings, companyName: string, appointment: FullAppointment, send: (text: string) => Promise<void>) {
  const ctx: BotContext = { companyId: appointment.companyId, companyName, waId: appointment.client.whatsappId!, send, settings, clientId: appointment.clientId };
  await say(ctx, blocks(fillTemplate(settings.reminderMessage, appointmentVars(appointment, companyName)), CONFIRM_OPTIONS));
  await prisma.appointment.update({ where: { id: appointment.id }, data: { reminderSentAt: new Date() } });
  await setSession(ctx, 'CONFIRM', { appointmentId: appointment.id });
}

// Pouco antes do horário: avisa e, se o cliente ainda não confirmou, pede confirmação.
export async function sendHourReminder(settings: CompanySettings, companyName: string, appointment: FullAppointment, send: (text: string) => Promise<void>) {
  const ctx: BotContext = { companyId: appointment.companyId, companyName, waId: appointment.client.whatsappId!, send, settings, clientId: appointment.clientId };
  const text = fillTemplate(settings.hourReminderMessage, appointmentVars(appointment, companyName));
  const askConfirmation = !appointment.confirmedAt;
  await say(ctx, askConfirmation ? blocks(text, CONFIRM_OPTIONS) : text);
  await prisma.appointment.update({ where: { id: appointment.id }, data: { hourReminderSentAt: new Date() } });
  if (askConfirmation) await setSession(ctx, 'CONFIRM', { appointmentId: appointment.id });
}

// Áudio -> texto, quando a transcrição está ligada e configurada no servidor.
async function audioText(ctx: BotContext, audio: IncomingWhatsAppMessage['audio']): Promise<string | null> {
  if (!audio || !ctx.settings.transcribeAudio || !transcriptionEnabled() || audio.seconds > env.TRANSCRIBE_MAX_SECONDS) return null;
  try {
    return await transcribeAudio(ctx.companyId, await audio.load(), audio.mimetype, audio.seconds);
  } catch (err) {
    console.error('Não foi possível transcrever o áudio:', err);
    return null;
  }
}

async function processMessage(ctx: BotContext, message: IncomingWhatsAppMessage) {
  const { settings } = ctx;
  const transcript = message.text ? null : await audioText(ctx, message.audio);
  const text = message.text ?? transcript;
  const profileName = cleanName(message.profileName) || undefined;

  let client = await findClientByWhatsApp(ctx.companyId, ctx.waId);
  if (!client && settings.autoCreateClient) {
    client = await prisma.client.create({
      data: {
        companyId: ctx.companyId,
        name: profileName ?? placeholderName(ctx.waId),
        phone: formatPhone(ctx.waId),
        whatsappId: ctx.waId,
        source: Source.BOT,
      },
    });
    if (profileName) await saveContact({ ...ctx, clientId: client.id }, profileName);
  }
  ctx.clientId = client?.id ?? null;
  const logged = transcript ? `🎤 Áudio: "${transcript}"` : text ?? `[${MEDIA_LABELS[message.mediaType ?? ''] ?? 'mensagem'}]`;
  await logMessage(ctx.companyId, ctx.clientId, logged, MessageSender.CLIENT);

  let session = await prisma.whatsAppSession.findUnique({ where: { companyId_phone: { companyId: ctx.companyId, phone: ctx.waId } } });
  if (session && (sessionExpired(session, settings) || (text && RESET_WORDS.has(normalize(text))))) {
    await clearSession(ctx);
    session = null;
  }

  if (!settings.botEnabled) return;

  const name = firstName(isPlaceholderName(client?.name) ? profileName : client?.name);
  if (!session) {
    // Respondeu o lembrete depois que a conversa expirou: ainda vale como resposta.
    const pending = ctx.clientId ? await awaitingConfirmation(ctx.companyId, ctx.clientId) : null;
    if (text && pending && await answerConfirmation(ctx, pending, normalize(text))) return;

    const askName = settings.askName && (client ? isPlaceholderName(client.name) : !profileName);
    // Já chegou dizendo o que quer ("queria agendar um corte"): boas-vindas e vai direto.
    if (text && !SMALL_TALK.test(normalize(text)) && await tryAiMenu(ctx, flowOf(ctx), { askName }, text, name, true)) return;
    await sendWelcome(ctx, name, { askName });
    return;
  }

  // "0", "voltar" ou "menu" em qualquer etapa volta ao menu principal
  // (também tira o cliente da espera pela equipe).
  if (text && BACK_WORDS.has(normalize(text))) {
    await setSession(ctx, 'MENU', { askName: (session.data as SessionData)?.askName });
    await say(ctx, mainMenu(ctx));
    return;
  }

  if (session.step === 'HUMAN') return;
  if (!text) {
    await say(ctx, message.audio
      ? 'Não consegui ouvir seu áudio. Pode escrever sua resposta?'
      : 'Por enquanto só consigo entender mensagens de texto. Pode digitar sua resposta?');
    return;
  }
  await advance(ctx, session.step as BotStep, (session.data as SessionData) ?? {}, text, name);
}

async function advance(ctx: BotContext, step: BotStep, data: SessionData, text: string, name: string) {
  const answer = normalize(text);

  if (step === 'MENU') {
    const root = flowOf(ctx);
    // Submenu removido do fluxo enquanto o cliente estava nele: usa o principal.
    const found = findNode(root, data.nodeId);
    const menu = found?.node.type === 'menu' ? found.node : root;
    const option = pickMenuOption(answer, menu);
    if (option) {
      await runNode(ctx, option, menu, data, name);
      return;
    }
    if (!SMALL_TALK.test(answer) && await tryAiMenu(ctx, menu, data, text, name, false)) return;
    if (data.idle) {
      // Conversa anterior concluída ("obrigado", "oi"...): recomeça com as boas-vindas.
      await sendWelcome(ctx, name, { askName: data.askName });
      return;
    }
    await say(ctx, blocks('Não entendi.', menuText(ctx, menu)));
    return;
  }

  if (step === 'ASK_NAME') {
    const typed = cleanName(text);
    if (typed.length < 2 || /^\d+$/.test(typed)) {
      await say(ctx, blocks('Pode me dizer seu nome, por favor?', BACK_OPTION));
      return;
    }
    if (ctx.clientId) await prisma.client.update({ where: { id: ctx.clientId }, data: { name: typed } });
    await saveContact(ctx, typed);
    await offerServices(ctx, { ...data, askName: false }, `Prazer, ${firstName(typed)}!`);
    return;
  }

  if (step === 'ASK_SERVICE') {
    const services = await activeServices(ctx.companyId);
    let chosen = pickServices(text, services);
    let { wish } = data;
    if (!chosen) {
      const u = await aiUnderstand(ctx, serviceQuestion(services), services.map((s) => s.name), text, services);
      const picked = u?.services.length ? u.services : u?.option ? [u.option] : [];
      if (picked.length) {
        chosen = picked.map((n) => services[n - 1]);
        wish = wishOf(u) ?? wish;
      } else if (u?.answer) {
        await say(ctx, blocks(u.answer, serviceQuestion(services)));
        return;
      }
    }
    if (!chosen) {
      await say(ctx, blocks('Não encontrei esse serviço.', serviceQuestion(services)));
      return;
    }
    const duration = chosen.reduce((sum, s) => sum + s.durationMinutes, 0);
    const total = chosen.length > 1 ? ` Os ${chosen.length} serviços levam cerca de ${durationLabel(duration)} no total.` : '';
    await scheduleWish(ctx, { ...data, wish, serviceIds: chosen.map((s) => s.id) }, `Perfeito, ${chosen.map((s) => s.name).join(' + ')}!${total}`);
    return;
  }

  if (step === 'ASK_DATE') {
    const date = pickFromList(answer, data.days) ?? parseBrDate(text);
    if (date) {
      await scheduleWish(ctx, { ...data, wish: { date } });
      return;
    }
    const u = await aiUnderstand(ctx, 'Qual dia fica bom para você?', (data.days ?? []).map((d) => dayLabel(d)), text);
    const picked = (u?.option ? data.days?.[u.option - 1] : undefined) ?? u?.date;
    if (picked) {
      await scheduleWish(ctx, { ...data, wish: { date: picked, time: u?.time ?? undefined } });
      return;
    }
    await offerDays(ctx, data, u?.answer ?? 'Não entendi o dia (ou ele já passou).');
    return;
  }

  if (step === 'ASK_TIME') {
    if (!data.date || !data.serviceIds?.length) {
      await offerServices(ctx, data, 'Vamos recomeçar o agendamento.');
      return;
    }
    let time = pickFromList(answer, data.times) ?? parseTime(text);
    let note = 'Não entendi o horário.';
    if (!time) {
      const u = await aiUnderstand(ctx, `Horários livres ${onDay(data.date)}. Qual horário?`, data.times ?? [], text);
      // "Tem na sexta?": muda o dia.
      if (u?.date && u.date !== data.date) {
        await scheduleWish(ctx, { ...data, wish: { date: u.date, time: u.time ?? undefined } });
        return;
      }
      time = (u?.option ? data.times?.[u.option - 1] : undefined) ?? u?.time ?? null;
      if (u?.answer) note = u.answer;
    }
    if (!time) {
      const times = await freeTimes(ctx.companyId, ctx.settings, data.date, await durationOf(ctx, data), data.appointmentId);
      await offerTimes(ctx, data, times, note);
      return;
    }
    await book(ctx, data, time);
    return;
  }

  if (step === 'MANAGE') {
    const appointment = data.appointmentId ? await findActive(ctx, data.appointmentId) : null;
    if (!appointment) {
      await showAppointments(ctx, {});
      return;
    }
    let action = pickFromList(answer, data.manage) ?? manageActionFromText(answer);
    let wish: SessionData['wish'];
    let note = 'Não entendi.';
    if (!action) {
      const u = await aiUnderstand(ctx, `Seu próximo horário: ${servicesOf(appointment)} ${onDay(appointment.date)} às ${appointment.startTime}.`, (data.manage ?? []).map((a) => MANAGE_LABELS[a]), text);
      action = manageActionOf(u, data.manage ?? []);
      wish = wishOf(u);
      if (u?.answer) note = u.answer;
    }
    if (!action || !(await answerConfirmation(ctx, appointment, MANAGE_CODES[action], wish))) await showAppointment(ctx, appointment, note);
    return;
  }

  if (step === 'CONFIRM') {
    const appointment = data.appointmentId ? await findActive(ctx, data.appointmentId) : null;
    if (!appointment) {
      // Horário já passou ou foi alterado pela equipe.
      await sendWelcome(ctx, name, {});
      return;
    }
    if (await answerConfirmation(ctx, appointment, answer)) return;
    const u = await aiUnderstand(ctx, `Lembrete do horário: ${servicesOf(appointment)} ${onDay(appointment.date)} às ${appointment.startTime}.`, CONFIRM_ACTIONS.map((a) => MANAGE_LABELS[a]), text);
    const action = manageActionOf(u, CONFIRM_ACTIONS);
    if (action && await answerConfirmation(ctx, appointment, MANAGE_CODES[action], wishOf(u))) return;
    await say(ctx, blocks(u?.answer ?? 'Não entendi.', CONFIRM_OPTIONS));
  }
}

// ---------- IA do atendimento ----------

// Chama a IA (se ligada) com a pergunta e as opções que o cliente acabou de ver.
async function aiUnderstand(ctx: BotContext, question: string, options: string[], text: string, services?: Service[]): Promise<Understanding | null> {
  if (!env.ANTHROPIC_API_KEY || !ctx.settings.botAiEnabled) return null;
  return understand({
    companyId: ctx.companyId,
    companyName: ctx.companyName,
    settings: ctx.settings,
    flow: flowOf(ctx),
    services: services ?? await activeServices(ctx.companyId),
    question,
    options,
    text,
  });
}

const wishOf = (u: Understanding | null): SessionData['wish'] =>
  u?.date || u?.time ? { date: u.date ?? undefined, time: u.time ?? undefined } : undefined;

function manageActionOf(u: Understanding | null, offered: ManageAction[]): ManageAction | undefined {
  if (!u) return undefined;
  if (u.option) return offered[u.option - 1];
  return offered.find((a) => a === u.intent);
}

// Opção do menu que corresponde ao que a IA entendeu (número ou intenção).
function optionFromAi(u: Understanding, menu: FlowNode): FlowNode | undefined {
  const options = menu.options ?? [];
  if (u.option) return options[u.option - 1];
  const manage = CONFIRM_ACTIONS.includes(u.intent as ManageAction);
  const action = manage ? 'meus' : (['agendar', 'meus', 'servicos', 'equipe'] as const).find((a) => a === u.intent);
  return action ? options.find((o) => o.type === 'action' && o.action === action) : undefined;
}

// Texto livre no menu (ou na primeira mensagem): segue para a opção certa,
// já levando serviço/dia/horário, ou responde a pergunta e mostra o menu de novo.
// Devolve false quando a IA não ajudou (o bot segue com o comportamento normal).
async function tryAiMenu(ctx: BotContext, menu: FlowNode, data: SessionData, text: string, name: string, greet: boolean): Promise<boolean> {
  const root = flowOf(ctx);
  const vars = { empresa: ctx.companyName };
  const services = env.ANTHROPIC_API_KEY && ctx.settings.botAiEnabled ? await activeServices(ctx.companyId) : [];
  const u = await aiUnderstand(ctx, menuText(ctx, menu), (menu.options ?? []).map((o) => fillTemplate(o.label, vars)), text, services);
  if (!u) return false;
  let parent = menu;
  let option = optionFromAi(u, menu);
  if (!option && menu.id !== root.id) {
    option = optionFromAi({ ...u, option: null }, root);
    parent = root;
  }
  if (!option && !u.answer) return false;

  if (greet) await sayParts(ctx, root.messages.map((m) => fillTemplate(m, { nome: name, empresa: ctx.companyName })), root.together);
  if (!option) {
    await setSession(ctx, 'MENU', { askName: data.askName, nodeId: menu.id === root.id ? undefined : menu.id });
    await say(ctx, blocks(u.answer, menuText(ctx, menu)));
    return true;
  }

  // "Quero remarcar pra sexta": vai direto no próximo horário do cliente.
  const manage = CONFIRM_ACTIONS.find((a) => a === u.intent);
  if (manage && option.type === 'action' && option.action === 'meus' && ctx.clientId) {
    const next = await appointmentsService.nextAppointmentOf(ctx.companyId, ctx.clientId);
    if (next && await answerConfirmation(ctx, next, MANAGE_CODES[manage], wishOf(u))) return true;
  }

  const serviceIds = u.services.map((n) => services[n - 1]?.id).filter((id): id is string => Boolean(id));
  await runNode(ctx, option, parent, { askName: data.askName, serviceIds: serviceIds.length ? serviceIds : undefined, wish: wishOf(u) }, name);
  return true;
}

// Serviço escolhido: usa o dia e o horário que o cliente já pediu, se houver.
// Horário livre = agenda direto; senão oferece os horários do dia ou outros dias.
async function scheduleWish(ctx: BotContext, data: SessionData, prefix?: string) {
  const { wish, ...rest } = data;
  const date = wish?.date;
  if (!date) {
    await offerDays(ctx, rest, prefix ?? '');
    return;
  }
  if (!ctx.settings.workDays.includes(weekdayOf(date))) {
    await offerDays(ctx, rest, blocks(prefix, `Não atendemos ${WEEKDAYS[weekdayOf(date)]}.`));
    return;
  }
  const times = await freeTimes(ctx.companyId, ctx.settings, date, await durationOf(ctx, rest), rest.appointmentId);
  if (!times.length) {
    await offerDays(ctx, rest, blocks(prefix, `Não temos mais horários livres ${onDay(date)}.`));
    return;
  }
  if (wish.time && times.includes(wish.time)) {
    await book(ctx, { ...rest, date }, wish.time, prefix);
    return;
  }
  await offerTimes(ctx, { ...rest, date }, times, blocks(prefix, wish.time && `Às ${wish.time} não temos horário livre ${onDay(date)}.`));
}

function manageActionFromText(answer: string): ManageAction | undefined {
  if (/remarc|mudar|trocar/.test(answer)) return 'remarcar';
  if (/cancel|desmarc/.test(answer)) return 'cancelar';
  if (/confirm/.test(answer)) return 'confirmar';
  return undefined;
}

function serviceQuestion(services: Service[]): string {
  return blocks(
    'Qual serviço você deseja? Responda com o número:',
    numbered(services.map((s) => `${s.name} (${durationLabel(s.durationMinutes)}${s.priceCents ? ` · ${money(s.priceCents)}` : ''})`)),
    services.length > 1 && 'Quer fazer mais de um? Mande os números juntos, por exemplo: 1,2.',
    BACK_OPTION,
  );
}

// "1", "1,2", "1 2", "1 e 2", "corte" -> serviços escolhidos (sem repetir).
function pickServices(text: string, services: Service[]): Service[] | null {
  const answer = normalize(text);
  const byName = services.find((s) => normalize(s.name) === answer);
  if (byName) return [byName];
  const parts = answer.replace(/\be\b/g, ' ').split(/[\s,;/+]+/).filter(Boolean);
  if (!parts.length || !parts.every((p) => /^\d{1,2}$/.test(p))) return null;
  const chosen = parts.map((p) => services[Number(p) - 1]);
  if (chosen.some((s) => !s)) return null;
  return [...new Set(chosen)];
}

async function durationOf(ctx: BotContext, data: SessionData) {
  const services = await prisma.service.findMany({ where: { companyId: ctx.companyId, id: { in: data.serviceIds ?? [] } } });
  return services.reduce((sum, s) => sum + s.durationMinutes, 0) || ctx.settings.slotMinutes;
}

async function showCatalog(ctx: BotContext, data: SessionData, prefix?: string) {
  const services = await activeServices(ctx.companyId);
  await setSession(ctx, 'MENU', { askName: data.askName, idle: true });
  if (!services.length) {
    await say(ctx, blocks(prefix, 'Ainda não temos serviços cadastrados por aqui.', mainMenu(ctx)));
    return;
  }
  const list = services.map((s) => {
    const price = s.priceCents ? money(s.priceCents) : 'valor sob consulta';
    return `• ${s.name}: ${price} (${durationLabel(s.durationMinutes)})${s.description ? `\n   ${s.description}` : ''}`;
  }).join('\n');
  const bookOption = (flowOf(ctx).options ?? []).findIndex((o) => o.action === 'agendar');
  await say(ctx, blocks(prefix, 'Nossos serviços:', list, bookOption >= 0 && `Para agendar, responda ${bookOption + 1}.`, mainMenu(ctx)));
}

async function offerServices(ctx: BotContext, data: SessionData, prefix: string) {
  const services = await activeServices(ctx.companyId);
  if (!services.length) {
    await handOff(ctx, blocks(prefix, 'Ainda não temos serviços disponíveis para agendar pelo WhatsApp.'));
    return;
  }
  // O cliente já disse o serviço (IA): pula a pergunta.
  const known = services.filter((s) => data.serviceIds?.includes(s.id));
  if (known.length) {
    await scheduleWish(ctx, { ...data, serviceIds: known.map((s) => s.id) }, `${prefix} Vamos agendar ${known.map((s) => s.name).join(' + ')}.`.trim());
    return;
  }
  if (services.length === 1) {
    await scheduleWish(ctx, { ...data, serviceIds: [services[0].id] }, `${prefix} Vamos agendar ${services[0].name}.`.trim());
    return;
  }
  await setSession(ctx, 'ASK_SERVICE', data);
  await say(ctx, blocks(prefix, serviceQuestion(services)));
}

async function offerDays(ctx: BotContext, data: SessionData, prefix: string) {
  const days = await nextFreeDays(ctx.companyId, ctx.settings, DAYS_OFFERED, await durationOf(ctx, data), data.appointmentId);
  if (!days.length) {
    await handOff(ctx, blocks(prefix, 'Não encontrei horários livres nos próximos dias.'));
    return;
  }
  await setSession(ctx, 'ASK_DATE', { ...data, days, date: undefined, times: undefined });
  await say(ctx, blocks(
    prefix,
    'Estes são os próximos dias com horário livre:',
    numbered(days.map((d) => dayLabel(d))),
    `Responda com o número do dia ou digite outra data (ex.: ${brDate(days[0])}).`,
    BACK_OPTION,
  ));
}

async function offerTimes(ctx: BotContext, data: SessionData, times: string[], prefix?: string) {
  if (!times.length) {
    await offerDays(ctx, data, blocks(prefix, 'Esse dia não tem mais horários livres. Que outro dia fica bom para você?'));
    return;
  }
  await setSession(ctx, 'ASK_TIME', { ...data, times });
  await say(ctx, blocks(prefix, `Horários livres ${onDay(data.date!)}:`, numbered(times), 'Responda com o número do horário.', BACK_OPTION));
}

async function book(ctx: BotContext, data: SessionData, time: string, prefix?: string) {
  const { settings } = ctx;
  const date = data.date!;
  const duration = await durationOf(ctx, data);

  // Confere de novo: outro cliente pode ter pego o horário enquanto este respondia.
  if (!(await isTimeFree(ctx.companyId, settings, date, time, duration, data.appointmentId))) {
    const times = await freeTimes(ctx.companyId, settings, date, duration, data.appointmentId);
    await offerTimes(ctx, data, times, `O horário ${time} não está disponível.`);
    return;
  }

  // "Criar cliente automaticamente" desligado: o cliente só entra no sistema
  // quando conclui um agendamento.
  if (!ctx.clientId) {
    const client = await prisma.client.create({
      data: { companyId: ctx.companyId, name: placeholderName(ctx.waId), phone: formatPhone(ctx.waId), whatsappId: ctx.waId, source: Source.BOT },
    });
    ctx.clientId = client.id;
  }

  let appointment: FullAppointment;
  try {
    appointment = data.appointmentId
      ? await appointmentsService.updateAppointment(ctx.companyId, data.appointmentId, { date, startTime: time, ignoreConflicts: true })
      : await appointmentsService.createAppointment(ctx.companyId, {
          clientId: ctx.clientId,
          serviceIds: data.serviceIds!,
          date,
          startTime: time,
          ignoreConflicts: true,
        }, Source.BOT);
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    await offerDays(ctx, data, err.message);
    return;
  }

  await finishConversation(ctx);
  const confirmation = fillTemplate(settings.confirmationMessage, appointmentVars(appointment, ctx.companyName));
  const duration2 = `Duração prevista: ${durationLabel(duration)} (até ${appointment.endTime}).`;
  await say(ctx, blocks(data.appointmentId ? 'Pronto, horário remarcado!' : prefix, confirmation, duration2, reminderNote(settings, date, time)));
}

async function findActive(ctx: BotContext, appointmentId: string) {
  const appointment = await prisma.appointment.findFirst({
    where: { id: appointmentId, companyId: ctx.companyId, status: { in: [AppointmentStatus.SCHEDULED, AppointmentStatus.CONFIRMED] } },
    include: appointmentsService.appointmentInclude,
  });
  if (!appointment || dateTime(appointment.date, appointment.startTime).getTime() <= Date.now()) return null;
  return appointment;
}

// Lembrete enviado, cliente ainda não respondeu e o horário não passou.
async function awaitingConfirmation(companyId: string, clientId: string) {
  const next = await appointmentsService.nextAppointmentOf(companyId, clientId);
  if (!next || next.confirmedAt || !(next.reminderSentAt || next.hourReminderSentAt)) return null;
  return next;
}

// "Meus agendamentos": próximo horário (com ações) e os demais marcados.
async function showAppointments(ctx: BotContext, data: SessionData, prefix?: string) {
  const next = ctx.clientId ? await appointmentsService.nextAppointmentOf(ctx.companyId, ctx.clientId) : null;
  if (!next) {
    await setSession(ctx, 'MENU', { askName: data.askName });
    await say(ctx, blocks(prefix, 'Você não tem nenhum horário marcado no momento.', mainMenu(ctx)));
    return;
  }
  await showAppointment(ctx, next, prefix);
}

async function showAppointment(ctx: BotContext, appointment: FullAppointment, prefix?: string) {
  const actions: ManageAction[] = [...(appointment.confirmedAt ? [] : ['confirmar' as const]), 'remarcar', 'cancelar'];
  await setSession(ctx, 'MANAGE', { appointmentId: appointment.id, manage: actions });
  await say(ctx, blocks(
    prefix,
    `Seu próximo horário: ${servicesOf(appointment)} ${onDay(appointment.date)} às ${appointment.startTime}.`,
    appointment.confirmedAt ? 'Presença confirmada ✅' : 'Presença ainda não confirmada.',
    'Responda com o número:',
    numbered(actions.map((a) => MANAGE_LABELS[a])),
    BACK_OPTION,
  ));
}

// Resposta ao lembrete ou ação escolhida em "Meus agendamentos".
// Devolve false se a mensagem não for uma das opções.
async function answerConfirmation(ctx: BotContext, appointment: FullAppointment, answer: string, wish?: SessionData['wish']): Promise<boolean> {
  const when = `${servicesOf(appointment)} ${onDay(appointment.date)} às ${appointment.startTime}`;

  if (CONFIRM_WORDS.has(answer)) {
    await appointmentsService.setStatus(ctx.companyId, appointment.id, AppointmentStatus.CONFIRMED);
    await finishConversation(ctx);
    await say(ctx, `Obrigado, ${firstName(appointment.client.name)}! Está confirmado: ${when}. Até lá!`);
    return true;
  }
  if (answer === '2' || answer.includes('remarc')) {
    const serviceIds = appointment.items.map((i) => i.serviceId).filter((id): id is string => Boolean(id));
    await scheduleWish(ctx, { appointmentId: appointment.id, serviceIds, wish }, 'Sem problemas, vamos remarcar.');
    return true;
  }
  if (answer === '3' || answer.includes('cancel')) {
    await appointmentsService.setStatus(ctx.companyId, appointment.id, AppointmentStatus.CANCELED);
    await finishConversation(ctx);
    await say(ctx, 'Tudo bem, seu horário foi cancelado. Quando quiser marcar de novo, é só mandar uma mensagem por aqui.');
    return true;
  }
  return false;
}
