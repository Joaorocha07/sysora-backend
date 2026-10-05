import { env } from '../config/env';
import { prismaBase } from './prisma';

// Limite mensal de IA por CONTA (não por empresa): no Avançado, as 2 empresas
// da conta dividem os mesmos pedidos à Sora e mensagens da IA do bot. O
// contador zera sozinho quando o mês (AAAA-MM, UTC) muda.
//
// Usa prismaBase: conta mesmo dentro do simulador do bot, cuja transação é
// desfeita, porque a chamada à IA foi paga.

export type QuotaKind = 'sora' | 'botAi';

const monthKey = (d = new Date()) => d.toISOString().slice(0, 7);
const FIELDS = {
  sora: { month: 'soraMonth', count: 'soraCount' },
  botAi: { month: 'botAiMonth', count: 'botAiCount' },
} as const;

export const quotaLimit = (kind: QuotaKind) => (kind === 'sora' ? env.SORA_MONTHLY_LIMIT : env.BOT_AI_MONTHLY_LIMIT);

async function accountOf(companyId: string) {
  const company = await prismaBase.company.findUniqueOrThrow({ where: { id: companyId }, select: { account: true } });
  return company.account;
}

export async function quotaUsage(companyId: string, kind: QuotaKind): Promise<{ used: number; limit: number }> {
  const account = await accountOf(companyId);
  const f = FIELDS[kind];
  const used = account[f.month] === monthKey() ? account[f.count] : 0;
  return { used, limit: quotaLimit(kind) };
}

export async function countQuota(companyId: string, kind: QuotaKind): Promise<void> {
  const account = await accountOf(companyId);
  const f = FIELDS[kind];
  const month = monthKey();
  await prismaBase.account.update({
    where: { id: account.id },
    data: account[f.month] === month ? { [f.count]: { increment: 1 } } : { [f.month]: month, [f.count]: 1 },
  });
}
