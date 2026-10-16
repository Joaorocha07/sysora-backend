// Teste dos envios automáticos novos (mensagens agendadas e follow-up) sem
// WhatsApp de verdade: o envio é trocado por uma função que só registra.
// Uso (banco LOCAL): DATABASE_URL=... DIRECT_URL=... npx ts-node --transpile-only scripts/jobs-crm-test.ts
import * as transport from '../src/modules/whatsapp/whatsapp.transport';
import * as cloud from '../src/modules/whatsapp/whatsapp.cloud';
import * as safety from '../src/modules/whatsapp/whatsapp.safety';
import { prisma } from '../src/lib/prisma';

if (!/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL ?? '')) throw new Error('Rode só contra o banco local.');

const sent: { to: string; text: string }[] = [];
const t = transport as unknown as Record<string, unknown>;
t.isReady = async () => true;
t.sendText = async (_companyId: string, to: string, text: string) => { sent.push({ to, text }); };
(cloud as unknown as Record<string, unknown>).getCloudAccount = async () => null;
(safety as unknown as Record<string, unknown>).sleep = async () => {};

let failures = 0;
const check = (label: string, ok: boolean, extra = '') => { console.log(`${ok ? 'OK  ' : 'FALHA'} ${label}${extra ? ` — ${extra}` : ''}`); if (!ok) failures += 1; };

async function main() {
  const { sendFollowUps, sendScheduledMessages } = await import('../src/modules/whatsapp/whatsapp.jobs');
  const company = await prisma.company.findFirstOrThrow({ where: { name: 'Empresa Demo' } });
  await prisma.companySettings.update({ where: { companyId: company.id }, data: { whatsappConnected: true, botEnabled: true, followUpEnabled: true } });
  await prisma.followUpStep.deleteMany({ where: { companyId: company.id } });
  await prisma.followUpStep.createMany({ data: [
    { companyId: company.id, position: 0, delayMinutes: 120, text: 'Oi {nome}, ficou alguma dúvida? ({empresa})' },
    { companyId: company.id, position: 1, delayMinutes: 1440, text: 'Ainda tem interesse, {nome}?' },
  ] });
  const [c1, c2, c3] = await Promise.all([1, 2, 3].map((i) => prisma.client.findFirstOrThrow({ where: { companyId: company.id, name: `Teste CRM ${i}` } })));
  const ago = (min: number) => new Date(Date.now() - min * 60_000);

  // c1: cliente escreveu há 3h e a equipe respondeu depois -> etapa 1.
  // c2: cliente escreveu há 30h e ninguém respondeu -> não manda (é a vez da empresa).
  // c3: cliente escreveu há 20 min -> cedo demais.
  await prisma.client.update({ where: { id: c1.id }, data: { lastInboundAt: ago(180), lastMessageAt: ago(170), followUpStep: 0, archivedAt: null, whatsappOptOutAt: null, stageId: null } });
  await prisma.client.update({ where: { id: c2.id }, data: { lastInboundAt: ago(1800), lastMessageAt: ago(1800), followUpStep: 0, archivedAt: null, stageId: null } });
  await prisma.client.update({ where: { id: c3.id }, data: { lastInboundAt: ago(20), lastMessageAt: ago(19), followUpStep: 0, archivedAt: null, stageId: null } });
  await prisma.whatsAppSession.deleteMany({ where: { companyId: company.id } });
  await prisma.appointment.deleteMany({ where: { clientId: { in: [c1.id, c2.id, c3.id] } } });

  sent.length = 0;
  let n = await sendFollowUps();
  check('follow-up: só o cliente certo', n === 1 && sent[0]?.to === c1.whatsappId, JSON.stringify(sent));
  check('follow-up: troca {nome} e {empresa}', sent[0]?.text === `Oi ${c1.name.split(' ')[0]}, ficou alguma dúvida? (${company.name})`, sent[0]?.text);
  const after = await prisma.client.findUniqueOrThrow({ where: { id: c1.id } });
  check('follow-up: avança a etapa e registra a mensagem', after.followUpStep === 1 && Boolean(await prisma.message.findFirst({ where: { clientId: c1.id, sender: 'BOT', text: sent[0]?.text } })));
  sent.length = 0;
  n = await sendFollowUps();
  check('follow-up: não repete a mesma etapa', n === 0);

  // Etapa 2 (24 h): já passou, com folga de 12 h.
  await prisma.client.update({ where: { id: c1.id }, data: { lastInboundAt: ago(1500), lastMessageAt: ago(1400) } });
  n = await sendFollowUps();
  check('follow-up: manda a etapa 2', n === 1 && sent[0]?.text.startsWith('Ainda tem interesse'));
  // 20 h sem resposta: a etapa 1 (2 h) venceu há mais de 12 h e a 2 (24 h) ainda não chegou -> pula a 1 sem mandar.
  await prisma.client.update({ where: { id: c3.id }, data: { lastInboundAt: ago(60 * 20), lastMessageAt: ago(60 * 19), followUpStep: 0 } });
  sent.length = 0;
  n = await sendFollowUps();
  const c3after = await prisma.client.findUniqueOrThrow({ where: { id: c3.id } });
  check('follow-up: etapa vencida há muito tempo é pulada', n === 0 && c3after.followUpStep === 1, `step=${c3after.followUpStep}`);
  // 40 h: fora da janela de todas as etapas, nunca manda.
  await prisma.client.update({ where: { id: c3.id }, data: { lastInboundAt: ago(60 * 40), lastMessageAt: ago(60 * 39), followUpStep: 0 } });
  n = await sendFollowUps();
  check('follow-up: conversa parada há muito tempo não recebe', n === 0);
  // Atendimento com a equipe e etapa "fechado" bloqueiam.
  await prisma.client.update({ where: { id: c3.id }, data: { lastInboundAt: ago(180), lastMessageAt: ago(170), followUpStep: 0 } });
  await prisma.whatsAppSession.create({ data: { companyId: company.id, phone: c3.whatsappId!, step: 'HUMAN', data: {} } });
  n = await sendFollowUps();
  check('follow-up: não manda com a equipe atendendo', n === 0);
  await prisma.whatsAppSession.deleteMany({ where: { companyId: company.id } });
  const won = await prisma.pipelineStage.findFirst({ where: { companyId: company.id, won: true } });
  await prisma.client.update({ where: { id: c3.id }, data: { stageId: won!.id } });
  n = await sendFollowUps();
  check('follow-up: não manda para venda fechada', n === 0);

  // Mensagens agendadas
  await prisma.scheduledMessage.deleteMany({ where: { companyId: company.id } });
  const due = await prisma.scheduledMessage.create({ data: { companyId: company.id, clientId: c1.id, text: 'Agendada vencida', sendAt: ago(1), createdByName: 'Admin Demo' } });
  const future = await prisma.scheduledMessage.create({ data: { companyId: company.id, clientId: c1.id, text: 'Agendada futura', sendAt: new Date(Date.now() + 3600_000), createdByName: 'Admin Demo' } });
  await prisma.client.update({ where: { id: c2.id }, data: { whatsappOptOutAt: new Date() } });
  const optOut = await prisma.scheduledMessage.create({ data: { companyId: company.id, clientId: c2.id, text: 'Para quem pediu PARAR', sendAt: ago(1), createdByName: 'Admin Demo' } });
  sent.length = 0;
  n = await sendScheduledMessages();
  const [d1, d2, d3] = await Promise.all([due, future, optOut].map((m) => prisma.scheduledMessage.findUniqueOrThrow({ where: { id: m.id } })));
  check('agendada: envia a vencida', n === 1 && sent[0]?.text === 'Agendada vencida' && d1.status === 'SENT' && Boolean(d1.sentAt));
  check('agendada: futura continua pendente', d2.status === 'PENDING');
  check('agendada: respeita PARAR', d3.status === 'FAILED' && Boolean(d3.error), d3.error ?? '');
  check('agendada: entra na conversa como da equipe', Boolean(await prisma.message.findFirst({ where: { clientId: c1.id, sender: 'STAFF', staffName: 'Admin Demo', text: 'Agendada vencida' } })));
  n = await sendScheduledMessages();
  check('agendada: não envia duas vezes', n === 0);

  // Limpeza do que este teste ligou.
  await prisma.client.update({ where: { id: c2.id }, data: { whatsappOptOutAt: null } });
  await prisma.companySettings.update({ where: { companyId: company.id }, data: { whatsappConnected: false, followUpEnabled: false } });
  console.log(failures ? `\n${failures} falha(s)` : '\nTudo certo');
}

main().catch((err) => { console.error(err); failures += 1; }).finally(async () => { await prisma.$disconnect(); process.exit(failures ? 1 : 0); });
