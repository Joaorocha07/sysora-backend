import type { Expense } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { HttpError } from '../../lib/httpError';
import { getPlatformSettings } from '../../lib/platformSettings';
import { stats } from './admin.service';

// Página Gastos do painel master: gastos cadastrados à mão (em reais) + gasto
// estimado da IA (ai_usage, em dólar) convertido pela cotação das configurações.

export const EXPENSE_CATEGORIES = ['infraestrutura', 'ferramentas', 'marketing', 'impostos', 'pessoal', 'outros'] as const;

export type ExpenseInput = {
  description: string;
  category: (typeof EXPENSE_CATEGORIES)[number];
  amountCents: number;
  date: string;
  recurring?: boolean;
  endDate?: string | null;
  notes?: string | null;
};

// Meses mostrados no histórico (o escolhido e os anteriores).
const HISTORY_MONTHS = 6;

// Datas sem hora (@db.Date) vêm do banco à meia-noite UTC.
const dateOnly = (iso: string) => new Date(`${iso}T00:00:00Z`);
const monthOf = (d: Date) => d.toISOString().slice(0, 7);
const isoDate = (d: Date) => d.toISOString().slice(0, 10);

function shiftMonth(month: string, delta: number) {
  const [y, m] = month.split('-').map(Number);
  return monthOf(new Date(Date.UTC(y, m - 1 + delta, 1)));
}

function currentMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

// Início do mês no fuso do servidor (TZ), o mesmo critério da página IA.
function localMonthStart(month: string) {
  const [y, m] = month.split('-').map(Number);
  return new Date(y, m - 1, 1);
}

// Único: só no mês da data. Mensal: do mês da data até o mês do fim (se houver).
function occursIn(e: Pick<Expense, 'recurring' | 'date' | 'endDate'>, month: string) {
  if (!e.recurring) return monthOf(e.date) === month;
  return monthOf(e.date) <= month && (!e.endDate || monthOf(e.endDate) >= month);
}

const serialize = (e: Expense) => ({
  id: e.id,
  description: e.description,
  category: e.category,
  amountCents: e.amountCents,
  date: isoDate(e.date),
  recurring: e.recurring,
  endDate: e.endDate ? isoDate(e.endDate) : null,
  notes: e.notes,
});

export async function expensesSummary(month = currentMonth()) {
  const firstMonth = shiftMonth(month, -(HISTORY_MONTHS - 1));
  const nextMonth = shiftMonth(month, 1);
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const [settings, expenses, aiRows, revenueCents] = await Promise.all([
    getPlatformSettings(),
    prisma.expense.findMany({ where: { date: { lt: dateOnly(`${nextMonth}-01`) } }, orderBy: [{ date: 'desc' }, { createdAt: 'desc' }] }),
    // "createdAt" é gravado em UTC (timestamp sem fuso): converte para o fuso do servidor antes de agrupar por mês.
    prisma.$queryRaw<{ month: string; feature: string; micros: bigint; calls: bigint }[]>`
      SELECT to_char(("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE ${timeZone}, 'YYYY-MM') AS month,
             feature, SUM("costMicros")::bigint AS micros, COUNT(*)::bigint AS calls
      FROM ai_usage
      WHERE "createdAt" >= ${localMonthStart(firstMonth)} AND "createdAt" < ${localMonthStart(nextMonth)}
      GROUP BY 1, 2`,
    stats().then((s) => s.mrrCents),
  ]);

  const rate = settings.usdBrlRate;
  const brlCents = (usd: number) => Math.round(usd * rate * 100);
  const aiUsdOf = (mo: string) => aiRows.filter((r) => r.month === mo).reduce((sum, r) => sum + Number(r.micros), 0) / 1_000_000;
  const manualOf = (mo: string) => expenses.filter((e) => occursIn(e, mo)).reduce((sum, e) => sum + e.amountCents, 0);

  const aiUsd = aiUsdOf(month);
  const manualCents = manualOf(month);
  const aiCents = brlCents(aiUsd);

  return {
    month,
    rate,
    // Receita mensal recorrente de hoje (não é histórica).
    revenueCents,
    expenses: expenses.filter((e) => occursIn(e, month)).map(serialize),
    ai: {
      usd: aiUsd,
      brlCents: aiCents,
      byFeature: aiRows
        .filter((r) => r.month === month)
        .map((r) => {
          const usd = Number(r.micros) / 1_000_000;
          return { feature: r.feature, calls: Number(r.calls), usd, brlCents: brlCents(usd) };
        })
        .sort((a, b) => b.usd - a.usd),
    },
    totals: { manualCents, aiCents, totalCents: manualCents + aiCents },
    history: Array.from({ length: HISTORY_MONTHS }, (_, i) => {
      const mo = shiftMonth(firstMonth, i);
      return { month: mo, manualCents: manualOf(mo), aiCents: brlCents(aiUsdOf(mo)) };
    }),
  };
}

function checkDates(date: string, endDate: string | null | undefined) {
  if (endDate && endDate.slice(0, 7) < date.slice(0, 7)) {
    throw HttpError.badRequest('O mês final precisa ser igual ou depois do mês de início.');
  }
}

export async function createExpense(input: ExpenseInput) {
  checkDates(input.date, input.endDate);
  const recurring = input.recurring ?? false;
  const expense = await prisma.expense.create({
    data: {
      description: input.description,
      category: input.category,
      amountCents: input.amountCents,
      date: dateOnly(input.date),
      recurring,
      endDate: recurring && input.endDate ? dateOnly(input.endDate) : null,
      notes: input.notes || null,
    },
  });
  return serialize(expense);
}

export async function updateExpense(id: string, input: Partial<ExpenseInput>) {
  const current = await prisma.expense.findUnique({ where: { id } });
  if (!current) throw HttpError.notFound('Gasto não encontrado.');
  const date = input.date ?? isoDate(current.date);
  const recurring = input.recurring ?? current.recurring;
  const endDate = input.endDate !== undefined ? input.endDate : current.endDate && isoDate(current.endDate);
  checkDates(date, endDate);
  const expense = await prisma.expense.update({
    where: { id },
    data: {
      description: input.description,
      category: input.category,
      amountCents: input.amountCents,
      date: dateOnly(date),
      recurring,
      endDate: recurring && endDate ? dateOnly(endDate) : null,
      notes: input.notes !== undefined ? input.notes || null : undefined,
    },
  });
  return serialize(expense);
}

export async function deleteExpense(id: string) {
  const { count } = await prisma.expense.deleteMany({ where: { id } });
  if (!count) throw HttpError.notFound('Gasto não encontrado.');
}
