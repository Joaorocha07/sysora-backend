import { costMicros, type TokenUsage } from './aiPricing';
import { prismaBase as prisma } from './prisma';

// Registra uma chamada à IA para o painel master de gastos (grava mesmo dentro
// do simulador do bot, cuja transação é desfeita: a chamada foi paga). Falha ao registrar
// não derruba o pedido do usuário (a resposta da IA já foi paga).
export async function recordAiUsage(companyId: string | null, feature: string, model: string, usage: TokenUsage) {
  await save(companyId, feature, model, {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
    costMicros: costMicros(model, usage),
  });
}

// Serviços cobrados por outra unidade (ex.: transcrição, por minuto de áudio).
export async function recordAiCost(companyId: string | null, feature: string, model: string, micros: number) {
  await save(companyId, feature, model, { inputTokens: 0, outputTokens: 0, costMicros: Math.round(micros) });
}

async function save(
  companyId: string | null,
  feature: string,
  model: string,
  data: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; costMicros: number },
) {
  try {
    await prisma.aiUsage.create({ data: { companyId, feature, model, ...data } });
  } catch (err) {
    console.error('[IA] Não foi possível registrar o consumo:', err);
  }
}
