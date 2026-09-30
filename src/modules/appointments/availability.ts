import { AppointmentStatus, CompanySettings } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { addDays, fromMinutes, nowMinutes, toIsoDate, toMinutes, weekdayOf } from '../../lib/time';

// Horários livres da agenda (usado pelo bot e pela tela de agendamento).
// Os inícios seguem uma grade de slotMinutes a partir da abertura. Um horário
// está livre quando o atendimento inteiro cabe antes do fechamento, não
// encosta no almoço e não se sobrepõe a slotCapacity agendamentos ativos.

export type AgendaSettings = Pick<CompanySettings,
  'openingTime' | 'closingTime' | 'workDays' | 'slotMinutes' | 'slotCapacity' | 'lunchEnabled' | 'lunchStart' | 'lunchEnd'>;

// Antecedência mínima para marcar no mesmo dia.
const MIN_NOTICE_MINUTES = 30;
export const ACTIVE_STATUSES: AppointmentStatus[] = [AppointmentStatus.SCHEDULED, AppointmentStatus.CONFIRMED];

type Busy = { start: number; end: number };

async function loadBusy(companyId: string, from: string, to: string, excludeAppointmentId?: string | null) {
  const appointments = await prisma.appointment.findMany({
    where: {
      companyId,
      status: { in: ACTIVE_STATUSES },
      date: { gte: from, lte: to },
      ...(excludeAppointmentId ? { id: { not: excludeAppointmentId } } : {}),
    },
    select: { date: true, startTime: true, endTime: true },
  });
  const busy = new Map<string, Busy[]>();
  for (const a of appointments) {
    busy.set(a.date, [...(busy.get(a.date) ?? []), { start: toMinutes(a.startTime), end: toMinutes(a.endTime) }]);
  }
  return busy;
}

const overlaps = (aStart: number, aEnd: number, bStart: number, bEnd: number) => aStart < bEnd && bStart < aEnd;

function fits(settings: AgendaSettings, busy: Busy[], start: number, duration: number): boolean {
  const end = start + duration;
  if (start < toMinutes(settings.openingTime) || end > toMinutes(settings.closingTime)) return false;
  if (settings.lunchEnabled && overlaps(start, end, toMinutes(settings.lunchStart), toMinutes(settings.lunchEnd))) return false;
  return busy.filter((b) => overlaps(start, end, b.start, b.end)).length < settings.slotCapacity;
}

function candidateStarts(settings: AgendaSettings, date: string, now: Date): number[] {
  const today = toIsoDate(now);
  if (date < today || !settings.workDays.includes(weekdayOf(date))) return [];
  const closing = toMinutes(settings.closingTime);
  const starts = new Set<number>();
  for (let t = toMinutes(settings.openingTime); t < closing; t += settings.slotMinutes) starts.add(t);
  // Depois do almoço a grade recomeça no fim dele (almoço até 13:30 -> 13:30, 14:00...).
  if (settings.lunchEnabled) for (let t = toMinutes(settings.lunchEnd); t < closing; t += settings.slotMinutes) starts.add(t);
  const sorted = [...starts].sort((a, b) => a - b);
  if (date !== today) return sorted;
  return sorted.filter((t) => t >= nowMinutes(now) + MIN_NOTICE_MINUTES);
}

// Próximos dias de atendimento com pelo menos um horário livre para `duration` minutos.
export async function nextFreeDays(companyId: string, settings: AgendaSettings, count: number, duration: number, excludeAppointmentId?: string | null, horizonDays = 45) {
  const now = new Date();
  const busy = await loadBusy(companyId, toIsoDate(now), toIsoDate(addDays(now, horizonDays)), excludeAppointmentId);
  const days: string[] = [];
  for (let i = 0; i <= horizonDays && days.length < count; i++) {
    const date = toIsoDate(addDays(now, i));
    const dayBusy = busy.get(date) ?? [];
    if (candidateStarts(settings, date, now).some((t) => fits(settings, dayBusy, t, duration))) days.push(date);
  }
  return days;
}

export async function freeTimes(companyId: string, settings: AgendaSettings, date: string, duration: number, excludeAppointmentId?: string | null) {
  const busy = (await loadBusy(companyId, date, date, excludeAppointmentId)).get(date) ?? [];
  return candidateStarts(settings, date, new Date()).filter((t) => fits(settings, busy, t, duration)).map(fromMinutes);
}

// Horário qualquer (pode estar fora da grade, ex.: 14:10).
export async function isTimeFree(companyId: string, settings: AgendaSettings, date: string, time: string, duration: number, excludeAppointmentId?: string | null) {
  const now = new Date();
  if (date < toIsoDate(now) || !settings.workDays.includes(weekdayOf(date))) return false;
  if (date === toIsoDate(now) && toMinutes(time) < nowMinutes(now) + MIN_NOTICE_MINUTES) return false;
  const busy = (await loadBusy(companyId, date, date, excludeAppointmentId)).get(date) ?? [];
  return fits(settings, busy, toMinutes(time), duration);
}

// Conflito para marcações feitas pela equipe: só a capacidade simultânea
// (a equipe pode marcar fora do horário de funcionamento, se quiser).
export async function hasCapacity(companyId: string, settings: AgendaSettings, date: string, time: string, duration: number, excludeAppointmentId?: string | null) {
  const busy = (await loadBusy(companyId, date, date, excludeAppointmentId)).get(date) ?? [];
  const start = toMinutes(time);
  return busy.filter((b) => overlaps(start, start + duration, b.start, b.end)).length < settings.slotCapacity;
}
