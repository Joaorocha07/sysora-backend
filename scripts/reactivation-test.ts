// Teste da reativação de clientes sem WhatsApp de verdade (envio simulado).
// Uso (banco LOCAL): DATABASE_URL=... DIRECT_URL=... npx ts-node --transpile-only scripts/reactivation-test.ts
import * as transport from '../src/modules/whatsapp/whatsapp.transport';
import * as cloud from '../src/modules/whatsapp/whatsapp.cloud';
import { prisma } from '../src/lib/prisma';

if (!/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL ?? '')) throw new Error('Rode só contra o banco local.');

const sent: { to: string; text: string }[] = [];
(transport as unknown as Record<string, unknown>).isReady = async () => true;
(transport as unknown as Record<string, unknown>).sendText = async (_c: string, to: string, text: string) => { sent.push({ to, text }); };
(cloud as unknown as Record<string, unknown>).getCloudAccount = async () => null;

let failures = 0;
const check = (label: string, ok: boolean, extra = '') => { console.log(`${ok ? 'OK  ' : 'FALHA'} ${label}${extra ? ` — ${extra}` : ''}`); if (!ok) failures += 1; };
const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000);
const iso = (d: Date) => d.toLocaleDateString('en-CA');

async function main() {
  const { sendReactivations } = await import('../src/modules/whatsapp/whatsapp.jobs');
  const company = await prisma.company.findFirstOrThrow({ where: { name: 'Empresa Demo' } });
  const companyId = company.id;
  await prisma.companySettings.update({
    where: { companyId },
    data: {
      whatsappConnected: true, botEnabled: true, reactivationEnabled: true, reactivationDays: 30,
      reactivationMessage: 'Oi, {nome}! Saudade da {empresa}. Agende aqui: {link}',
      workDays: [0, 1, 2, 3, 4, 5, 6], openingTime: '00:00', closingTime: '23:59', lunchEnabled: false,
    },
  });
  // Só os clientes deste teste disputam a vez.
  await prisma.client.updateMany({ where: { companyId }, data: { lastInboundAt: null, reactivatedAt: null } });
  await prisma.client.deleteMany({ where: { companyId, name: { startsWith: 'Reat ' } } });
  const service = await prisma.service.findFirstOrThrow({ where: { companyId, kind: 'SERVICE' } });
  const make = async (name: string, phone: string, lastIn: Date, extra: Record<string, unknown> = {}) =>
    prisma.client.create({ data: { companyId, name, phone, whatsappId: `55${phone}`, lastInboundAt: lastIn, lastMessageAt: lastIn, source: 'BOT', ...extra } });
  const appt = (clientId: string, date: Date, status: 'SCHEDULED' | 'COMPLETED') => prisma.appointment.create({ data: {
    companyId, clientId, date: iso(date), startTime: '10:00', endTime: '11:00', status, totalCents: 0,
    items: { create: [{ serviceId: service.id, kind: 'SERVICE', name: service.name, durationMinutes: 60, priceCents: 0 }] },
  } });

  const ok = await make('Reat Ana Souza', '34990000001', daysAgo(40));
  const future = await make('Reat Futuro', '34990000002', daysAgo(50));
  await appt(future.id, new Date(Date.now() + 3 * 86_400_000), 'SCHEDULED');
  const recent = await make('Reat Atendido', '34990000003', daysAgo(45));
  await appt(recent.id, daysAgo(10), 'COMPLETED');
  await make('Reat Parar', '34990000004', daysAgo(60), { whatsappOptOutAt: daysAgo(20) });
  await make('Reat Ja Recebeu', '34990000005', daysAgo(70), { reactivatedAt: daysAgo(5) });
  await make('Reat Muito Antigo', '34990000006', daysAgo(400));
  await make('Reat Ativo', '34990000007', daysAgo(3));

  sent.length = 0;
  let n = await sendReactivations();
  check('manda para quem sumiu há 30+ dias', n === 1 && sent[0]?.to === ok.whatsappId, JSON.stringify(sent.map((s) => s.to)));
  check('troca {nome}, {empresa} e {link}', /^Oi, Reat! Saudade da Empresa Demo\. Agende aqui: http\S+\/agendar\/\S+/.test(sent[0]?.text ?? ''), sent[0]?.text);
  check('termina com o aviso de PARAR', (sent[0]?.text ?? '').endsWith('responda PARAR.'));
  const okAfter = await prisma.client.findUniqueOrThrow({ where: { id: ok.id } });
  check('marca reactivatedAt e registra na conversa', Boolean(okAfter.reactivatedAt) && Boolean(await prisma.message.findFirst({ where: { clientId: ok.id, sender: 'BOT' } })));
  check('cria o link de agendamento', Boolean(await prisma.bookingLink.findFirst({ where: { clientId: ok.id } })));

  sent.length = 0;
  n = await sendReactivations();
  check('ninguém mais se encaixa (horário marcado, atendido, PARAR, já recebeu, antigo, ativo)', n === 0, JSON.stringify(sent.map((s) => s.to)));

  // Limite do dia
  const extra = await make('Reat Extra', '34990000008', daysAgo(40));
  await prisma.client.updateMany({ where: { companyId, name: { startsWith: 'Reat ' }, id: { not: extra.id } }, data: { reactivatedAt: new Date() } });
  const fillers = await Promise.all(Array.from({ length: 19 }, (_, i) => make(`Reat Cheio ${i}`, `3499100${String(i).padStart(4, '0')}`, daysAgo(2), { reactivatedAt: new Date() })));
  n = await sendReactivations();
  check('respeita o limite de 20 por dia', n === 0, `já enviados hoje: ${fillers.length + 7}`);
  await prisma.client.deleteMany({ where: { id: { in: fillers.map((f) => f.id) } } });

  // Fora do horário de atendimento
  const hour = new Date().getHours();
  await prisma.companySettings.update({ where: { companyId }, data: { openingTime: `${String((hour + 2) % 24).padStart(2, '0')}:00`, closingTime: `${String((hour + 3) % 24).padStart(2, '0')}:00` } });
  n = await sendReactivations();
  check('não manda fora do horário de atendimento', n === 0);

  // Limpeza
  await prisma.client.deleteMany({ where: { companyId, name: { startsWith: 'Reat ' } } });
  await prisma.companySettings.update({ where: { companyId }, data: { whatsappConnected: false, reactivationEnabled: false, openingTime: '09:00', closingTime: '18:00', workDays: [1, 2, 3, 4, 5, 6] } });
  console.log(failures ? `\n${failures} falha(s)` : '\nTudo certo');
}

main().catch((err) => { console.error(err); failures += 1; }).finally(async () => { await prisma.$disconnect(); process.exit(failures ? 1 : 0); });
