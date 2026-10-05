import { Prisma, ServiceKind } from '@prisma/client';
import { HttpError } from '../../lib/httpError';
import { prisma } from '../../lib/prisma';
import * as settingsService from '../settings/settings.service';
import { FlowNode, getFlow } from '../whatsapp/whatsapp.flow';
import { CatalogChange, SoraMode, askSora, soraUsage } from '../whatsapp/whatsapp.sora';

// Conversas com a Sora salvas no banco: o menu Sora (chat livre, catálogo e
// fluxo) e o painel do Fluxo do bot usam as mesmas conversas, que ficam no
// histórico. Mudanças de catálogo propostas pela Sora só entram no sistema
// quando o dono confirma (applyCatalog).

const MAX_HISTORY = 20;
const TITLE_MAX = 60;

type Payload = { flow?: FlowNode | null; catalog?: CatalogChange[] | null; catalogAppliedAt?: string };

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
  const payload: Payload | null = result.flow || result.catalog ? { flow: result.flow, catalog: result.catalog } : null;
  const [userMessage, assistantMessage] = await prisma.$transaction([
    prisma.soraMessage.create({ data: { conversationId: conversation.id, role: 'user', text: input.text } }),
    prisma.soraMessage.create({ data: { conversationId: conversation.id, role: 'assistant', text: result.reply, payload: (payload ?? Prisma.JsonNull) as Prisma.InputJsonValue } }),
    prisma.soraConversation.update({ where: { id: conversation.id }, data: { updatedAt: new Date() } }),
  ]);
  return { conversation, messages: [userMessage, assistantMessage], flow: result.flow, catalog: result.catalog, usage: result.usage };
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

// O dono confirmou: cadastra/atualiza o que a Sora propôs naquela mensagem.
export async function applyCatalog(companyId: string, messageId: string) {
  const message = await prisma.soraMessage.findFirst({ where: { id: messageId, conversation: { companyId } } });
  if (!message) throw HttpError.notFound('Mensagem não encontrada.');
  const payload = (message.payload ?? {}) as Payload;
  if (!payload.catalog?.length) throw HttpError.badRequest('Essa mensagem não tem mudanças no catálogo.');
  if (payload.catalogAppliedAt) throw HttpError.conflict('Essas mudanças já foram aplicadas no catálogo.');

  const created: string[] = [];
  const updated: string[] = [];
  await prisma.$transaction(async (tx) => {
    let position = await tx.service.count({ where: { companyId } });
    for (const change of payload.catalog!) {
      const data = serviceData(change);
      if (!data.name) continue;
      // Update pelo id; se não achar, pelo nome (evita duplicar).
      const existing = (change.id ? await tx.service.findFirst({ where: { id: change.id, companyId } }) : null)
        ?? await tx.service.findFirst({ where: { companyId, name: { equals: data.name, mode: 'insensitive' } } });
      if (existing) {
        await tx.service.update({ where: { id: existing.id }, data });
        updated.push(data.name);
      } else {
        await tx.service.create({ data: { ...data, companyId, position: position++ } });
        created.push(data.name);
      }
    }
    await tx.soraMessage.update({ where: { id: message.id }, data: { payload: { ...payload, catalogAppliedAt: new Date().toISOString() } as Prisma.InputJsonValue } });
  });
  return { created, updated };
}

export { soraUsage };
