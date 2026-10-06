import { AppointmentStatus, ServiceKind } from '@prisma/client';
import { prisma } from './prisma';

// Vendas de um período (datas AAAA-MM-DD, inclusivas), somando:
// - atendimentos concluídos: cada item vira venda de serviço ou de produto;
// - assinaturas de clientes (ex.: contas vendidas por mês): cada período
//   vendido (o primeiro e cada renovação) conta na data de início, como
//   serviço ou produto conforme o item do catálogo (sem item: produto).
// Usado pelo painel (só o total) e pela Sora (total e detalhamento).

export type SalesLine = { count: number; cents: number };
export type SalesSummary = {
  totalCents: number;
  // Atendimentos concluídos + assinaturas vendidas.
  sales: number;
  services: SalesLine;
  products: SalesLine;
  // Mais vendidos (por valor).
  top: { name: string; kind: ServiceKind; count: number; cents: number }[];
};

export async function salesSummary(companyId: string, from: string, to: string, topLimit = 5): Promise<SalesSummary> {
  const [appointments, subscriptions] = await Promise.all([
    prisma.appointment.findMany({
      where: { companyId, status: AppointmentStatus.COMPLETED, date: { gte: from, lte: to } },
      select: { totalCents: true, items: { select: { kind: true, name: true, priceCents: true } } },
    }),
    prisma.clientSubscription.findMany({
      where: { companyId, startDate: { gte: from, lte: to } },
      select: { name: true, priceCents: true, service: { select: { kind: true } } },
    }),
  ]);

  const lines: { name: string; kind: ServiceKind; cents: number }[] = [];
  for (const a of appointments) {
    // Agendamento antigo sem itens: conta o total como serviço.
    if (!a.items.length) lines.push({ name: 'Atendimento', kind: ServiceKind.SERVICE, cents: a.totalCents });
    for (const i of a.items) lines.push({ name: i.name, kind: i.kind, cents: i.priceCents });
  }
  for (const s of subscriptions) lines.push({ name: s.name, kind: s.service?.kind ?? ServiceKind.PRODUCT, cents: s.priceCents });

  const sum = (kind: ServiceKind): SalesLine => {
    const of = lines.filter((l) => l.kind === kind);
    return { count: of.length, cents: of.reduce((total, l) => total + l.cents, 0) };
  };
  const services = sum(ServiceKind.SERVICE);
  const products = sum(ServiceKind.PRODUCT);

  const byName = new Map<string, { name: string; kind: ServiceKind; count: number; cents: number }>();
  for (const l of lines) {
    const key = `${l.kind}:${l.name.toLowerCase()}`;
    const entry = byName.get(key) ?? { name: l.name, kind: l.kind, count: 0, cents: 0 };
    entry.count += 1;
    entry.cents += l.cents;
    byName.set(key, entry);
  }
  const top = [...byName.values()].sort((a, b) => b.cents - a.cents || b.count - a.count).slice(0, topLimit);

  return { totalCents: services.cents + products.cents, sales: appointments.length + subscriptions.length, services, products, top };
}
