import { randomInt, randomUUID } from 'crypto';
import { Appointment, AppointmentItem, Client, Prisma } from '@prisma/client';
import { isAccountActive } from '../../lib/plans';
import { prisma, runSandboxed } from '../../lib/prisma';
import { getSettings } from '../settings/settings.service';
import { handleIncomingMessage } from './whatsapp.bot';
import { FlowNode } from './whatsapp.flow';

// "Testar conversa" do editor do fluxo com o bot de verdade: mesmo motor do
// WhatsApp, com o fluxo da tela (mesmo sem salvar), o catálogo, os horários
// livres reais da agenda e a IA (se o plano tiver). Cada mensagem roda numa
// transação desfeita no fim (runSandboxed): nada fica gravado e nenhuma
// mensagem é enviada. O que a conversa simulada criou (cliente, etapa do bot,
// horários marcados) fica na memória e é recolocado na próxima mensagem.

type SimAppointment = Appointment & { items: AppointmentItem[] };
type SimState = {
  companyId: string;
  // Número fictício (não começa com 55, para não casar com clientes reais).
  contact: string;
  profileName: string;
  client: Client | null;
  session: { step: string; data: Prisma.JsonValue } | null;
  appointments: SimAppointment[];
  touchedAt: number;
};

const TTL_MS = 60 * 60 * 1000;
const MAX_SIMULATIONS = 500;
const simulations = new Map<string, SimState>();

function cleanup() {
  const now = Date.now();
  for (const [id, sim] of simulations) if (now - sim.touchedAt > TTL_MS) simulations.delete(id);
  while (simulations.size > MAX_SIMULATIONS) simulations.delete(simulations.keys().next().value!);
}

export type SimulateInput = { simId?: string | null; text: string; flow?: FlowNode; profileName?: string };

export async function simulate(companyId: string, input: SimulateInput) {
  cleanup();
  const previous = input.simId ? simulations.get(input.simId) : undefined;
  const state: SimState = previous && previous.companyId === companyId
    ? previous
    : { companyId, contact: `999${randomInt(1_000_000_000, 9_999_999_999)}`, profileName: input.profileName?.trim() || 'Cliente', client: null, session: null, appointments: [], touchedAt: Date.now() };
  const simId = previous && previous.companyId === companyId ? input.simId! : randomUUID();

  const company = await prisma.company.findUniqueOrThrow({ where: { id: companyId }, include: { account: true } });
  if (!isAccountActive(company.account)) {
    return { simId, replies: [], step: null, inactive: true };
  }

  const replies: string[] = [];
  const outcome = await runSandboxed(async () => {
    await getSettings(companyId);
    // Recoloca o que a conversa simulada já tinha criado.
    if (state.client) await prisma.client.create({ data: state.client });
    for (const { items, ...appointment } of state.appointments) {
      await prisma.appointment.create({ data: { ...appointment, items: { create: items.map(({ appointmentId: _a, ...item }) => item) } } });
    }
    if (state.session) {
      await prisma.whatsAppSession.create({ data: { companyId, phone: state.contact, step: state.session.step, data: state.session.data ?? {} } });
    }

    await handleIncomingMessage({
      companyId,
      contactId: state.contact,
      messageId: `sim-${randomUUID()}`,
      text: input.text,
      profileName: state.profileName,
      send: async (text) => { replies.push(text); },
      settingsOverride: { botEnabled: true, ...(input.flow ? { botFlow: input.flow as unknown as Prisma.JsonValue } : {}) },
    });

    // Lê o novo estado antes de desfazer a transação.
    const client = await prisma.client.findFirst({ where: { companyId, whatsappId: state.contact } });
    const session = await prisma.whatsAppSession.findUnique({ where: { companyId_phone: { companyId, phone: state.contact } } });
    const appointments = client ? await prisma.appointment.findMany({ where: { clientId: client.id }, include: { items: true } }) : [];
    return { client, session, appointments };
  });

  simulations.set(simId, {
    ...state,
    client: outcome.client,
    session: outcome.session ? { step: outcome.session.step, data: outcome.session.data } : null,
    appointments: outcome.appointments,
    touchedAt: Date.now(),
  });
  return { simId, replies, step: outcome.session?.step ?? null, inactive: false };
}

export const endSimulation = (simId: string) => simulations.delete(simId);
