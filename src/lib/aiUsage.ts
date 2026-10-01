import { costMicros, type TokenUsage } from './aiPricing';
import { prisma } from './prisma';

// Registra uma chamada à IA para o painel master de gastos. Falha ao registrar
// não derruba o pedido do usuário (a resposta da IA já foi paga).
export async function recordAiUsage(companyId: string | null, feature: string, model: string, usage: TokenUsage) {
  try {
    await prisma.aiUsage.create({
      data: {
        companyId,
        feature,
        model,
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        cacheReadTokens: usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
        costMicros: costMicros(model, usage),
      },
    });
  } catch (err) {
    console.error('[IA] Não foi possível registrar o consumo:', err);
  }
}
