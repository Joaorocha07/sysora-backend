import { Prisma, Service, Source } from '@prisma/client';
import { HttpError } from '../../lib/httpError';
import { prisma } from '../../lib/prisma';
import { pad, toIsoDate } from '../../lib/time';

// Assinaturas dos clientes: a empresa vende um produto por mês e registra a
// data da compra e o vencimento. Cada linha é um período pago; renovar cria
// um período novo que começa no vencimento anterior (se ainda não venceu) ou
// hoje. O bot registra sozinho a venda das contas de acesso
// (emailCodes.service.ts). Recurso liberado por empresa pelo admin master
// (clientSubscriptionsEnabled).

export type SubscriptionInput = {
  clientId: string;
  serviceId?: string | null;
  name?: string;
  priceCents?: number;
  startDate: string;
  dueDate?: string;
  months?: number;
  notes?: string | null;
};
export type RenewInput = { startDate?: string; months?: number; priceCents?: number; notes?: string | null };
export type UpdateInput = Partial<Pick<SubscriptionInput, 'name' | 'priceCents' | 'startDate' | 'dueDate' | 'notes'>>;

const include = {
  client: { select: { id: true, name: true, phone: true } },
  service: { select: { id: true, name: true, accessEmail: true } },
} as const;

export async function isEnabled(companyId: string): Promise<boolean> {
  const settings = await prisma.companySettings.findUnique({ where: { companyId }, select: { clientSubscriptionsEnabled: true } });
  return Boolean(settings?.clientSubscriptionsEnabled);
}

// Mesmo dia `months` meses depois; sem esse dia no mês, o último dia
// (31/01 + 1 mês = 28/02).
export function addMonths(iso: string, months: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const target = new Date(y, m - 1 + months, 1);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  return `${target.getFullYear()}-${pad(target.getMonth() + 1)}-${pad(Math.min(d, lastDay))}`;
}

async function requireClient(companyId: string, clientId: string) {
  const client = await prisma.client.findFirst({ where: { id: clientId, companyId }, select: { id: true } });
  if (!client) throw HttpError.notFound('Cliente não encontrado.');
}

async function requireSubscription(companyId: string, id: string) {
  const subscription = await prisma.clientSubscription.findFirst({ where: { id, companyId } });
  if (!subscription) throw HttpError.notFound('Assinatura não encontrada.');
  return subscription;
}

function checkDates(startDate: string, dueDate: string) {
  if (dueDate <= startDate) throw HttpError.badRequest('O vencimento precisa ser depois da data da compra.');
}

// Assinatura atual de cada cliente (o período não cancelado com o maior
// vencimento; sem nenhum, o último cancelado) e quantos períodos ele tem.
export async function listCurrent(companyId: string) {
  const rows = await prisma.clientSubscription.findMany({
    where: { companyId },
    orderBy: [{ dueDate: 'desc' }, { createdAt: 'desc' }],
    include,
  });
  rows.sort((a, b) => Number(Boolean(a.canceledAt)) - Number(Boolean(b.canceledAt)));
  const byClient = new Map<string, (typeof rows)[number] & { periods: number }>();
  for (const row of rows) {
    const current = byClient.get(row.clientId);
    if (current) current.periods += 1;
    else byClient.set(row.clientId, { ...row, periods: 1 });
  }
  return [...byClient.values()];
}

// Todos os períodos de um cliente (inclusive os cancelados), do mais novo ao mais antigo.
export async function listForClient(companyId: string, clientId: string) {
  await requireClient(companyId, clientId);
  return prisma.clientSubscription.findMany({ where: { companyId, clientId }, orderBy: [{ dueDate: 'desc' }, { createdAt: 'desc' }], include });
}

export async function create(companyId: string, input: SubscriptionInput, source: Source = Source.STAFF) {
  await requireClient(companyId, input.clientId);
  const product = input.serviceId ? await prisma.service.findFirst({ where: { id: input.serviceId, companyId } }) : null;
  if (input.serviceId && !product) throw HttpError.notFound('Produto não encontrado.');
  const name = input.name?.trim() || product?.name;
  if (!name) throw HttpError.badRequest('Escolha o produto ou informe o nome da assinatura.');
  const dueDate = input.dueDate ?? addMonths(input.startDate, input.months ?? 1);
  checkDates(input.startDate, dueDate);
  return prisma.clientSubscription.create({
    data: {
      companyId,
      clientId: input.clientId,
      serviceId: product?.id ?? null,
      name,
      priceCents: input.priceCents ?? product?.priceCents ?? 0,
      startDate: input.startDate,
      dueDate,
      source,
      notes: input.notes?.trim() || null,
    },
    include,
  });
}

// Novo período pago, com o mesmo produto. Renovou antes de vencer: o período
// novo começa no vencimento atual (o cliente não perde dias).
export async function renew(companyId: string, id: string, input: RenewInput, now = new Date()) {
  const previous = await requireSubscription(companyId, id);
  const startDate = input.startDate ?? toIsoDate(now);
  const base = previous.canceledAt || previous.dueDate < startDate ? startDate : previous.dueDate;
  const dueDate = addMonths(base, input.months ?? 1);
  return prisma.clientSubscription.create({
    data: {
      companyId,
      clientId: previous.clientId,
      serviceId: previous.serviceId,
      name: previous.name,
      priceCents: input.priceCents ?? previous.priceCents,
      startDate,
      dueDate,
      source: Source.STAFF,
      notes: input.notes?.trim() || null,
    },
    include,
  });
}

export async function update(companyId: string, id: string, input: UpdateInput) {
  const existing = await requireSubscription(companyId, id);
  const data: Prisma.ClientSubscriptionUpdateInput = {};
  if (input.name !== undefined) data.name = input.name.trim();
  if (input.priceCents !== undefined) data.priceCents = input.priceCents;
  if (input.startDate !== undefined) data.startDate = input.startDate;
  if (input.dueDate !== undefined) data.dueDate = input.dueDate;
  if (input.notes !== undefined) data.notes = input.notes?.trim() || null;
  checkDates(input.startDate ?? existing.startDate, input.dueDate ?? existing.dueDate);
  return prisma.clientSubscription.update({ where: { id }, data, include });
}

// Cancela a assinatura do cliente: esse período e os já pagos à frente. O
// cliente perde o acesso (o bot passa a tratar como vencida).
export async function cancel(companyId: string, id: string, now = new Date()) {
  const subscription = await requireSubscription(companyId, id);
  await prisma.clientSubscription.updateMany({
    where: { companyId, clientId: subscription.clientId, canceledAt: null, OR: [{ id }, { dueDate: { gte: toIsoDate(now) } }] },
    data: { canceledAt: now },
  });
  return prisma.clientSubscription.findUniqueOrThrow({ where: { id }, include });
}

export async function remove(companyId: string, id: string) {
  await requireSubscription(companyId, id);
  await prisma.clientSubscription.delete({ where: { id } });
}

// ---------- Usado pelo bot ----------

// Assinatura atual do cliente. Vencida quando o vencimento já passou (o dia
// do vencimento ainda vale).
export async function currentSubscription(companyId: string, clientId: string, now = new Date()) {
  const subscription = await prisma.clientSubscription.findFirst({
    where: { companyId, clientId, canceledAt: null },
    orderBy: [{ dueDate: 'desc' }, { createdAt: 'desc' }],
    include: { service: true },
  });
  if (!subscription) return null;
  return { subscription, expired: subscription.dueDate < toIsoDate(now) };
}

// Venda feita pelo bot: um mês a partir de hoje.
export async function registerBotSale(companyId: string, clientId: string, product: Service, notes: string, now = new Date()) {
  const startDate = toIsoDate(now);
  return prisma.clientSubscription.create({
    data: {
      companyId,
      clientId,
      serviceId: product.id,
      name: product.name,
      priceCents: product.priceCents,
      startDate,
      dueDate: addMonths(startDate, 1),
      source: Source.BOT,
      notes,
    },
  });
}

// Clientes em dia com cada produto (para dividir as contas de acesso).
export async function activeClientsOf(companyId: string, serviceId: string, now = new Date()) {
  const rows = await prisma.clientSubscription.findMany({
    where: { companyId, serviceId, canceledAt: null, dueDate: { gte: toIsoDate(now) } },
    distinct: ['clientId'],
    select: { clientId: true },
  });
  return rows.length;
}
