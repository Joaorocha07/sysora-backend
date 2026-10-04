import { AppointmentStatus, Prisma, Service, ServiceKind, Source } from '@prisma/client';
import { decryptSecret, encryptSecret } from '../../lib/crypto';
import { HttpError } from '../../lib/httpError';
import { prisma } from '../../lib/prisma';
import { addDays, toIsoDate } from '../../lib/time';
import { ACTIVE_STATUSES } from '../appointments/availability';
import { FindOptions, FoundCode, findLatestCode, loginErrorMessage, parseSenders, testLogin } from './emailCodes.reader';

// Códigos por e-mail: a empresa cadastra caixas do Gmail e libera cada uma
// para os clientes certos. No WhatsApp, o cliente escolhe "Receber código" e
// o bot responde com o código mais recente das caixas liberadas para ele.
// Recurso liberado por empresa pelo admin master (emailCodesEnabled).

export const DEFAULT_SENDERS = 'openai.com';
// Código mais velho que isso já não serve (o do ChatGPT vale poucos minutos).
export const CODE_WINDOW_MINUTES = 15;

export type InboxInput = { label: string; email: string; appPassword: string; senders?: string };

const publicInbox = { id: true, label: true, email: true, senders: true, active: true, lastError: true, createdAt: true, clients: { select: { clientId: true } } } as const;
type InboxRow = Prisma.EmailInboxGetPayload<{ select: typeof publicInbox }>;
const toPublic = ({ clients, ...inbox }: InboxRow) => ({ ...inbox, clientIds: clients.map((c) => c.clientId) });

const normalizeSenders = (value: string | undefined) => parseSenders(value || DEFAULT_SENDERS).join(', ');
// A senha de app aparece no Google como "abcd efgh ijkl mnop".
const normalizePassword = (value: string) => value.replace(/\s+/g, '');

export async function isEnabled(companyId: string): Promise<boolean> {
  const settings = await prisma.companySettings.findUnique({ where: { companyId }, select: { emailCodesEnabled: true } });
  return Boolean(settings?.emailCodesEnabled);
}

async function requireInbox(companyId: string, id: string) {
  const inbox = await prisma.emailInbox.findFirst({ where: { id, companyId } });
  if (!inbox) throw HttpError.notFound('Caixa de e-mail não encontrada.');
  return inbox;
}

async function checkLogin(email: string, password: string) {
  try {
    await testLogin({ email, password });
  } catch (err) {
    throw HttpError.badRequest(loginErrorMessage(err));
  }
}

export async function listInboxes(companyId: string) {
  const inboxes = await prisma.emailInbox.findMany({ where: { companyId }, orderBy: { createdAt: 'asc' }, select: publicInbox });
  return inboxes.map(toPublic);
}

export async function createInbox(companyId: string, input: InboxInput) {
  const email = input.email.trim().toLowerCase();
  if (await prisma.emailInbox.findFirst({ where: { companyId, email } })) throw HttpError.conflict('Esse e-mail já está cadastrado.');
  const password = normalizePassword(input.appPassword);
  await checkLogin(email, password);
  const inbox = await prisma.emailInbox.create({
    data: { companyId, label: input.label.trim(), email, passwordEnc: encryptSecret(password), senders: normalizeSenders(input.senders) },
    select: publicInbox,
  });
  return toPublic(inbox);
}

export async function updateInbox(companyId: string, id: string, input: Partial<InboxInput> & { active?: boolean }) {
  const inbox = await requireInbox(companyId, id);
  const data: Prisma.EmailInboxUpdateInput = {};
  if (input.label !== undefined) data.label = input.label.trim();
  if (input.senders !== undefined) data.senders = normalizeSenders(input.senders);
  if (input.active !== undefined) data.active = input.active;
  if (input.appPassword) {
    const password = normalizePassword(input.appPassword);
    await checkLogin(inbox.email, password);
    data.passwordEnc = encryptSecret(password);
    data.lastError = null;
  }
  return toPublic(await prisma.emailInbox.update({ where: { id }, data, select: publicInbox }));
}

export async function deleteInbox(companyId: string, id: string) {
  await requireInbox(companyId, id);
  await prisma.emailInbox.delete({ where: { id } });
}

// Quais clientes recebem os códigos dessa caixa (substitui a lista).
export async function setInboxClients(companyId: string, id: string, clientIds: string[]) {
  await requireInbox(companyId, id);
  const valid = await prisma.client.findMany({ where: { companyId, id: { in: clientIds } }, select: { id: true } });
  await prisma.$transaction([
    prisma.clientEmailAccess.deleteMany({ where: { inboxId: id } }),
    prisma.clientEmailAccess.createMany({ data: valid.map((c) => ({ inboxId: id, clientId: c.id })) }),
  ]);
  return toPublic(await prisma.emailInbox.findUniqueOrThrow({ where: { id }, select: publicInbox }));
}

// Caixas liberadas para um cliente (formulário do cliente).
export async function setClientInboxes(companyId: string, clientId: string, inboxIds: string[]) {
  const client = await prisma.client.findFirst({ where: { id: clientId, companyId }, select: { id: true } });
  if (!client) throw HttpError.notFound('Cliente não encontrado.');
  const valid = await prisma.emailInbox.findMany({ where: { companyId, id: { in: inboxIds } }, select: { id: true } });
  await prisma.$transaction([
    prisma.clientEmailAccess.deleteMany({ where: { clientId } }),
    prisma.clientEmailAccess.createMany({ data: valid.map((i) => ({ clientId, inboxId: i.id })) }),
  ]);
}

type InboxRecord = { id: string; email: string; passwordEnc: string; senders: string };

async function readInbox(inbox: InboxRecord, withinMinutes: number, options?: FindOptions): Promise<FoundCode | null> {
  try {
    const found = await findLatestCode({ email: inbox.email, password: decryptSecret(inbox.passwordEnc) }, inbox.senders, withinMinutes, options);
    await prisma.emailInbox.update({ where: { id: inbox.id }, data: { lastError: null } }).catch(() => {});
    return found;
  } catch (err) {
    const message = loginErrorMessage(err);
    await prisma.emailInbox.update({ where: { id: inbox.id }, data: { lastError: message } }).catch(() => {});
    throw HttpError.badRequest(message);
  }
}

// Botão "Testar" da tela: último código da última hora.
export async function testInbox(companyId: string, id: string) {
  const found = await readInbox(await requireInbox(companyId, id), 60);
  return { found };
}

// Bot: códigos recentes das caixas ativas liberadas para o cliente.
export async function codesForClient(companyId: string, clientId: string) {
  const inboxes = await prisma.emailInbox.findMany({
    where: { companyId, active: true, clients: { some: { clientId } } },
    orderBy: { createdAt: 'asc' },
  });
  const results: { label: string; found: FoundCode | null; failed: boolean }[] = [];
  for (const inbox of inboxes) {
    try {
      results.push({ label: inbox.label, found: await readInbox(inbox, CODE_WINDOW_MINUTES), failed: false });
    } catch {
      results.push({ label: inbox.label, found: null, failed: true });
    }
  }
  return results;
}

// ============ Contas de acesso (produtos com accessEmail) ============
// O cliente diz o e-mail da conta (pode errar a digitação), o bot acha a
// conta mais parecida, o cliente pede o código no site e o bot entrega o
// código que chegou depois do pedido. No primeiro login, registra na agenda o
// vencimento do acesso (ACCESS_DAYS depois).

export const ACCESS_DAYS = 30;
export const EXPIRY_NOTE = 'Vencimento do acesso';
const MIN_SCORE = 0.6;

export async function accessProducts(companyId: string) {
  return prisma.service.findMany({ where: { companyId, active: true, kind: ServiceKind.PRODUCT, accessEmail: { not: null } }, orderBy: [{ position: 'asc' }, { name: 'asc' }] });
}

function levenshtein(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length];
}

const similarity = (a: string, b: string) => (a || b ? 1 - levenshtein(a, b) / Math.max(a.length, b.length) : 0);
// "Hypefy Chat Plano Gold @gmail" -> "hypefychatplanogold"
const local = (value: string) => value.toLowerCase().split('@')[0].normalize('NFD').replace(/[^a-z0-9]/g, '');

// Conta mais parecida com o que o cliente escreveu (e-mail com erro, sem
// @gmail.com, com espaços...). null se nenhuma for parecida o bastante.
export function matchAccount<T extends Pick<Service, 'accessEmail'>>(products: T[], typed: string): { product: T; score: number } | null {
  const wanted = local(typed);
  if (wanted.length < 3) return null;
  let best: { product: T; score: number } | null = null;
  for (const product of products) {
    const candidate = local(product.accessEmail!);
    // Também vale o cliente digitar só uma parte ("planogold").
    const score = Math.max(similarity(wanted, candidate), candidate.includes(wanted) && wanted.length >= 5 ? 0.9 : 0);
    if (!best || score > best.score) best = { product, score };
  }
  return best && best.score >= MIN_SCORE ? best : null;
}

// Código da conta que chegou depois de `after`. A caixa é a do próprio e-mail
// da conta; se ela não estiver conectada, procura nas outras caixas ativas
// (e-mails encaminhados), filtrando pelo destinatário.
export async function codeForAccount(companyId: string, accessEmail: string, after: Date): Promise<FoundCode | null> {
  const email = accessEmail.toLowerCase();
  const own = await prisma.emailInbox.findFirst({ where: { companyId, email, active: true } });
  const inboxes = own ? [own] : await prisma.emailInbox.findMany({ where: { companyId, active: true } });
  for (const inbox of inboxes) {
    const found = await readInbox(inbox, CODE_WINDOW_MINUTES, { after, recipient: email }).catch(() => null);
    if (found) return found;
  }
  return null;
}

// Alguma caixa ativa capaz de receber o código dessa conta?
export async function hasInboxFor(companyId: string): Promise<boolean> {
  return (await prisma.emailInbox.count({ where: { companyId, active: true } })) > 0;
}

// Acesso do cliente = o "vencimento" mais recente dele na agenda: a conta
// (produto do item) e a data. Vencido quando a data já passou.
export async function currentAccess(companyId: string, clientId: string, now = new Date()) {
  const appointment = await prisma.appointment.findFirst({
    where: { companyId, clientId, status: { not: AppointmentStatus.CANCELED }, notes: { startsWith: EXPIRY_NOTE } },
    orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
    include: { items: true },
  });
  if (!appointment) return null;
  const serviceId = appointment.items[0]?.serviceId;
  const product = serviceId ? await prisma.service.findUnique({ where: { id: serviceId } }) : null;
  return { appointment, product, expired: appointment.date < toIsoDate(now) };
}

const loginNote = (product: Service, extra: string) => `${EXPIRY_NOTE}: ${product.name} (${product.accessEmail}). ${extra}`;
const brFull = (iso: string) => iso.split('-').reverse().join('/');

// Vencimento na agenda: um agendamento só com a data (ACCESS_DAYS depois do
// primeiro login), com a conta do cliente no item e nas observações, sem
// lembretes do bot. Se o cliente já tem um acesso em dia, mantém o que existe.
export async function registerExpiry(companyId: string, clientId: string, product: Service, now = new Date()) {
  const access = await currentAccess(companyId, clientId, now);
  if (access && !access.expired) return { date: access.appointment.date, created: false };
  const today = toIsoDate(now);
  const date = toIsoDate(addDays(now, ACCESS_DAYS));
  await prisma.appointment.create({
    data: {
      companyId,
      clientId,
      date,
      startTime: '09:00',
      endTime: '09:00',
      status: AppointmentStatus.SCHEDULED,
      source: Source.BOT,
      totalCents: product.priceCents,
      notes: loginNote(product, `Primeiro login em ${brFull(today)}.`),
      // É um vencimento, não um horário: o bot não manda lembrete de "seu horário".
      reminderSentAt: now,
      hourReminderSentAt: now,
      items: { create: [{ serviceId: product.id, kind: ServiceKind.PRODUCT, name: product.name, durationMinutes: 0, priceCents: product.priceCents }] },
    },
  });
  return { date, created: true };
}

// Conta para o cliente (primeira vez ou "não consigo gerar imagem"), sem
// repetir a atual. Prefere as que têm o Gmail conectado (senão o código não
// chega) e, entre elas, a com menos clientes em dia.
export async function pickAnotherAccount(companyId: string, excludeId: string | null, now = new Date()) {
  const today = toIsoDate(now);
  const products = (await accessProducts(companyId)).filter((p) => p.id !== excludeId);
  const connected = new Set((await prisma.emailInbox.findMany({ where: { companyId, active: true }, select: { email: true } })).map((i) => i.email.toLowerCase()));
  let best: { product: Service; rank: [number, number] } | null = null;
  for (const product of products) {
    const load = await prisma.appointment.count({
      where: { companyId, date: { gte: today }, status: { in: ACTIVE_STATUSES }, notes: { startsWith: EXPIRY_NOTE }, items: { some: { serviceId: product.id } } },
    });
    const rank: [number, number] = [connected.has(product.accessEmail!.toLowerCase()) ? 0 : 1, load];
    if (!best || rank[0] < best.rank[0] || (rank[0] === best.rank[0] && rank[1] < best.rank[1])) best = { product, rank };
  }
  return best?.product ?? null;
}

// Troca a conta no vencimento do cliente (mesma data) e registra a anterior.
export async function switchAccess(appointmentId: string, from: Service | null, to: Service, now = new Date()) {
  await prisma.$transaction([
    prisma.appointmentItem.deleteMany({ where: { appointmentId } }),
    prisma.appointment.update({
      where: { id: appointmentId },
      data: {
        totalCents: to.priceCents,
        notes: loginNote(to, `Trocada em ${brFull(toIsoDate(now))} (não gerava imagem)${from?.accessEmail ? `; conta anterior: ${from.accessEmail}` : ''}.`),
        items: { create: [{ serviceId: to.id, kind: ServiceKind.PRODUCT, name: to.name, durationMinutes: 0, priceCents: to.priceCents }] },
      },
    }),
  ]);
}
