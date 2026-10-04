import { CompanySettings } from '@prisma/client';
import { isAccountActive } from '../../lib/plans';
import { prisma } from '../../lib/prisma';
import { addDays, dateTime, pad, toIsoDate } from '../../lib/time';
import { appointmentInclude, AppointmentWithRelations } from '../appointments/appointments.service';
import { ACTIVE_STATUSES } from '../appointments/availability';
import { endIdleHumanSession, humanSessionEndsAt, SendText, sendDayBeforeReminder, sendHourReminder, withContactLock } from './whatsapp.bot';
import { customerWindowOpen, getCloudAccount, sendReminderTemplate, templateApproved } from './whatsapp.cloud';
import { findWhatsAppJid } from './whatsapp.connection';
import { sleep, takeFirstContact } from './whatsapp.safety';
import { isReady, sendText } from './whatsapp.transport';

// Tarefas periódicas do bot:
// - Lembretes dos agendamentos:
//   * véspera: a partir de reminderTime do dia anterior, pedindo confirmação
//     (não vai para horários marcados no mesmo dia do lembrete);
//   * pouco antes: hourReminderMinutes antes do horário.
// - Atendimento pela equipe parado: encerra e devolve o cliente ao bot.

const CHECK_INTERVAL_MS = 60 * 1000;
// Espaço entre um lembrete e outro (sorteado), para não disparar tudo de uma vez.
const betweenReminders = () => 4_000 + Math.random() * 6_000;

type ReminderKind = 'day' | 'hour';

export function dueReminder(a: AppointmentWithRelations, settings: CompanySettings, now = new Date()): ReminderKind | null {
  if (!ACTIVE_STATUSES.includes(a.status) || !a.client.whatsappId || a.client.whatsappOptOutAt) return null;
  const at = dateTime(a.date, a.startTime);
  if (Number.isNaN(at.getTime()) || at <= now) return null;

  if (settings.hourReminderEnabled && !a.hourReminderSentAt) {
    const hourAt = at.getTime() - settings.hourReminderMinutes * 60_000;
    // Marcado já dentro dessa janela: o cliente acabou de agendar.
    if (now.getTime() >= hourAt && a.createdAt.getTime() < hourAt) return 'hour';
  }

  if (settings.reminderEnabled && !a.reminderSentAt && !a.confirmedAt) {
    const tomorrow = toIsoDate(addDays(now, 1));
    const bookedEarlier = toIsoDate(a.createdAt) < toIsoDate(now);
    if (a.date === tomorrow && `${pad(now.getHours())}:${pad(now.getMinutes())}` >= settings.reminderTime && bookedEarlier) return 'day';
  }
  return null;
}

let sendingReminders = false;

export async function sendDueReminders(now = new Date()): Promise<number> {
  if (sendingReminders) return 0;
  sendingReminders = true;
  let sent = 0;
  try {
    const companies = await prisma.companySettings.findMany({
      where: { whatsappConnected: true, botEnabled: true, company: { active: true }, OR: [{ reminderEnabled: true }, { hourReminderEnabled: true }] },
      include: { company: { select: { name: true, account: true } } },
    });

    for (const settings of companies) {
      if (!(await isReady(settings.companyId)) || !isAccountActive(settings.company.account)) continue;
      const cloudAccount = await getCloudAccount(settings.companyId);
      const appointments = await prisma.appointment.findMany({
        where: {
          companyId: settings.companyId,
          status: { in: ACTIVE_STATUSES },
          date: { in: [toIsoDate(now), toIsoDate(addDays(now, 1))] },
          client: { whatsappId: { not: null }, whatsappOptOutAt: null },
          OR: [{ reminderSentAt: null }, { hourReminderSentAt: null }],
        },
        include: appointmentInclude,
      });

      for (const candidate of appointments) {
        if (!dueReminder(candidate, settings, now)) continue;
        try {
          await withContactLock(settings.companyId, candidate.client.whatsappId!, async () => {
            // Pode ter sido remarcado, cancelado ou avisado enquanto esperava na fila.
            const appointment = await prisma.appointment.findUnique({ where: { id: candidate.id }, include: appointmentInclude });
            const kind = appointment && dueReminder(appointment, settings, new Date());
            if (!appointment || !kind) return;
            let send: SendText = (text) => sendText(settings.companyId, appointment.client.whatsappId!, text);
            if (!cloudAccount) {
              // QR Code: cliente que nunca escreveu para a empresa (cadastrado pela
              // equipe) é o envio de maior risco de bloqueio. Confere se o número
              // tem WhatsApp e respeita o limite diário de primeiros contatos.
              const wrote = await prisma.message.findFirst({ where: { clientId: appointment.clientId, sender: 'CLIENT' }, select: { id: true } });
              if (!wrote) {
                const jid = await findWhatsAppJid(settings.companyId, appointment.client.whatsappId!.replace(/\D/g, ''));
                if (!jid || !takeFirstContact(settings.companyId)) return;
                send = (text) => sendText(settings.companyId, jid, text);
              }
            }
            // API oficial: sem conversa nas últimas 24 h, o lembrete só sai como
            // template aprovado. Ainda em análise na Meta: tenta de novo no próximo ciclo.
            // Cliente da conexão antiga sem número visível (@lid): a API oficial não alcança.
            if (cloudAccount && appointment.client.whatsappId!.includes('@')) return;
            if (cloudAccount && !(await customerWindowOpen(settings.companyId, appointment.clientId))) {
              if (!templateApproved(cloudAccount, kind)) return;
              send = () => sendReminderTemplate(settings.companyId, kind, appointment, settings.company.name);
            }
            if (kind === 'hour') await sendHourReminder(settings, settings.company.name, appointment, send);
            else await sendDayBeforeReminder(settings, settings.company.name, appointment, send);
            sent += 1;
          });
        } catch (err) {
          console.error('Falha ao enviar lembrete do WhatsApp:', err);
        }
        await sleep(betweenReminders());
      }
    }
  } finally {
    sendingReminders = false;
  }
  return sent;
}

let closingHandoffs = false;

export async function closeIdleHandoffs(): Promise<number> {
  if (closingHandoffs) return 0;
  closingHandoffs = true;
  let ended = 0;
  try {
    const sessions = await prisma.whatsAppSession.findMany({
      where: { step: 'HUMAN', company: { settings: { is: { whatsappConnected: true, botEnabled: true } } } },
      include: { company: { select: { settings: true } } },
    });
    for (const session of sessions) {
      const settings = session.company.settings;
      if (!settings || !(await isReady(session.companyId))) continue;
      if (humanSessionEndsAt(session, settings).endsAt.getTime() > Date.now()) continue;
      try {
        if (await endIdleHumanSession(session.companyId, session.phone, (text) => sendText(session.companyId, session.phone, text))) ended += 1;
      } catch (err) {
        console.error('Falha ao encerrar atendimento do WhatsApp:', err);
      }
    }
  } finally {
    closingHandoffs = false;
  }
  return ended;
}

export function startWhatsAppJobs(): void {
  const reminders = () => { sendDueReminders().catch((err) => console.error('Falha ao verificar lembretes do WhatsApp:', err)); };
  const handoffs = () => { closeIdleHandoffs().catch((err) => console.error('Falha ao verificar atendimentos do WhatsApp:', err)); };
  // Primeira verificação depois que as conexões tiveram tempo de reabrir.
  setTimeout(() => { reminders(); handoffs(); }, 60_000);
  setInterval(reminders, CHECK_INTERVAL_MS);
  setInterval(handoffs, CHECK_INTERVAL_MS);
}
