import 'dotenv/config';
import { z } from 'zod';

const bool = (fallback: 'true' | 'false') => z.string().default(fallback).transform((value) => value === 'true');

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
  SORA_MODEL: z.string().default('claude-opus-5-5'),
  // Pedidos à Sora por empresa por mês (cada mensagem no chat conta 1).
  SORA_MONTHLY_LIMIT: z.coerce.number().int().positive().default(50),
  // IA do atendimento: entende o que o cliente escreveu quando não é um número
  // nem uma palavra-chave (whatsapp.ai.ts). Modelo barato e rápido; mesma chave da Sora.
  BOT_AI_MODEL: z.string().default('claude-haiku-4-5'),
  // Mensagens interpretadas pela IA por empresa por mês. Passou disso, o bot volta a pedir o número.
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
