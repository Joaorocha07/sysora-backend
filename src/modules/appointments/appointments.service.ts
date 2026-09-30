import { AppointmentStatus, Prisma, Source } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { HttpError } from '../../lib/httpError';
import { dateTime, fromMinutes, toMinutes } from '../../lib/time';
import { getSettings } from '../settings/settings.service';
import { ACTIVE_STATUSES, hasCapacity } from './availability';

export const appointmentInclude = {
  items: true,
  client: { select: { id: true, name: true, phone: true, whatsappId: true } },
  staff: { select: { id: true, name: true } },
} satisfies Prisma.AppointmentInclude;

export type AppointmentWithRelations = Prisma.AppointmentGetPayload<{ include: typeof appointmentInclude }>;

async function findOwned(companyId: string, appointmentId: string) {
  const appointment = await prisma.appointment.findFirst({ where: { id: appointmentId, companyId }, include: appointmentInclude });
  if (!appointment) throw HttpError.notFound('Agendamento não encontrado.');
  return appointment;
}

export async function getAppointment(companyId: string, appointmentId: string) {
  return findOwned(companyId, appointmentId);
}

export async function listAppointments(companyId: string, filters: { from?: string; to?: string; status?: AppointmentStatus; clientId?: string; staffId?: string }) {
  return prisma.appointment.findMany({
    where: {
      companyId,
      status: filters.status,
      clientId: filters.clientId,
      staffId: filters.staffId,
      date: { gte: filters.from, lte: filters.to },
    },
    include: appointmentInclude,
    orderBy: [{ date: 'asc' }, { startTime: 'asc' }],
  });
}

// Serviços escolhidos (na ordem pedida) com a duração e o preço atuais.
export async function resolveServices(companyId: string, serviceIds: string[]) {
  const ids = [...new Set(serviceIds)];
  const services = await prisma.service.findMany({ where: { companyId, id: { in: ids } } });
  if (services.length !== ids.length) throw HttpError.badRequest('Um ou mais serviços não foram encontrados.');
  return ids.map((id) => services.find((s) => s.id === id)!);
}

type Services = Awaited<ReturnType<typeof resolveServices>>;
const totalDuration = (services: Services) => services.reduce((sum, s) => sum + s.durationMinutes, 0);

async function assertStaff(companyId: string, staffId: string | null | undefined) {
  if (!staffId) return;
  const member = await prisma.companyMembership.findFirst({ where: { companyId, userId: staffId, active: true, status: 'ACTIVE' } });
  if (!member) throw HttpError.badRequest('Profissional não encontrado na equipe.');
}

function assertFuture(date: string, time: string) {
  const at = dateTime(date, time);
  if (Number.isNaN(at.getTime()) || at.getTime() < Date.now()) {
    throw HttpError.badRequest('Não é possível agendar em uma data e horário que já passaram.');
  }
}

export type CreateAppointmentInput = {
  clientId: string;
  serviceIds: string[];
  date: string;
  startTime: string;
  staffId?: string | null;
  notes?: string | null;
  // Equipe marcando mesmo com a agenda cheia naquele horário.
  ignoreConflicts?: boolean;
};

export async function createAppointment(companyId: string, input: CreateAppointmentInput, source: Source = Source.STAFF) {
  const client = await prisma.client.findFirst({ where: { id: input.clientId, companyId } });
  if (!client) throw HttpError.notFound('Cliente não encontrado.');
  assertFuture(input.date, input.startTime);
  await assertStaff(companyId, input.staffId);

  const services = await resolveServices(companyId, input.serviceIds);
  const duration = totalDuration(services);
  if (!input.ignoreConflicts) {
    const settings = await getSettings(companyId);
    if (!(await hasCapacity(companyId, settings, input.date, input.startTime, duration))) {
      throw HttpError.conflict('Já existe agendamento nesse horário e a agenda está no limite de atendimentos simultâneos.');
    }
  }

  return prisma.appointment.create({
    data: {
      companyId,
      clientId: client.id,
      staffId: input.staffId || null,
      date: input.date,
      startTime: input.startTime,
      endTime: fromMinutes(toMinutes(input.startTime) + duration),
      notes: input.notes || null,
      source,
      totalCents: services.reduce((sum, s) => sum + s.priceCents, 0),
      items: {
        create: services.map((s) => ({ serviceId: s.id, name: s.name, durationMinutes: s.durationMinutes, priceCents: s.priceCents })),
      },
    },
    include: appointmentInclude,
  });
}

export type UpdateAppointmentInput = Partial<Omit<CreateAppointmentInput, 'clientId'>>;

// Remarcação e edição. Data/horário novos zeram lembretes e confirmação.
export async function updateAppointment(companyId: string, appointmentId: string, input: UpdateAppointmentInput) {
  const current = await findOwned(companyId, appointmentId);
  if (!ACTIVE_STATUSES.includes(current.status)) throw HttpError.badRequest('Só é possível alterar agendamentos ativos.');
  await assertStaff(companyId, input.staffId);

  const date = input.date ?? current.date;
  const startTime = input.startTime ?? current.startTime;
  const moved = date !== current.date || startTime !== current.startTime;
  if (moved) assertFuture(date, startTime);

  const services = input.serviceIds ? await resolveServices(companyId, input.serviceIds) : null;
  const duration = services ? totalDuration(services) : current.items.reduce((sum, i) => sum + i.durationMinutes, 0);

  if ((moved || services) && !input.ignoreConflicts) {
    const settings = await getSettings(companyId);
    if (!(await hasCapacity(companyId, settings, date, startTime, duration, current.id))) {
      throw HttpError.conflict('Já existe agendamento nesse horário e a agenda está no limite de atendimentos simultâneos.');
    }
  }

  return prisma.appointment.update({
    where: { id: current.id },
    data: {
      date,
      startTime,
      endTime: fromMinutes(toMinutes(startTime) + duration),
      staffId: input.staffId === undefined ? undefined : input.staffId || null,
      notes: input.notes === undefined ? undefined : input.notes || null,
      ...(moved ? { status: AppointmentStatus.SCHEDULED, reminderSentAt: null, hourReminderSentAt: null, confirmedAt: null } : {}),
      ...(services
        ? {
            totalCents: services.reduce((sum, s) => sum + s.priceCents, 0),
            items: {
              deleteMany: {},
              create: services.map((s) => ({ serviceId: s.id, name: s.name, durationMinutes: s.durationMinutes, priceCents: s.priceCents })),
            },
          }
        : {}),
    },
    include: appointmentInclude,
  });
}

export async function setStatus(companyId: string, appointmentId: string, status: AppointmentStatus) {
  const current = await findOwned(companyId, appointmentId);
  return prisma.appointment.update({
    where: { id: current.id },
    data: {
      status,
      confirmedAt: status === AppointmentStatus.CONFIRMED ? new Date() : status === AppointmentStatus.SCHEDULED ? null : undefined,
      canceledAt: status === AppointmentStatus.CANCELED ? new Date() : null,
    },
    include: appointmentInclude,
  });
}

export async function deleteAppointment(companyId: string, appointmentId: string) {
  const current = await findOwned(companyId, appointmentId);
  await prisma.appointment.delete({ where: { id: current.id } });
}

// Próximo horário ativo do cliente (usado pelo bot).
export async function nextAppointmentOf(companyId: string, clientId: string) {
  const appointments = await prisma.appointment.findMany({
    where: { companyId, clientId, status: { in: ACTIVE_STATUSES } },
    include: appointmentInclude,
    orderBy: [{ date: 'asc' }, { startTime: 'asc' }],
  });
  return appointments.find((a) => dateTime(a.date, a.startTime).getTime() > Date.now()) ?? null;
}
