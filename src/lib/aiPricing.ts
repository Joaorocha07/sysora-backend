// Preço da API do Claude (US$ por milhão de tokens) para estimar o gasto com IA
// no painel master. Confira em https://www.anthropic.com/pricing ao trocar de
// modelo: o valor cobrado de verdade está no console da Anthropic.
// Escrita no cache (5 min) custa 1,25x a entrada; leitura do cache é bem mais barata.

type Price = { input: number; output: number; cacheRead: number; cacheWrite: number };

const PRICES: Record<string, Price> = {
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
};

export type TokenUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
};

// Modelo desconhecido: usa o preço do Opus 5.5 (o padrão da Sora), para não subestimar.
export function priceOf(model: string): Price {
  return PRICES[model] ?? PRICES['claude-opus-5-5'];
}

// Custo em milionésimos de dólar.
export function costMicros(model: string, usage: TokenUsage): number {
  const p = priceOf(model);
  return Math.round(
    usage.input_tokens * p.input
    + usage.output_tokens * p.output
    + (usage.cache_read_input_tokens ?? 0) * p.cacheRead
    + (usage.cache_creation_input_tokens ?? 0) * p.cacheWrite,
  );
}
