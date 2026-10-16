import { CompanySettings, MessageSender } from '@prisma/client';
import { isAccountActive } from '../../lib/plans';
import { schemaState } from '../../lib/schemaGuard';
import { prisma } from '../../lib/prisma';
import { addDays, dateTime, pad, toIsoDate, toMinutes } from '../../lib/time';
import { appointmentInclude, AppointmentWithRelations } from '../appointments/appointments.service';
import { currentSubscription } from '../clientSubscriptions/clientSubscriptions.service';
import { ACTIVE_STATUSES } from '../appointments/availability';
import { endIdleHumanSession, humanSessionEndsAt, logMessage, SendText, sendDayBeforeReminder, sendHourReminder, sendSubscriptionExpired, withContactLock } from './whatsapp.bot';
import { customerWindowOpen, getCloudAccount, HIDDEN_NUMBER_ERROR, sendReminderTemplate, templateApproved } from './whatsapp.cloud';
import { findWhatsAppJid } from './whatsapp.connection';
import { OPT_OUT_HINT, sleep, takeFirstContact } from './whatsapp.safety';
import { bookingLinkFor } from '../booking/booking.service';
import { fillReactivation, REACTIVATION_DAILY_LIMIT, reactivationWhere } from '../reactivation/reactivation.service';
import { isReady, sendText } from './whatsapp.transport';

// Tarefas periódicas do bot:
// - Lembretes dos agendamentos:
//   * véspera: a partir de reminderTime do dia anterior, pedindo confirmação
//     (não vai para horários marcados no mesmo dia do lembrete);
//   * pouco antes: hourReminderMinutes antes do horário.
// - Atendimento pela equipe parado: encerra e devolve o cliente ao bot.
// - Assinaturas de clientes (empresas com clientSubscriptionsEnabled): no dia
//   seguinte ao vencimento, a partir de reminderTime, avisa o cliente que
//   venceu e pede para renovar (uma vez por período, se ele não renovou).

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

// Só avisa vencimentos recentes (não dispara para assinaturas vencidas há muito tempo).
const EXPIRED_NOTICE_DAYS = 7;
let sendingExpiredNotices = false;

export async function sendExpiredSubscriptionNotices(now = new Date()): Promise<number> {
  if (sendingExpiredNotices) return 0;
  sendingExpiredNotices = true;
  let sent = 0;
  try {
    const today = toIsoDate(now);
    const companies = await prisma.companySettings.findMany({
      where: { clientSubscriptionsEnabled: true, whatsappConnected: true, botEnabled: true, company: { active: true } },
      include: { company: { select: { name: true, account: true } } },
    });

    for (const settings of companies) {
      if (`${pad(now.getHours())}:${pad(now.getMinutes())}` < settings.reminderTime) continue;
      if (!(await isReady(settings.companyId)) || !isAccountActive(settings.company.account)) continue;
      const cloudAccount = await getCloudAccount(settings.companyId);
      const candidates = await prisma.clientSubscription.findMany({
        where: {
          companyId: settings.companyId,
          canceledAt: null,
          expiredNoticeAt: null,
          dueDate: { lt: today, gte: toIsoDate(addDays(now, -EXPIRED_NOTICE_DAYS)) },
          client: { whatsappId: { not: null }, whatsappOptOutAt: null },
        },
        include: { client: true },
      });

      for (const candidate of candidates) {
        try {
          let notified = false;
          await withContactLock(settings.companyId, candidate.client.whatsappId!, async () => {
            // Renovou (tem um período mais novo) ou já foi avisado enquanto esperava na fila.
            const current = await currentSubscription(settings.companyId, candidate.clientId, new Date());
            const subscription = await prisma.clientSubscription.findUnique({ where: { id: candidate.id }, include: { client: true } });
            if (!subscription || subscription.expiredNoticeAt || subscription.canceledAt) return;
            if (current?.subscription.id !== subscription.id || !current.expired) {
              await prisma.clientSubscription.update({ where: { id: subscription.id }, data: { expiredNoticeAt: new Date() } });
              return;
            }
            let send: SendText = (text) => sendText(settings.companyId, subscription.client.whatsappId!, text);
            if (cloudAccount) {
              // API oficial: texto livre só dentro da janela de 24 h da última mensagem do cliente.
              if (subscription.client.whatsappId!.includes('@') || !(await customerWindowOpen(settings.companyId, subscription.clientId))) return;
            } else {
              const wrote = await prisma.message.findFirst({ where: { clientId: subscription.clientId, sender: 'CLIENT' }, select: { id: true } });
              if (!wrote) {
                const jid = await findWhatsAppJid(settings.companyId, subscription.client.whatsappId!.replace(/\D/g, ''));
                if (!jid || !takeFirstContact(settings.companyId)) return;
                send = (text) => sendText(settings.companyId, jid, text);
              }
            }
            await sendSubscriptionExpired(settings, settings.company.name, subscription, send);
            notified = true;
            sent += 1;
          });
          if (notified) await sleep(betweenReminders());
        } catch (err) {
          console.error('Falha ao avisar assinatura vencida pelo WhatsApp:', err);
        }
      }
    }
  } finally {
    sendingExpiredNotices = false;
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

// ============ Mensagens agendadas pela equipe ============
// Sai no horário marcado. Se a empresa não puder enviar (WhatsApp
// desconectado, assinatura vencida), tenta de novo a cada minuto e desiste
// depois de SCHEDULED_GIVE_UP_MS, marcando a falha com o motivo.
const SCHEDULED_GIVE_UP_MS = 6 * 60 * 60 * 1000;
let sendingScheduled = false;

export async function sendScheduledMessages(now = new Date()): Promise<number> {
  if (sendingScheduled) return 0;
  sendingScheduled = true;
  let sent = 0;
  try {
    const due = await prisma.scheduledMessage.findMany({
      where: { status: 'PENDING', sendAt: { lte: now } },
      orderBy: { sendAt: 'asc' },
      take: 100,
      include: { client: true, company: { select: { active: true, account: true } } },
    });
    for (const message of due) {
      const fail = (error: string) => prisma.scheduledMessage.update({ where: { id: message.id }, data: { status: 'FAILED', error } });
      const late = now.getTime() - message.sendAt.getTime() > SCHEDULED_GIVE_UP_MS;
      try {
        const { client, companyId } = message;
        if (!message.company.active || !isAccountActive(message.company.account)) {
          if (late) await fail('A assinatura da empresa estava vencida no horário do envio.');
          continue;
        }
        if (!(await isReady(companyId))) {
          if (late) await fail('O WhatsApp estava desconectado no horário do envio.');
          continue;
        }
        if (!client.whatsappId) { await fail('Cliente sem WhatsApp vinculado.'); continue; }
        if (client.whatsappOptOutAt) { await fail('O cliente pediu para não receber mensagens (respondeu PARAR).'); continue; }

        let to = client.whatsappId;
        if (await getCloudAccount(companyId)) {
          if (to.includes('@')) { await fail(HIDDEN_NUMBER_ERROR); continue; }
          if (!(await customerWindowOpen(companyId, client.id))) {
            await fail('Pelo WhatsApp oficial só dá para enviar até 24 horas depois da última mensagem do cliente.');
            continue;
          }
        } else if (!client.lastInboundAt && !to.includes('@')) {
          // Cliente que nunca escreveu: confere o número e respeita o limite diário de primeiros contatos.
          const jid = await findWhatsAppJid(companyId, to.replace(/\D/g, ''));
          if (!jid) { await fail('Esse número não tem WhatsApp.'); continue; }
          if (!takeFirstContact(companyId)) {
            if (late) await fail('Limite diário de mensagens para quem ainda não conversou com a empresa.');
            continue;
          }
          to = jid;
        }

        let delivered = false;
        await withContactLock(companyId, client.whatsappId, async () => {
          const fresh = await prisma.scheduledMessage.findUnique({ where: { id: message.id } });
          if (fresh?.status !== 'PENDING') return;
          // Marca antes de enviar: se o processo cair no meio, não manda duas vezes.
          await prisma.scheduledMessage.update({ where: { id: fresh.id }, data: { status: 'SENT', sentAt: new Date() } });
          try {
            await sendText(companyId, to, fresh.text);
          } catch (err) {
            await fail(`Não foi possível enviar: ${(err as Error).message?.slice(0, 200) ?? 'erro do WhatsApp'}`);
            return;
          }
          await logMessage(companyId, client.id, fresh.text, MessageSender.STAFF, fresh.createdByName);
          delivered = true;
        });
        if (delivered) {
          sent += 1;
          await sleep(betweenReminders());
        }
      } catch (err) {
        console.error('Falha ao enviar mensagem agendada:', err);
      }
    }
  } finally {
    sendingScheduled = false;
  }
  return sent;
}

// ============ Follow-up automático ============
// Para quem parou de responder: a etapa N sai delayMinutes depois da última
// mensagem do cliente, só se a conversa parou do nosso lado (a última
// mensagem foi do bot ou da equipe), sem atendimento da equipe em andamento,
// sem horário marcado e fora da etapa "fechado" do funil. O cliente
// escrevendo de novo recomeça a contagem (logMessage zera followUpStep).
// Etapa atrasada demais (servidor parado, por exemplo) é pulada, não enviada.
const FOLLOW_UP_GRACE_MS = 12 * 60 * 60 * 1000;
const FOLLOW_UPS_PER_COMPANY = 30;
let sendingFollowUps = false;

const fillFollowUp = (text: string, name: string, company: string) =>
  text.replace(/\{nome\}/g, name.split(' ')[0] ?? name).replace(/\{empresa\}/g, company);

export async function sendFollowUps(now = new Date()): Promise<number> {
  if (sendingFollowUps) return 0;
  sendingFollowUps = true;
  let sent = 0;
  try {
    const companies = await prisma.companySettings.findMany({
      where: { followUpEnabled: true, whatsappConnected: true, botEnabled: true, company: { active: true } },
      include: { company: { select: { name: true, account: true, followUpSteps: { orderBy: { position: 'asc' } } } } },
    });
    for (const settings of companies) {
      const { companyId } = settings;
      const steps = settings.company.followUpSteps;
      if (!steps.length || !isAccountActive(settings.company.account) || !(await isReady(companyId))) continue;
      const official = Boolean(await getCloudAccount(companyId));
      const maxDelayMs = steps[steps.length - 1].delayMinutes * 60_000;
      const candidates = await prisma.client.findMany({
        where: {
          companyId,
          whatsappId: { not: null },
          whatsappOptOutAt: null,
          archivedAt: null,
          followUpStep: { lt: steps.length },
          lastInboundAt: { gte: new Date(now.getTime() - maxDelayMs - FOLLOW_UP_GRACE_MS), lte: new Date(now.getTime() - steps[0].delayMinutes * 60_000) },
          OR: [{ stageId: null }, { stage: { won: false } }],
        },
        orderBy: { lastInboundAt: 'asc' },
        take: 200,
      });

      let sentHere = 0;
      for (const candidate of candidates) {
        if (sentHere >= FOLLOW_UPS_PER_COMPANY) break;
        try {
          let delivered = false;
          await withContactLock(companyId, candidate.whatsappId!, async () => {
            const client = await prisma.client.findUnique({ where: { id: candidate.id } });
            if (!client?.lastInboundAt || client.followUpStep !== candidate.followUpStep || client.whatsappOptOutAt || client.archivedAt) return;
            const done = () => prisma.client.update({ where: { id: client.id }, data: { followUpStep: steps.length } });
            // A conversa parou do lado do cliente (ele espera resposta): não é caso de follow-up.
            if (!client.lastMessageAt || client.lastMessageAt.getTime() <= client.lastInboundAt.getTime()) return;
            const elapsed = now.getTime() - client.lastInboundAt.getTime();
            // A etapa mais adiantada que já venceu (as anteriores ficam para trás se atrasaram).
            let index = -1;
            for (let i = client.followUpStep; i < steps.length; i += 1) if (steps[i].delayMinutes * 60_000 <= elapsed) index = i;
            if (index < 0) return;
            if (elapsed - steps[index].delayMinutes * 60_000 > FOLLOW_UP_GRACE_MS) {
              await prisma.client.update({ where: { id: client.id }, data: { followUpStep: index + 1 } });
              return;
            }
            const session = await prisma.whatsAppSession.findUnique({ where: { companyId_phone: { companyId, phone: client.whatsappId! } }, select: { step: true } });
            if (session?.step === 'HUMAN') return;
            const booked = await prisma.appointment.findFirst({
              where: { clientId: client.id, date: { gte: toIsoDate(now) }, status: { in: ACTIVE_STATUSES } },
              select: { id: true },
            });
            if (booked) { await done(); return; }
            // API oficial: texto livre só dentro da janela de 24 h da última mensagem do cliente.
            if (official && (client.whatsappId!.includes('@') || !(await customerWindowOpen(companyId, client.id)))) { await done(); return; }

            const text = fillFollowUp(steps[index].text, client.name, settings.company.name);
            await prisma.client.update({ where: { id: client.id }, data: { followUpStep: index + 1 } });
            await sendText(companyId, client.whatsappId!, text);
            await logMessage(companyId, client.id, text, MessageSender.BOT);
            delivered = true;
          });
          if (delivered) {
            sent += 1;
            sentHere += 1;
            await sleep(betweenReminders());
          }
        } catch (err) {
          console.error('Falha ao enviar follow-up pelo WhatsApp:', err);
        }
      }
    }
  } finally {
    sendingFollowUps = false;
  }
  return sent;
}

// ============ Reativação de clientes ============
// Uma mensagem por empresa por rodada (a cada minuto), até o limite do dia,
// só em dia e hora de atendimento (fora do almoço). Regras de quem recebe em
// reactivation.service.ts.
let sendingReactivations = false;

export async function sendReactivations(now = new Date()): Promise<number> {
  if (sendingReactivations) return 0;
  sendingReactivations = true;
  let sent = 0;
  try {
    const companies = await prisma.companySettings.findMany({
      where: { reactivationEnabled: true, whatsappConnected: true, botEnabled: true, company: { active: true } },
      include: { company: { select: { name: true, account: true } } },
    });
    const minutes = now.getHours() * 60 + now.getMinutes();
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);
    for (const settings of companies) {
      const { companyId } = settings;
      try {
        if (!settings.workDays.includes(now.getDay())) continue;
        if (minutes < toMinutes(settings.openingTime) || minutes >= toMinutes(settings.closingTime) - 30) continue;
        if (settings.lunchEnabled && minutes >= toMinutes(settings.lunchStart) && minutes < toMinutes(settings.lunchEnd)) continue;
        if (!isAccountActive(settings.company.account) || !(await isReady(companyId))) continue;
        // API oficial: texto livre só até 24 h depois da última mensagem do cliente.
        if (await getCloudAccount(companyId)) continue;
        if ((await prisma.client.count({ where: { companyId, reactivatedAt: { gte: startOfDay } } })) >= REACTIVATION_DAILY_LIMIT) continue;

        const candidate = await prisma.client.findFirst({
          where: reactivationWhere(companyId, settings.reactivationDays, now),
          orderBy: { lastInboundAt: 'desc' },
        });
        if (!candidate?.whatsappId) continue;
        await withContactLock(companyId, candidate.whatsappId, async () => {
          // Confere de novo dentro da fila (o cliente pode ter escrito agora).
          const client = await prisma.client.findFirst({ where: { id: candidate.id, ...reactivationWhere(companyId, settings.reactivationDays, now) } });
          if (!client?.whatsappId) return;
          const session = await prisma.whatsAppSession.findUnique({ where: { companyId_phone: { companyId, phone: client.whatsappId } }, select: { step: true } });
          if (session?.step === 'HUMAN') return;
          // Marca antes de enviar: se falhar, não fica tentando o mesmo cliente o dia todo.
          await prisma.client.update({ where: { id: client.id }, data: { reactivatedAt: new Date() } });
          const { url } = await bookingLinkFor(companyId, client.id);
          const text = `${fillReactivation(settings.reactivationMessage, client.name, settings.company.name, url)}\n\n${OPT_OUT_HINT}`;
          await sendText(companyId, client.whatsappId, text);
          await logMessage(companyId, client.id, text, MessageSender.BOT);
          sent += 1;
        });
      } catch (err) {
        console.error('Falha ao enviar reativação pelo WhatsApp:', err);
      }
    }
  } finally {
    sendingReactivations = false;
  }
  return sent;
}

export function startWhatsAppJobs(): void {
  // Banco desatualizado (schemaGuard): não roda, para não encher o log de erros.
  const reminders = () => { if (!schemaState.ok) return; sendDueReminders().catch((err) => console.error('Falha ao verificar lembretes do WhatsApp:', err)); };
  const handoffs = () => { if (!schemaState.ok) return; closeIdleHandoffs().catch((err) => console.error('Falha ao verificar atendimentos do WhatsApp:', err)); };
  const expired = () => { if (!schemaState.ok) return; sendExpiredSubscriptionNotices().catch((err) => console.error('Falha ao verificar assinaturas vencidas:', err)); };
  const scheduled = () => { if (!schemaState.ok) return; sendScheduledMessages().catch((err) => console.error('Falha ao verificar mensagens agendadas:', err)); };
  const followUps = () => { if (!schemaState.ok) return; sendFollowUps().catch((err) => console.error('Falha ao verificar follow-ups:', err)); };
  const reactivations = () => { if (!schemaState.ok) return; sendReactivations().catch((err) => console.error('Falha ao verificar reativações:', err)); };
  // Primeira verificação depois que as conexões tiveram tempo de reabrir.
  setTimeout(() => { reminders(); handoffs(); expired(); scheduled(); followUps(); reactivations(); }, 60_000);
  setInterval(reactivations, CHECK_INTERVAL_MS);
  setInterval(reminders, CHECK_INTERVAL_MS);
  setInterval(handoffs, CHECK_INTERVAL_MS);
  setInterval(expired, CHECK_INTERVAL_MS);
  setInterval(scheduled, CHECK_INTERVAL_MS);
  setInterval(followUps, CHECK_INTERVAL_MS);
}
