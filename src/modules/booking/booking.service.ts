import crypto from 'crypto';
import { ServiceKind, Source } from '@prisma/client';
import { env } from '../../config/env';
import { HttpError } from '../../lib/httpError';
import { isAccountActive } from '../../lib/plans';
import { prisma } from '../../lib/prisma';
import { toIsoDate } from '../../lib/time';
import * as appointmentsService from '../appointments/appointments.service';
import { ACTIVE_STATUSES, freeTimes, isTimeFree, nextFreeDays } from '../appointments/availability';
import { getSettings } from '../settings/settings.service';

// Link pessoal de agendamento: o bot manda (função 'link' do fluxo) e o cliente
// escolhe serviço, dia e horário na página pública /agendar/[token], que já
// sabe quem ele é. Os horários seguem as mesmas regras do bot (availability.ts).

const LINK_DAYS = 7;
// Um link novo é gerado quando o atual vence em menos que isso.
const REUSE_MIN_MS = 24 * 60 * 60 * 1000;
const DAYS_SHOWN = 14;
// Contra abuso: horários futuros que um cliente pode ter marcados pelo link.
const MAX_OPEN_APPOINTMENTS = 3;

const siteUrl = () => (env.APP_URL || env.CORS_ORIGIN.split(',')[0].trim()).replace(/\/+$/, '');

// Link do cliente (reaproveita o atual enquanto faltar mais de 1 dia para vencer).
export const receiptUrl = (token: string) => `${siteUrl()}/comprovante/${token}`;

export async function bookingLinkFor(companyId: string, clientId: string, now = new Date()): Promise<{ url: string; expiresAt: Date }> {
  const existing = await prisma.bookingLink.findFirst({
    where: { companyId, clientId, expiresAt: { gt: new Date(now.getTime() + REUSE_MIN_MS) } },
    orderBy: { expiresAt: 'desc' },
  });
  const link = existing ?? await prisma.bookingLink.create({
    data: { token: crypto.randomBytes(9).toString('base64url'), companyId, clientId, expiresAt: new Date(now.getTime() + LINK_DAYS * 86_400_000) },
  });
  return { url: `${siteUrl()}/agendar/${link.token}`, expiresAt: link.expiresAt };
}

// Link válido, da empresa ativa com o plano em dia.
async function resolve(token: string) {
  const link = await prisma.bookingLink.findUnique({
    where: { token },
    include: { client: true, company: { include: { account: true } } },
  });
  if (!link) throw HttpError.notFound('Link de agendamento não encontrado. Peça um novo pelo WhatsApp.');
  if (link.expiresAt < new Date()) throw new HttpError(410, 'LINK_EXPIRED', 'Este link de agendamento expirou. Peça um novo pelo WhatsApp.');
  if (!link.company.active || !isAccountActive(link.company.account)) throw HttpError.forbidden('O agendamento on-line desta empresa está indisponível no momento.');
  return { ...link, settings: await getSettings(link.companyId) };
}

const isPlaceholder = (name: string) => !name.trim() || name.startsWith('Cliente WhatsApp');

async function bookableServices(companyId: string, serviceIds?: string[]) {
  const services = await prisma.service.findMany({
    where: { companyId, active: true, kind: ServiceKind.SERVICE, ...(serviceIds ? { id: { in: serviceIds } } : {}) },
    orderBy: [{ position: 'asc' }, { name: 'asc' }],
  });
  if (serviceIds && (!serviceIds.length || services.length !== new Set(serviceIds).size)) throw HttpError.badRequest('Escolha os serviços novamente.');
  return services;
}
const durationOf = (services: { durationMinutes: number }[]) => services.reduce((sum, s) => sum + s.durationMinutes, 0);

// Dados da página: empresa, cliente e serviços.
export async function getBooking(token: string) {
  const link = await resolve(token);
  const { settings } = link;
  const services = await bookableServices(link.companyId);
  return {
    company: { name: link.company.name, phone: link.company.phone, address: link.company.address },
    client: { name: isPlaceholder(link.client.name) ? null : link.client.name, phone: link.client.phone },
    services: services.map((s) => ({ id: s.id, name: s.name, description: s.description, durationMinutes: s.durationMinutes, priceCents: s.priceCents })),
    hours: { openingTime: settings.openingTime, closingTime: settings.closingTime, workDays: settings.workDays },
    expiresAt: link.expiresAt,
  };
}

export async function getDays(token: string, serviceIds: string[]) {
  const link = await resolve(token);
  const services = await bookableServices(link.companyId, serviceIds);
  return nextFreeDays(link.companyId, link.settings, DAYS_SHOWN, durationOf(services));
}

export async function getTimes(token: string, serviceIds: string[], date: string) {
  const link = await resolve(token);
  const services = await bookableServices(link.companyId, serviceIds);
  return freeTimes(link.companyId, link.settings, date, durationOf(services));
}

export async function book(token: string, input: { serviceIds: string[]; date: string; time: string; name?: string }) {
  const link = await resolve(token);
  const services = await bookableServices(link.companyId, input.serviceIds);
  if (!(await isTimeFree(link.companyId, link.settings, input.date, input.time, durationOf(services)))) {
    throw HttpError.conflict('Esse horário não está mais disponível. Escolha outro.');
  }
  const open = await prisma.appointment.count({
    where: { companyId: link.companyId, clientId: link.clientId, status: { in: ACTIVE_STATUSES }, date: { gte: toIsoDate(new Date()) } },
  });
  if (open >= MAX_OPEN_APPOINTMENTS) throw HttpError.conflict('Você já tem horários marcados. Para marcar outro, fale com a empresa pelo WhatsApp.');

  // Cliente ainda sem nome (só o do WhatsApp): usa o que ele digitou na página.
  const name = input.name?.trim();
  if (name && isPlaceholder(link.client.name)) await prisma.client.update({ where: { id: link.clientId }, data: { name } });

  const created = await appointmentsService.createAppointment(link.companyId, {
    clientId: link.clientId,
    serviceIds: services.map((s) => s.id),
    date: input.date,
    startTime: input.time,
    notes: 'Agendado pelo link do WhatsApp.',
    ignoreConflicts: true,
  }, Source.BOT);
  // Comprovante: link público só com os dados deste agendamento.
  const appointment = await prisma.appointment.update({
    where: { id: created.id },
    data: { receiptToken: crypto.randomBytes(9).toString('base64url') },
    include: appointmentsService.appointmentInclude,
  });
  return { appointment, settings: link.settings, company: { name: link.company.name, address: link.company.address } };
}

// Página do comprovante: empresa, cliente, serviços, data, valor e situação.
export async function getReceipt(token: string) {
  const appointment = await prisma.appointment.findUnique({
    where: { receiptToken: token },
    include: { items: true, client: true, company: true },
  });
  if (!appointment) throw HttpError.notFound('Comprovante não encontrado.');
  const { company, client } = appointment;
  return {
    code: appointment.id.slice(0, 8).toUpperCase(),
    status: appointment.status,
    date: appointment.date,
    startTime: appointment.startTime,
    endTime: appointment.endTime,
    totalCents: appointment.totalCents,
    items: appointment.items.map((i) => ({ name: i.name, durationMinutes: i.durationMinutes, priceCents: i.priceCents })),
    client: { name: isPlaceholder(client.name) ? null : client.name, phone: client.phone },
    company: { name: company.name, phone: company.phone, address: company.address },
    createdAt: appointment.createdAt,
  };
}
