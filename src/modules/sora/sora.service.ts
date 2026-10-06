import { Prisma, ServiceKind } from '@prisma/client';
import { HttpError } from '../../lib/httpError';
import { prisma } from '../../lib/prisma';
import * as settingsService from '../settings/settings.service';
import { FlowNode, getFlow } from '../whatsapp/whatsapp.flow';
import { CatalogChange, ClientChange, SoraMode, askSora, soraUsage } from '../whatsapp/whatsapp.sora';

// Conversas com a Sora salvas no banco: o menu Sora (chat livre, catálogo,
// clientes e fluxo) e o painel do Fluxo do bot usam as mesmas conversas, que
// ficam no histórico. Mudanças no catálogo e nos clientes propostas pela Sora
// só entram no sistema quando o dono confirma (applyChanges); exclusões pedem
// uma segunda confirmação na tela.

const MAX_HISTORY = 20;
const TITLE_MAX = 60;

// catalogAppliedAt: quando o dono confirmou as mudanças (catálogo e clientes da mensagem).
type Payload = { flow?: FlowNode | null; catalog?: CatalogChange[] | null; clients?: ClientChange[] | null; catalogAppliedAt?: string };

const conversationSummary = { id: true, title: true, source: true, createdAt: true, updatedAt: true, _count: { select: { messages: true } } } as const;

async function requireConversation(companyId: string, id: string) {
  const conversation = await prisma.soraConversation.findFirst({ where: { id, companyId } });
  if (!conversation) throw HttpError.notFound('Conversa não encontrada.');
  return conversation;
}

export async function listConversations(companyId: string) {
  return prisma.soraConversation.findMany({ where: { companyId }, orderBy: { updatedAt: 'desc' }, take: 100, select: conversationSummary });
}

export async function getConversation(companyId: string, id: string) {
  const conversation = await requireConversation(companyId, id);
  const messages = await prisma.soraMessage.findMany({ where: { conversationId: id }, orderBy: { createdAt: 'asc' } });
  return { conversation, messages };
}

export async function deleteConversation(companyId: string, id: string) {
  await requireConversation(companyId, id);
  await prisma.soraConversation.delete({ where: { id } });
}

// Manda uma mensagem (cria a conversa se não vier id). No modo "fluxo" o
// editor manda o fluxo que está na tela; no "chat", vale o fluxo salvo.
export async function sendMessage(companyId: string, userId: string, input: { conversationId?: string | null; text: string; mode: SoraMode; flow?: FlowNode }) {
  let conversation = input.conversationId ? await requireConversation(companyId, input.conversationId) : null;
  const previous = conversation
    ? await prisma.soraMessage.findMany({ where: { conversationId: conversation.id }, orderBy: { createdAt: 'desc' }, take: MAX_HISTORY })
    : [];
  const history = [...previous.reverse().map((m) => ({ role: m.role as 'user' | 'assistant', text: m.text })), { role: 'user' as const, text: input.text }];
  const currentFlow = input.flow ?? getFlow(await settingsService.getSettings(companyId));

  // Primeiro pergunta à Sora: se ela falhar, nada é gravado.
  const result = await askSora(companyId, history, currentFlow, input.mode);

  conversation ??= await prisma.soraConversation.create({
    data: { companyId, userId, source: input.mode, title: input.text.replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX) || 'Conversa' },
  });
  const payload: Payload | null = result.flow || result.catalog || result.clients
    ? { flow: result.flow, catalog: result.catalog, clients: result.clients }
    : null;
  const [userMessage, assistantMessage] = await prisma.$transaction([
    prisma.soraMessage.create({ data: { conversationId: conversation.id, role: 'user', text: input.text } }),
    prisma.soraMessage.create({ data: { conversationId: conversation.id, role: 'assistant', text: result.reply, payload: (payload ?? Prisma.JsonNull) as Prisma.InputJsonValue } }),
    prisma.soraConversation.update({ where: { id: conversation.id }, data: { updatedAt: new Date() } }),
  ]);
  return { conversation, messages: [userMessage, assistantMessage], flow: result.flow, catalog: result.catalog, clients: result.clients, usage: result.usage };
}

// Produto não ocupa horário; serviço precisa de duração (mínimo 5 min).
function serviceData(change: CatalogChange) {
  const kind = change.kind === 'PRODUCT' ? ServiceKind.PRODUCT : ServiceKind.SERVICE;
  const duration = kind === ServiceKind.PRODUCT ? 0 : Math.min(600, Math.max(5, change.durationMinutes ?? 60));
  return {
    kind,
    name: change.name.trim().slice(0, 60),
    description: change.description?.trim().slice(0, 300) || null,
    priceCents: Math.max(0, Math.min(100_000_000, change.priceCents ?? 0)),
    durationMinutes: duration,
    ...(change.active === null ? {} : { active: change.active }),
  };
}

const onlyDigits = (value: string) => value.replace(/\D/g, '');

// Mesma regra da tela de clientes: telefone -> wa_id (55 + DDD + número).
function whatsappIdFromPhone(phone: string): string | null {
  const digits = onlyDigits(phone);
  if (digits.length === 10 || digits.length === 11) return `55${digits}`;
  if (digits.length >= 12) return digits;
  return null;
}

type Applied = { created: string[]; updated: string[]; deleted: string[]; skipped: string[] };
type Write = (tx: Prisma.TransactionClient) => Promise<unknown>;

// As buscas (achar o item/cliente de cada mudança) ficam fora da transação, numa
// consulta só; dentro dela vão apenas as gravações. Com o banco longe (ex.: backend
// local + Supabase), consultas uma a uma estouravam o tempo da transação (P2028).

async function planCatalog(companyId: string, changes: CatalogChange[], out: Applied, writes: Write[]) {
  const services = await prisma.service.findMany({ where: { companyId }, select: { id: true, name: true } });
  const byId = new Map(services.map((sv) => [sv.id, sv]));
  const byName = new Map(services.map((sv) => [sv.name.trim().toLowerCase(), sv]));
  let position = services.length;
  for (const change of changes) {
    const data = serviceData(change);
    if (!data.name) continue;
    // Pelo id; se não achar, pelo nome (evita duplicar ou excluir o item errado).
    const existing = (change.id ? byId.get(change.id) : undefined) ?? byName.get(data.name.toLowerCase());
    // Já vai ser criado por esta mesma lista (nome repetido): ignora a repetição.
    if (existing && !existing.id) { out.skipped.push(data.name); continue; }
    if (change.op === 'delete') {
      // Agendamentos antigos mantêm nome, duração e preço (AppointmentItem).
      if (existing) { writes.push((tx) => tx.service.delete({ where: { id: existing.id } })); out.deleted.push(existing.name); }
      else out.skipped.push(data.name);
    } else if (existing) {
      writes.push((tx) => tx.service.update({ where: { id: existing.id }, data }));
      out.updated.push(data.name);
    } else {
      const created = { ...data, companyId, position: position++ };
      writes.push((tx) => tx.service.create({ data: created }));
      out.created.push(data.name);
      // Mesmo nome repetido na lista: os próximos viram update deste.
      byName.set(data.name.toLowerCase(), { id: '', name: data.name });
    }
  }
}

async function planClients(companyId: string, changes: ClientChange[], out: Applied, writes: Write[]) {
  const prepared = changes.map((change) => {
    const phone = change.phone?.trim().slice(0, 30) || null;
    return { change, name: change.name.trim().slice(0, 120), phone, whatsappId: phone ? whatsappIdFromPhone(phone) : null };
  });
  const ids = prepared.map((p) => p.change.id).filter((id): id is string => Boolean(id));
  const whatsappIds = prepared.map((p) => p.whatsappId).filter((id): id is string => Boolean(id));
  const found = ids.length || whatsappIds.length
    ? await prisma.client.findMany({
      where: { companyId, OR: [...(ids.length ? [{ id: { in: ids } }] : []), ...(whatsappIds.length ? [{ whatsappId: { in: whatsappIds } }] : [])] },
      select: { id: true, name: true, source: true, whatsappId: true },
    })
    : [];
  for (const { change, name, phone, whatsappId } of prepared) {
    const existing = (change.id ? found.find((c) => c.id === change.id) : undefined)
      ?? (whatsappId ? found.find((c) => c.whatsappId === whatsappId) : undefined);
    const email = change.email?.trim() || null;
    const notes = change.notes?.trim().slice(0, 2000) || null;
    if (change.op === 'delete') {
      // Sem id nem telefone que batam, não exclui por nome (pode haver homônimos).
      if (existing && existing.id) { writes.push((tx) => tx.client.delete({ where: { id: existing.id } })); out.deleted.push(existing.name); }
      else out.skipped.push(name);
    } else if (existing && existing.id) {
      const data = {
        ...(name ? { name } : {}),
        ...(phone ? { phone, ...(existing.source !== 'BOT' && whatsappId ? { whatsappId } : {}) } : {}),
        ...(email ? { email } : {}),
        ...(notes ? { notes } : {}),
      };
      writes.push((tx) => tx.client.update({ where: { id: existing.id }, data }));
      out.updated.push(name || existing.name);
    } else if (change.op === 'create' && name && phone && onlyDigits(phone).length >= 8) {
      writes.push((tx) => tx.client.create({ data: { companyId, name, phone, whatsappId, email, notes } }));
      out.created.push(name);
      // Mesmo telefone repetido na lista: não cadastra duas vezes.
      if (whatsappId) found.push({ id: '', name, source: 'STAFF', whatsappId });
    } else {
      out.skipped.push(name);
    }
  }
}

// O dono confirmou: aplica no catálogo e nos clientes o que a Sora propôs
// naquela mensagem (exclusões já passaram pela confirmação extra da tela).
export async function applyChanges(companyId: string, messageId: string) {
  const message = await prisma.soraMessage.findFirst({ where: { id: messageId, conversation: { companyId } } });
  if (!message) throw HttpError.notFound('Mensagem não encontrada.');
  const payload = (message.payload ?? {}) as Payload;
  if (!payload.catalog?.length && !payload.clients?.length) throw HttpError.badRequest('Essa mensagem não tem mudanças para aplicar.');
  if (payload.catalogAppliedAt) throw HttpError.conflict('Essas mudanças já foram aplicadas.');

  const out: Applied = { created: [], updated: [], deleted: [], skipped: [] };
  const writes: Write[] = [];
  if (payload.catalog?.length) await planCatalog(companyId, payload.catalog, out, writes);
  if (payload.clients?.length) await planClients(companyId, payload.clients, out, writes);

  // Tudo ou nada. Tempo maior que o padrão (5 s) para listas grandes com o banco longe.
  await prisma.$transaction(async (tx) => {
    for (const write of writes) await write(tx);
    await tx.soraMessage.update({ where: { id: message.id }, data: { payload: { ...payload, catalogAppliedAt: new Date().toISOString() } as Prisma.InputJsonValue } });
  }, { maxWait: 10_000, timeout: 30_000 });
  return out;
}

export { soraUsage };
