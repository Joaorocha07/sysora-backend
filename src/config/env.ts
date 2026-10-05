import 'dotenv/config';
import { z } from 'zod';

const bool = (fallback: 'true' | 'false') => z.string().default(fallback).transform((value) => value === 'true');
// Variável opcional: vazia no .env (ex.: META_APP_ID=) vale como não definida.
const optionalText = () => z.string().optional().transform((value) => value?.trim() || undefined);

const schema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL é obrigatório'),
  PORT: z.coerce.number().default(3333),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  CORS_ORIGIN: z.string().default('http://localhost:3000'),
  // Frontend e backend em domínios diferentes (ex.: Vercel + Render): cookie SameSite=None + Secure.
  CROSS_SITE_COOKIES: bool('false'),
  // Atrás de proxy (Render, Railway, Nginx...): necessário para o rate limit identificar o IP.
  TRUST_PROXY: bool('false'),

  JWT_ACCESS_SECRET: z.string().min(16, 'JWT_ACCESS_SECRET precisa ter pelo menos 16 caracteres'),
  JWT_REFRESH_SECRET: z.string().min(16, 'JWT_REFRESH_SECRET precisa ter pelo menos 16 caracteres'),
  JWT_PREAUTH_SECRET: z.string().min(16, 'JWT_PREAUTH_SECRET precisa ter pelo menos 16 caracteres'),
  JWT_ACCESS_EXPIRES_IN: z.string().default('15m'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('7d'),
  JWT_PREAUTH_EXPIRES_IN: z.string().default('5m'),

  REFRESH_COOKIE_NAME: z.string().default('sysora_refresh_token'),
  COOKIE_SECURE: bool('false'),

  // Conexão com o WhatsApp Web. Desligue em cópias locais que usam o mesmo
  // banco da produção, para não disputarem a sessão do WhatsApp.
  WHATSAPP_ENABLED: bool('true'),

  // API oficial do WhatsApp (Cloud API da Meta), conectada pelo cadastro
  // incorporado (Embedded Signup). Sem META_APP_ID, META_APP_SECRET e
  // META_CONFIG_ID a opção oficial aparece desativada e só o QR Code funciona.
  // Ver whatsapp.cloud.ts.
  META_APP_ID: optionalText(),
  META_APP_SECRET: optionalText(),
  META_CONFIG_ID: optionalText(),
  // Texto qualquer, igual ao "Verify token" do webhook no painel do app da Meta.
  META_WEBHOOK_VERIFY_TOKEN: optionalText(),
  META_GRAPH_VERSION: z.string().default('v25.0'),
  // Endereço público deste backend (https), para montar a URL do webhook que
  // vai no app da Meta de cada empresa na conexão manual. Vazio: usa o
  // endereço pelo qual a requisição chegou.
  PUBLIC_API_URL: z.string().url('PUBLIC_API_URL inválida').optional().or(z.literal('').transform(() => undefined)),
  // Preços da Meta no Brasil (R$ por mensagem) e cota grátis de mensagens de
  // atendimento por número por mês, só para a estimativa de custo na tela.
  WHATSAPP_FREE_SERVICE_MONTHLY: z.coerce.number().int().nonnegative().default(1000),
  WHATSAPP_PRICE_SERVICE_BRL: z.coerce.number().nonnegative().default(0.035),
  WHATSAPP_PRICE_UTILITY_BRL: z.coerce.number().nonnegative().default(0.035),
  WHATSAPP_PRICE_AUTHENTICATION_BRL: z.coerce.number().nonnegative().default(0.035),
  WHATSAPP_PRICE_MARKETING_BRL: z.coerce.number().nonnegative().default(0.3217),

  // O cadastro público de empresas é ligado/desligado pelo admin master no
  // painel (tabela platform_settings). MASTER_* e SEED_DEMO só valem para o
  // `npm run seed` (prisma/seed.ts), não para o servidor.

  // Login com Google (Supabase Auth). Sem estas duas o login com Google fica desligado.
  SUPABASE_URL: z.string().url('SUPABASE_URL inválida').optional().or(z.literal('').transform(() => undefined)),
  SUPABASE_PUBLISHABLE_KEY: z.string().optional(),

  // Mercado Pago (assinaturas recorrentes).
  MP_ACCESS_TOKEN: z.string().optional(),
  MP_PLAN_INICIAL_ID: z.string().optional(),
  MP_PLAN_AVANCADO_ID: z.string().optional(),

  // Sora: assistente de IA (Claude) que monta o fluxo do bot. Sem a chave, o
  // botão da Sora avisa que não está configurada e o editor manual segue normal.
  ANTHROPIC_API_KEY: z.string().optional(),
  // Sonnet: metade do preço do Opus e suficiente para montar fluxos.
  SORA_MODEL: z.string().default('claude-sonnet-5-5'),
  // Pedidos à Sora por conta por mês (cada mensagem no chat conta 1; as empresas da conta dividem).
  SORA_MONTHLY_LIMIT: z.coerce.number().int().positive().default(60),
  // IA do atendimento: entende o que o cliente escreveu quando não é um número
  // nem uma palavra-chave (whatsapp.ai.ts). Modelo barato e rápido; mesma chave da Sora.
  BOT_AI_MODEL: z.string().default('claude-haiku-4-5'),
  // Fornecedor do modelo barato (lib/llm.ts): "anthropic" (padrão) ou "openai" =
  // qualquer API compatível com a da OpenAI (Gemini, DeepSeek, Groq, OpenRouter...).
  BOT_AI_PROVIDER: z.enum(['anthropic', 'openai']).default('anthropic'),
  // Só com BOT_AI_PROVIDER=openai. Ex.: https://generativelanguage.googleapis.com/v1beta/openai
  BOT_AI_BASE_URL: z.string().url().optional(),
  BOT_AI_API_KEY: z.string().optional(),
  // Campos extras no pedido, em JSON (ex.: {"reasoning_effort":"low"}).
  BOT_AI_EXTRA_BODY: z.string().optional(),
  // Preço (US$ por milhão de tokens) de um modelo que não está em lib/aiPricing.ts.
  BOT_AI_USD_PER_M_INPUT: z.coerce.number().nonnegative().optional(),
  BOT_AI_USD_PER_M_OUTPUT: z.coerce.number().nonnegative().optional(),
  // Mensagens interpretadas pela IA por conta por mês (as empresas da conta dividem). Passou disso, o bot volta a pedir o número.
  BOT_AI_MONTHLY_LIMIT: z.coerce.number().int().positive().default(1500),

  // Transcrição de áudio (API compatível com a da OpenAI: Groq, OpenAI...).
  // Sem a chave, o bot pede para o cliente digitar.
  TRANSCRIBE_API_KEY: z.string().optional(),
  TRANSCRIBE_API_URL: z.string().default('https://api.groq.com/openai/v1'),
  TRANSCRIBE_MODEL: z.string().default('whisper-large-v3-turbo'),
  // Preço por hora de áudio (US$), só para o painel de gastos. Groq whisper-large-v3-turbo: 0.04.
  TRANSCRIBE_USD_PER_HOUR: z.coerce.number().nonnegative().default(0.04),
  // Áudios mais longos que isso não são transcritos (segundos).
  TRANSCRIBE_MAX_SECONDS: z.coerce.number().int().positive().default(120),

  // E-mail (recuperação de senha). Sem SMTP_HOST o link aparece no terminal.
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_SECURE: bool('false'),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  MAIL_FROM: z.string().optional(),
  APP_URL: z.string().optional(),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error('Variáveis de ambiente inválidas:', parsed.error.flatten().fieldErrors);
  throw new Error('Configuração de ambiente inválida. Verifique o arquivo .env.');
}

export const env = parsed.data;
