import { CompanySettings, Prisma } from '@prisma/client';
import { HttpError } from '../../lib/httpError';
import { prisma } from '../../lib/prisma';
import { getSettings } from '../settings/settings.service';
import { FlowNode, FlowTemplate, TEMPLATE_NAMES, flowSchema, getFlow, templateFlow } from './whatsapp.flow';

// Fluxos do bot da empresa (aba "Fluxo do bot"): até MAX_FLOWS, um em uso.
// O bot lê CompanySettings.botFlow, que é a cópia do fluxo em uso: salvar o
// fluxo em uso ou trocar de fluxo atualiza essa cópia (syncActive).
// Na primeira vez, a empresa recebe dois: "Padrão" (o fluxo que ela já
// tinha, ou o menu padrão), em uso, e "Agendamento pelo link".

export const MAX_FLOWS = 5;

type FlowRow = { id: string; name: string; flow: Prisma.JsonValue; createdAt: Date; updatedAt: Date };
const summary = (row: FlowRow, activeId: string | null) => ({ id: row.id, name: row.name, active: row.id === activeId, updatedAt: row.updatedAt });

const asJson = (flow: FlowNode) => flow as unknown as Prisma.InputJsonValue;

// Fluxo guardado (inválido por alguma mudança de regra: volta ao padrão).
const parse = (row: FlowRow, settings: { greetingMessage: string }) => {
  const parsed = flowSchema.safeParse(row.flow);
  return parsed.success ? parsed.data : templateFlow('padrao', settings);
};

async function ensureFlows(companyId: string): Promise<{ settings: CompanySettings; rows: FlowRow[] }> {
  let settings = await getSettings(companyId);
  let rows = await prisma.botFlow.findMany({ where: { companyId }, orderBy: { createdAt: 'asc' } });
  if (!rows.length) {
    await prisma.$transaction(async (tx) => {
      // Outra requisição criou enquanto isso: usa os dela.
      if (await tx.botFlow.count({ where: { companyId } })) return;
      const padrao = await tx.botFlow.create({ data: { companyId, name: TEMPLATE_NAMES.padrao, flow: asJson(getFlow(settings)) } });
      await tx.botFlow.create({ data: { companyId, name: TEMPLATE_NAMES.link, flow: asJson(templateFlow('link', settings)), createdAt: new Date(padrao.createdAt.getTime() + 1) } });
      await tx.companySettings.update({ where: { companyId }, data: { activeFlowId: padrao.id, botFlow: asJson(getFlow(settings)) } });
    });
    rows = await prisma.botFlow.findMany({ where: { companyId }, orderBy: { createdAt: 'asc' } });
    settings = await getSettings(companyId);
  }
  // Fluxo em uso apagado por fora: o primeiro passa a ser o em uso.
  if (rows.length && !rows.some((r) => r.id === settings.activeFlowId)) {
    await syncActive(companyId, rows[0].id);
    settings = await getSettings(companyId);
  }
  return { settings, rows };
}

// Fluxo em uso -> cópia lida pelo bot. Conversas no meio do fluxo antigo
// podem apontar para etapas que não existem mais: voltam ao início.
async function syncActive(companyId: string, flowId: string) {
  const row = await prisma.botFlow.findFirstOrThrow({ where: { id: flowId, companyId } });
  await prisma.companySettings.update({ where: { companyId }, data: { activeFlowId: row.id, botFlow: row.flow as Prisma.InputJsonValue } });
  await prisma.whatsAppSession.deleteMany({ where: { companyId, step: 'MENU' } });
}

async function requireFlow(companyId: string, id: string) {
  const row = await prisma.botFlow.findFirst({ where: { id, companyId } });
  if (!row) throw HttpError.notFound('Fluxo não encontrado.');
  return row;
}

export async function listFlows(companyId: string) {
  const { settings, rows } = await ensureFlows(companyId);
  return { flows: rows.map((r) => summary(r, settings.activeFlowId)), max: MAX_FLOWS };
}

export async function getFlowById(companyId: string, id: string) {
  const { settings } = await ensureFlows(companyId);
  const row = await requireFlow(companyId, id);
  return { ...summary(row, settings.activeFlowId), flow: parse(row, settings) };
}

// Fluxo em uso (o que o WhatsApp está usando).
export async function getActiveFlow(companyId: string) {
  const { settings } = await ensureFlows(companyId);
  return getFlowById(companyId, settings.activeFlowId!);
}

export async function createFlow(companyId: string, input: { template: FlowTemplate; name?: string }) {
  const { settings, rows } = await ensureFlows(companyId);
  if (rows.length >= MAX_FLOWS) throw HttpError.badRequest(`Você pode ter até ${MAX_FLOWS} fluxos. Apague um para criar outro.`);
  const row = await prisma.botFlow.create({
    data: { companyId, name: input.name?.trim() || TEMPLATE_NAMES[input.template], flow: asJson(templateFlow(input.template, settings)) },
  });
  return { ...summary(row, settings.activeFlowId), flow: parse(row, settings) };
}

export async function saveFlow(companyId: string, id: string, input: { flow?: FlowNode; name?: string }) {
  const { settings } = await ensureFlows(companyId);
  await requireFlow(companyId, id);
  const row = await prisma.botFlow.update({
    where: { id },
    data: { ...(input.flow ? { flow: asJson(input.flow) } : {}), ...(input.name?.trim() ? { name: input.name.trim() } : {}) },
  });
  if (input.flow && id === settings.activeFlowId) await syncActive(companyId, id);
  return { ...summary(row, settings.activeFlowId), flow: parse(row, settings) };
}

export async function activateFlow(companyId: string, id: string) {
  await ensureFlows(companyId);
  await requireFlow(companyId, id);
  await syncActive(companyId, id);
  return listFlows(companyId);
}

export async function deleteFlow(companyId: string, id: string) {
  const { settings } = await ensureFlows(companyId);
  await requireFlow(companyId, id);
  if (id === settings.activeFlowId) throw HttpError.badRequest('Este fluxo está em uso no WhatsApp. Coloque outro em uso antes de apagar.');
  await prisma.botFlow.delete({ where: { id } });
  return listFlows(companyId);
}
