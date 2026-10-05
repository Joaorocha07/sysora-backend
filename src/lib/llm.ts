import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import * as z from 'zod/v4';
import { env } from '../config/env';
import type { TokenUsage } from './aiPricing';

// Modelo "barato" da Sysora (IA do bot e "Melhorar com IA" do catálogo), com
// troca de fornecedor por variável de ambiente:
//   BOT_AI_PROVIDER=anthropic (padrão): Claude, chave ANTHROPIC_API_KEY.
//   BOT_AI_PROVIDER=openai: qualquer API compatível com a da OpenAI (OpenAI,
//     Gemini, DeepSeek, Groq, OpenRouter...): BOT_AI_BASE_URL + BOT_AI_API_KEY.
// Em ambos, BOT_AI_MODEL escolhe o modelo. A resposta é sempre um JSON
// validado pelo esquema (zod); inválido = null, e quem chama segue sem a IA.
// Antes de trocar, compare a qualidade: npm run ai:bench.

export type StructuredResult<T> = { data: T | null; model: string; usage: TokenUsage };
type Request<T> = { system: string; user: string; schema: z.ZodType<T>; name: string; maxTokens: number };

export function botAiConfigured(): boolean {
  return env.BOT_AI_PROVIDER === 'openai' ? Boolean(env.BOT_AI_BASE_URL && env.BOT_AI_API_KEY) : Boolean(env.ANTHROPIC_API_KEY);
}

let anthropicClient: Anthropic | null = null;

async function viaAnthropic<T>(req: Request<T>): Promise<StructuredResult<T>> {
  anthropicClient ??= new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const response = await anthropicClient.beta.messages.parse({
    model: env.BOT_AI_MODEL,
    max_tokens: req.maxTokens,
    system: req.system,
    messages: [{ role: 'user', content: req.user }],
    output_config: { format: betaZodOutputFormat(req.schema) },
  });
  const data = response.stop_reason !== 'refusal' ? (response.parsed_output as T | null) ?? null : null;
  return { data, model: response.model, usage: response.usage };
}

type ChatResponse = {
  model?: string;
  choices?: { message?: { content?: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
  error?: { message?: string };
};

// Fornecedores que não aceitam json_schema caem para json_object (lembrado por modelo).
const jsonObjectOnly = new Set<string>();

function parseJson<T>(content: string | null | undefined, schema: z.ZodType<T>): T | null {
  if (!content) return null;
  const text = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  try {
    const parsed = schema.safeParse(JSON.parse(text.slice(start, end + 1)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function viaOpenAi<T>(req: Request<T>): Promise<StructuredResult<T>> {
  const jsonSchema = z.toJSONSchema(req.schema);
  const model = env.BOT_AI_MODEL;
  const base = env.BOT_AI_BASE_URL!.replace(/\/$/, '');
  // Mesmo com json_schema, o formato vai no texto: ajuda modelos pequenos e o modo json_object.
  const system = `${req.system}\n\nResponda somente com um objeto JSON válido neste formato (JSON Schema):\n${JSON.stringify(jsonSchema)}`;
  const extra = env.BOT_AI_EXTRA_BODY ? (JSON.parse(env.BOT_AI_EXTRA_BODY) as Record<string, unknown>) : {};
  const tokensField = /api\.openai\.com/.test(base) ? 'max_completion_tokens' : 'max_tokens';

  const call = async (format: 'json_schema' | 'json_object') => {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.BOT_AI_API_KEY}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'system', content: system }, { role: 'user', content: req.user }],
        [tokensField]: req.maxTokens,
        temperature: 0,
        response_format: format === 'json_schema'
          ? { type: 'json_schema', json_schema: { name: req.name, schema: jsonSchema, strict: false } }
          : { type: 'json_object' },
        ...extra,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const body = (await res.json().catch(() => ({}))) as ChatResponse;
    return { ok: res.ok, status: res.status, body };
  };

  let result = await call(jsonObjectOnly.has(model) ? 'json_object' : 'json_schema');
  if (!result.ok && result.status === 400 && /response_format|json_schema|schema/i.test(result.body.error?.message ?? '')) {
    jsonObjectOnly.add(model);
    result = await call('json_object');
  }
  if (!result.ok) throw new Error(`IA (${model}) respondeu ${result.status}: ${result.body.error?.message ?? 'erro desconhecido'}`);

  const usage = result.body.usage ?? {};
  const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    data: parseJson(result.body.choices?.[0]?.message?.content, req.schema),
    model: result.body.model ?? model,
    usage: { input_tokens: Math.max(0, (usage.prompt_tokens ?? 0) - cached), output_tokens: usage.completion_tokens ?? 0, cache_read_input_tokens: cached },
  };
}

export function structured<T>(req: Request<T>): Promise<StructuredResult<T>> {
  return env.BOT_AI_PROVIDER === 'openai' ? viaOpenAi(req) : viaAnthropic(req);
}
