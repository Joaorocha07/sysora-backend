import webpush from 'web-push';
import { env } from '../config/env';
import { prisma } from './prisma';

// Notificações no navegador/celular (Web Push). Cada aparelho que ativou as
// notificações vira um PushSubscription do usuário; avisamos todos os
// usuários ativos da empresa. scope 'handoff' = só quando o cliente está com
// a equipe (pediu atendente ou a equipe já respondeu).

export const pushEnabled = () => Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);

let configured = false;
function configure() {
  if (configured || !pushEnabled()) return;
  webpush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY!, env.VAPID_PRIVATE_KEY!);
  configured = true;
}

export type PushPayload = { title: string; body: string; url: string; tag?: string };

async function deliver(companyId: string, payload: PushPayload, handoff: boolean) {
  configure();
  const subscriptions = await prisma.pushSubscription.findMany({
    where: {
      ...(handoff ? {} : { scope: 'all' }),
      user: { active: true, memberships: { some: { companyId, active: true, status: 'ACTIVE' } } },
    },
  });
  const body = JSON.stringify(payload);
  await Promise.all(subscriptions.map(async (s) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body, { TTL: 3600 });
    } catch (err) {
      // Aparelho desinstalou ou revogou a permissão: a inscrição não volta mais.
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) await prisma.pushSubscription.delete({ where: { id: s.id } }).catch(() => {});
      else console.error('Falha ao enviar notificação:', (err as Error).message);
    }
  }));
}

// Mensagem nova de cliente. Nunca derruba quem chamou (é só um aviso).
export function notifyClientMessage(companyId: string, clientId: string) {
  if (!pushEnabled()) return;
  void (async () => {
    const client = await prisma.client.findUnique({ where: { id: clientId }, select: { name: true, whatsappId: true } });
    if (!client) return;
    const last = await prisma.message.findFirst({ where: { clientId, sender: 'CLIENT' }, orderBy: { createdAt: 'desc' }, select: { text: true } });
    const session = client.whatsappId
      ? await prisma.whatsAppSession.findUnique({ where: { companyId_phone: { companyId, phone: client.whatsappId } }, select: { step: true } })
      : null;
    await deliver(companyId, {
      title: client.name,
      body: (last?.text ?? 'Nova mensagem').slice(0, 160),
      url: `/conversas?cliente=${clientId}`,
      tag: clientId,
    }, session?.step === 'HUMAN');
  })().catch((err) => console.error('Falha ao preparar notificação:', err));
}

// O cliente pediu para falar com a equipe: avisa também quem só quer esses casos.
export function notifyHandoff(companyId: string, clientId: string) {
  if (!pushEnabled()) return;
  void (async () => {
    const client = await prisma.client.findUnique({ where: { id: clientId }, select: { name: true } });
    if (!client) return;
    await deliver(companyId, {
      title: `${client.name} quer falar com a equipe`,
      body: 'Abra a conversa para responder.',
      url: `/conversas?cliente=${clientId}`,
      tag: clientId,
    }, true);
  })().catch((err) => console.error('Falha ao preparar notificação:', err));
}

export async function sendTestPush(subscriptionId: string) {
  configure();
  const s = await prisma.pushSubscription.findUnique({ where: { id: subscriptionId } });
  if (!s) return;
  await webpush.sendNotification(
    { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
    JSON.stringify({ title: 'Notificações ligadas', body: 'Você vai ser avisado quando chegar mensagem de cliente.', url: '/conversas' }),
  );
}
