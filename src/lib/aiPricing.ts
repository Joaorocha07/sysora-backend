import { env } from '../config/env';

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
  // Outros fornecedores (BOT_AI_PROVIDER=openai). Preços de out/2026: confira no site de cada um.
  'gemini-3.1-flash-lite': { input: 0.25, output: 1.5, cacheRead: 0.025, cacheWrite: 0.25 },
  'gemini-2.5-flash-lite': { input: 0.1, output: 0.4, cacheRead: 0.01, cacheWrite: 0.1 },
  'deepseek-v4-flash': { input: 0.14, output: 0.28, cacheRead: 0.014, cacheWrite: 0.14 },
  'gpt-5.4-nano': { input: 0.2, output: 1.25, cacheRead: 0.02, cacheWrite: 0.2 },
  'gpt-4.1-nano': { input: 0.1, output: 0.4, cacheRead: 0.025, cacheWrite: 0.1 },
  // Groq (o nome vem como "openai/gpt-oss-20b"; priceOf tira o prefixo).
  'gpt-oss-20b': { input: 0.075, output: 0.3, cacheRead: 0.0375, cacheWrite: 0.075 },
  'gpt-oss-120b': { input: 0.15, output: 0.6, cacheRead: 0.075, cacheWrite: 0.15 },
};

export type TokenUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
};

// Modelo desconhecido: usa o preço do Opus 5.5 (o mais caro em uso), para não subestimar.
// Modelo de fora da tabela com preço no .env (BOT_AI_USD_PER_M_*): usa esse preço.
export function priceOf(model: string): Price {
  const known = PRICES[model] ?? PRICES[model.replace(/^.*\//, '')] ?? PRICES[model.replace(/-preview.*$|-\d{3,}$/, '')];
  if (known) return known;
  if (env.BOT_AI_USD_PER_M_INPUT !== undefined && env.BOT_AI_USD_PER_M_OUTPUT !== undefined) {
    const input = env.BOT_AI_USD_PER_M_INPUT;
    return { input, output: env.BOT_AI_USD_PER_M_OUTPUT, cacheRead: input / 10, cacheWrite: input };
  }
  return PRICES['claude-opus-5-5'];
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
