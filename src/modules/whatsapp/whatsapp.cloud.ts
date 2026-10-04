import crypto from 'crypto';
import { MessageSender, Prisma, WhatsAppCloudAccount } from '@prisma/client';
import { env } from '../../config/env';
import { decryptSecret, encryptSecret } from '../../lib/crypto';
import { HttpError } from '../../lib/httpError';
import { prisma } from '../../lib/prisma';
import { brDate, toIsoDate } from '../../lib/time';
import { AppointmentWithRelations } from '../appointments/appointments.service';
import { findClientByWhatsApp, handleIncomingMessage, handleMessageFromPhone, logMessage } from './whatsapp.bot';

// WhatsApp pela API oficial da Meta (Cloud API). A empresa conecta o próprio
// número de duas formas, na tela WhatsApp:
// - cadastro incorporado (Embedded Signup): o frontend abre o popup da Meta e
//   manda para cá o código de autorização e os IDs da conta (WABA) e do
//   número. Exige o app da Sysora verificado como provedor de tecnologia;
// - manual: a empresa cria o próprio app na Meta e cola as credenciais
//   (connectManual). O webhook chega na URL própria da empresa, assinado com
//   o segredo do app dela.
// Nos dois casos a conta é da empresa e a Meta cobra as mensagens direto dela
// (cartão no WhatsApp Manager). Diferenças para o QR Code (whatsapp.connection.ts):
// - mensagens chegam pelo webhook (POST /api/webhooks/whatsapp), não por socket;
// - texto livre só até 24 h depois da última mensagem do cliente. Fora dessa
//   janela, só templates aprovados pela Meta (usados nos lembretes);
// - cada mensagem entregue tem uma categoria de preço (pricing no webhook),
//   somada em whatsapp_usage para a tela de consumo.

const graphUrl = (path: string) => `https://graph.facebook.com/${env.META_GRAPH_VERSION}/${path}`;
const WINDOW_MS = 24 * 60 * 60 * 1000;
const TEMPLATE_LANGUAGE = 'pt_BR';
export const WHATSAPP_MANAGER_URL = 'https://business.facebook.com/wa/manage/home/';

export const cloudEnabled = () => Boolean(env.META_APP_ID && env.META_APP_SECRET && env.META_CONFIG_ID);

// Dados públicos para o frontend abrir o popup da Meta (nenhum é segredo).
export function cloudConfig() {
  return { enabled: cloudEnabled(), appId: env.META_APP_ID ?? null, configId: env.META_CONFIG_ID ?? null, graphVersion: env.META_GRAPH_VERSION };
}

// ============ Chamadas à Graph API ============

class GraphApiError extends Error {
  constructor(message: string, readonly code?: number) {
    super(message);
  }
}

type GraphErrorBody = { error?: { message?: string; code?: number; error_user_msg?: string; error_data?: { details?: string } } };

async function graph<T>(path: string, token: string, init: { method?: string; body?: unknown; query?: Record<string, string> } = {}): Promise<T> {
  const url = new URL(graphUrl(path));
  for (const [key, value] of Object.entries(init.query ?? {})) url.searchParams.set(key, value);
  const response = await fetch(url, {
    method: init.method ?? 'GET',
    headers: { Authorization: `Bearer ${token}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const json = (await response.json().catch(() => ({}))) as T & GraphErrorBody;
  if (!response.ok) {
    const error = json.error;
    throw new GraphApiError(error?.error_user_msg || error?.error_data?.details || error?.message || `HTTP ${response.status}`, error?.code);
  }
  return json;
}

function friendlyError(err: unknown, action: string): HttpError {
  if (err instanceof HttpError) return err;
  const code = err instanceof GraphApiError ? err.code : undefined;
  if (code === 190) return HttpError.badRequest('A autorização da Meta não vale mais. Conecte o número de novo na tela WhatsApp.');
  if (code === 133005) return HttpError.badRequest('Este número já tem um PIN de verificação em duas etapas. Desative o PIN no WhatsApp Manager e tente conectar de novo.');
  const detail = err instanceof Error ? err.message : String(err);
  return HttpError.badRequest(`${action}: ${detail}`);
}

// Código do popup -> token de integração da empresa (não expira).
async function exchangeCode(code: string): Promise<string> {
  const url = new URL(graphUrl('oauth/access_token'));
  url.searchParams.set('client_id', env.META_APP_ID!);
  url.searchParams.set('client_secret', env.META_APP_SECRET!);
  url.searchParams.set('code', code);
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  const json = (await response.json().catch(() => ({}))) as { access_token?: string } & GraphErrorBody;
  if (!response.ok || !json.access_token) {
    throw HttpError.badRequest(`A Meta não aceitou a autorização (${json.error?.message ?? `HTTP ${response.status}`}). Tente conectar de novo.`);
  }
  return json.access_token;
}

// ============ Conta conectada ============

// Lida a cada mensagem e a cada lembrete: guarda por alguns segundos.
const CACHE_MS = 30_000;
const accountCache = new Map<string, { account: WhatsAppCloudAccount | null; at: number }>();

export async function getCloudAccount(companyId: string): Promise<WhatsAppCloudAccount | null> {
  const hit = accountCache.get(companyId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.account;
  const account = await prisma.whatsAppCloudAccount.findUnique({ where: { companyId } });
  accountCache.set(companyId, { account, at: Date.now() });
  return account;
}

const forget = (companyId: string) => {
  accountCache.delete(companyId);
  healthCache.delete(companyId);
};
const tokenOf = (account: WhatsAppCloudAccount) => decryptSecret(account.accessToken);
const digits = (value: string) => value.replace(/\D/g, '');

async function requireAccount(companyId: string): Promise<WhatsAppCloudAccount> {
  const account = await getCloudAccount(companyId);
  if (!account) throw HttpError.badRequest('O WhatsApp oficial não está conectado. Conecte o número na tela WhatsApp da Sysora.');
  return account;
}

async function setConnectedFlag(companyId: string, connected: boolean, phone: string | null) {
  await prisma.companySettings.upsert({
    where: { companyId },
    update: { whatsappConnected: connected, whatsappPhone: phone },
    create: { companyId, whatsappConnected: connected, whatsappPhone: phone },
  });
}

export type OnboardInput = {
  code: string;
  wabaId: string;
  phoneNumberId: string;
  businessId?: string | null;
  // Número que já usa o app WhatsApp Business e continua nele (não registra de novo).
  coexistence: boolean;
};

// Etapas do provedor de tecnologia depois do popup: token, webhook da conta,
// registro do número na Cloud API e templates dos lembretes.
export async function onboard(companyId: string, input: OnboardInput) {
  if (!cloudEnabled()) throw HttpError.badRequest('A API oficial do WhatsApp ainda não está configurada neste servidor.');
  const taken = await prisma.whatsAppCloudAccount.findUnique({ where: { phoneNumberId: input.phoneNumberId } });
  if (taken && taken.companyId !== companyId) throw HttpError.conflict('Este número já está conectado a outra empresa na Sysora.');

  const token = await exchangeCode(input.code);
  let pin: string | null = null;
  let phone: { display_phone_number?: string; verified_name?: string };
  try {
    await graph(`${input.wabaId}/subscribed_apps`, token, { method: 'POST' });
    if (!input.coexistence) {
      pin = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
      await graph(`${input.phoneNumberId}/register`, token, { method: 'POST', body: { messaging_product: 'whatsapp', pin } });
    }
    phone = await graph(input.phoneNumberId, token, { query: { fields: 'display_phone_number,verified_name' } });
  } catch (err) {
    throw friendlyError(err, 'Não foi possível concluir a conexão com a Meta');
  }

  const data = {
    wabaId: input.wabaId,
    phoneNumberId: input.phoneNumberId,
    businessId: input.businessId ?? null,
    accessToken: encryptSecret(token),
    pin: pin ? encryptSecret(pin) : null,
    displayPhone: phone.display_phone_number ?? null,
    verifiedName: phone.verified_name ?? null,
    coexistence: input.coexistence,
    manual: false,
    appId: null,
    appSecret: null,
    lastError: null,
    lastErrorAt: null,
  };
  await prisma.whatsAppCloudAccount.upsert({ where: { companyId }, update: data, create: { companyId, ...data } });
  await setConnectedFlag(companyId, true, phone.display_phone_number ? digits(phone.display_phone_number) : null);
  forget(companyId);

  // Os templates podem levar de minutos a horas para a Meta aprovar; a tela mostra a situação.
  await syncTemplates(companyId).catch((err) => console.error('Falha ao criar os templates do WhatsApp:', err));
  return cloudStatus(companyId);
}

// Tira a Sysora da conta (para de receber o webhook). O número e a conta
// continuam da empresa, no WhatsApp Manager.
export async function disconnectCloud(companyId: string): Promise<void> {
  const account = await prisma.whatsAppCloudAccount.findUnique({ where: { companyId } });
  if (!account) return;
  await graph(`${account.wabaId}/subscribed_apps`, tokenOf(account), { method: 'DELETE' }).catch(() => {});
  await prisma.whatsAppCloudAccount.delete({ where: { companyId } });
  await setConnectedFlag(companyId, false, null);
  forget(companyId);
}

// ============ Configuração da plataforma (painel master) ============
// O app da Meta da Sysora, usado pelo cadastro incorporado de todas as empresas.

const PLATFORM_WEBHOOK_FIELDS = ['messages', 'message_template_status_update', 'smb_message_echoes', 'account_update'];

function platformWebhook(requestBase: string) {
  const base = (env.PUBLIC_API_URL ?? requestBase).replace(/\/$/, '');
  return { url: `${base}/api/webhooks/whatsapp`, verifyToken: env.META_WEBHOOK_VERIFY_TOKEN ?? null, fields: PLATFORM_WEBHOOK_FIELDS };
}

export async function platformSetup(requestBase: string) {
  const [official, connected] = await Promise.all([
    prisma.whatsAppCloudAccount.count(),
    prisma.companySettings.count({ where: { whatsappConnected: true } }),
  ]);
  return {
    enabled: cloudEnabled(),
    config: {
      appId: env.META_APP_ID ?? null,
      appSecretSet: Boolean(env.META_APP_SECRET),
      configId: env.META_CONFIG_ID ?? null,
      verifyTokenSet: Boolean(env.META_WEBHOOK_VERIFY_TOKEN),
      publicApiUrl: env.PUBLIC_API_URL ?? null,
      graphVersion: env.META_GRAPH_VERSION,
    },
    webhook: platformWebhook(requestBase),
    companies: { official, qr: Math.max(0, connected - official) },
  };
}

const appToken = () => `${env.META_APP_ID}|${env.META_APP_SECRET}`;

// Confere com a Meta: o app existe com essa chave e o webhook aponta para cá com os campos certos.
export async function checkPlatform(requestBase: string) {
  if (!env.META_APP_ID || !env.META_APP_SECRET) {
    return { app: { ok: false, name: null, error: 'Preencha META_APP_ID e META_APP_SECRET no .env do backend e reinicie.' }, webhook: null };
  }
  let app: { ok: boolean; name: string | null; error: string | null };
  try {
    const info = await graph<{ name?: string }>(env.META_APP_ID, appToken(), { query: { fields: 'name' } });
    app = { ok: true, name: info.name ?? null, error: null };
  } catch {
    return { app: { ok: false, name: null, error: 'A Meta não reconheceu o ID do app com essa chave secreta. Confira META_APP_ID e META_APP_SECRET.' }, webhook: null };
  }

  const expected = platformWebhook(requestBase);
  try {
    const subs = await graph<{ data: { object: string; callback_url: string; active: boolean; fields: { name: string }[] }[] }>(`${env.META_APP_ID}/subscriptions`, appToken());
    const sub = subs.data.find((s) => s.object === 'whatsapp_business_account');
    const fields = sub?.fields.map((f) => f.name) ?? [];
    return {
      app,
      webhook: {
        configured: Boolean(sub?.active),
        callbackUrl: sub?.callback_url ?? null,
        urlMatches: sub?.callback_url === expected.url,
        missingFields: PLATFORM_WEBHOOK_FIELDS.filter((f) => !fields.includes(f)),
      },
    };
  } catch (err) {
    return { app, webhook: { configured: false, callbackUrl: null, urlMatches: false, missingFields: PLATFORM_WEBHOOK_FIELDS, error: err instanceof Error ? err.message : String(err) } };
  }
}

// Cadastra (ou corrige) o webhook do app da Sysora. A Meta testa a URL na hora:
// o backend precisa estar publicado em https (PUBLIC_API_URL).
export async function configurePlatformWebhook(requestBase: string) {
  if (!env.META_APP_ID || !env.META_APP_SECRET) throw HttpError.badRequest('Preencha META_APP_ID e META_APP_SECRET no .env do backend e reinicie.');
  if (!env.META_WEBHOOK_VERIFY_TOKEN) throw HttpError.badRequest('Preencha META_WEBHOOK_VERIFY_TOKEN no .env do backend e reinicie.');
  const hook = platformWebhook(requestBase);
  if (!hook.url.startsWith('https://')) throw HttpError.badRequest('A Meta só aceita webhook em https. Publique o backend e defina PUBLIC_API_URL no .env.');
  try {
    await graph(`${env.META_APP_ID}/subscriptions`, appToken(), {
      method: 'POST',
      body: { object: 'whatsapp_business_account', callback_url: hook.url, verify_token: hook.verifyToken, fields: hook.fields.join(','), include_values: true },
    });
  } catch (err) {
    throw HttpError.badRequest(`A Meta não aceitou o webhook: ${err instanceof Error ? err.message : String(err)}. Confira se ${hook.url} abre pela internet.`);
  }
  return checkPlatform(requestBase);
}

// ============ Conexão manual (app da Meta da própria empresa) ============
// Sem a Sysora verificada como provedor de tecnologia: a empresa cria o app
// dela na Meta, gera um token permanente (usuário do sistema) e cola aqui. O
// Sysora confere tudo, registra o número, assina a conta e tenta configurar o
// webhook no app dela (precisa deste backend acessível pela internet).

const WEBHOOK_FIELDS = ['messages', 'message_template_status_update', 'account_update'];
const REQUIRED_SCOPES = ['whatsapp_business_messaging', 'whatsapp_business_management'];

export function webhookVerifyToken(companyId: string): string {
  return crypto.createHmac('sha256', env.JWT_REFRESH_SECRET).update(`whatsapp-webhook:${companyId}`).digest('hex').slice(0, 32);
}

// requestBase: endereço pelo qual a requisição chegou, se PUBLIC_API_URL não estiver definido.
export function manualWebhook(companyId: string, requestBase: string) {
  const base = (env.PUBLIC_API_URL ?? requestBase).replace(/\/$/, '');
  return { url: `${base}/api/webhooks/whatsapp/${companyId}`, verifyToken: webhookVerifyToken(companyId), fields: WEBHOOK_FIELDS };
}

export type ManualInput = { appId: string; appSecret: string; accessToken: string; wabaId: string; phoneNumberId: string };

function manualError(err: unknown, fallback: string): HttpError {
  if (err instanceof HttpError) return err;
  const code = err instanceof GraphApiError ? err.code : undefined;
  if (code === 190) return HttpError.badRequest('O token de acesso é inválido ou expirou. Gere um token permanente pelo usuário do sistema (passo 4).');
  if (code === 100 || code === 200 || code === 10) {
    return HttpError.badRequest('O token não tem acesso a esse número ou conta. Confira os IDs e se o usuário do sistema recebeu o app e a conta do WhatsApp como ativos, com controle total.');
  }
  return friendlyError(err, fallback);
}

export async function connectManual(companyId: string, input: ManualInput, requestBase: string) {
  const taken = await prisma.whatsAppCloudAccount.findUnique({ where: { phoneNumberId: input.phoneNumberId } });
  if (taken && taken.companyId !== companyId) throw HttpError.conflict('Este número já está conectado a outra empresa na Sysora.');
  const appToken = `${input.appId}|${input.appSecret}`;

  // 1. O ID e a chave secreta são do mesmo app.
  try {
    await graph(input.appId, appToken, { query: { fields: 'id' } });
  } catch {
    throw HttpError.badRequest('O ID do app ou a chave secreta não conferem. Copie os dois de novo em Configurações do app > Básico.');
  }

  // 2. O token é permanente, é desse app e tem as permissões do WhatsApp.
  let tokenInfo: { app_id?: string; is_valid?: boolean; expires_at?: number; scopes?: string[] };
  try {
    ({ data: tokenInfo } = await graph<{ data: typeof tokenInfo }>('debug_token', appToken, { query: { input_token: input.accessToken } }));
  } catch (err) {
    throw manualError(err, 'Não foi possível conferir o token');
  }
  if (!tokenInfo.is_valid) throw HttpError.badRequest('O token de acesso é inválido ou expirou. Gere um token permanente pelo usuário do sistema (passo 4).');
  if (tokenInfo.app_id !== input.appId) throw HttpError.badRequest('Esse token foi gerado para outro app. Gere o token escolhendo o mesmo app do ID informado.');
  if (tokenInfo.expires_at) throw HttpError.badRequest('Esse token é temporário (vence em poucas horas). Gere um token permanente pelo usuário do sistema, com validade "Nunca" (passo 4).');
  const missing = REQUIRED_SCOPES.filter((s) => !tokenInfo.scopes?.includes(s));
  if (missing.length) throw HttpError.badRequest(`Faltam permissões no token: ${missing.join(', ')}. Gere o token de novo marcando as duas.`);

  // 3. O número é dessa conta do WhatsApp Business.
  let phone: { display_phone_number?: string; verified_name?: string; platform_type?: string };
  try {
    const numbers = await graph<{ data: { id: string }[] }>(`${input.wabaId}/phone_numbers`, input.accessToken, { query: { fields: 'id', limit: '100' } });
    if (!numbers.data.some((n) => n.id === input.phoneNumberId)) {
      throw HttpError.badRequest('Esse número não pertence a essa conta do WhatsApp Business. Confira os dois IDs em WhatsApp > Configuração da API.');
    }
    phone = await graph(input.phoneNumberId, input.accessToken, { query: { fields: 'display_phone_number,verified_name,platform_type' } });
  } catch (err) {
    throw manualError(err, 'Não foi possível acessar o número');
  }

  // 4. Número adicionado pelo painel ainda não registrado na Cloud API: registra com um PIN novo.
  let pin: string | null = null;
  try {
    if (phone.platform_type !== 'CLOUD_API') {
      pin = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
      await graph(`${input.phoneNumberId}/register`, input.accessToken, { method: 'POST', body: { messaging_product: 'whatsapp', pin } });
    }
    // 5. O app da empresa passa a receber os eventos da conta.
    await graph(`${input.wabaId}/subscribed_apps`, input.accessToken, { method: 'POST' });
  } catch (err) {
    throw manualError(err, 'Não foi possível ativar o número na API');
  }

  const data = {
    wabaId: input.wabaId,
    phoneNumberId: input.phoneNumberId,
    businessId: null,
    accessToken: encryptSecret(input.accessToken),
    pin: pin ? encryptSecret(pin) : null,
    displayPhone: phone.display_phone_number ?? null,
    verifiedName: phone.verified_name ?? null,
    coexistence: false,
    manual: true,
    appId: input.appId,
    appSecret: encryptSecret(input.appSecret),
    lastError: null,
    lastErrorAt: null,
    lastWebhookAt: null,
  };
  await prisma.whatsAppCloudAccount.upsert({ where: { companyId }, update: data, create: { companyId, ...data } });
  await setConnectedFlag(companyId, true, phone.display_phone_number ? digits(phone.display_phone_number) : null);
  forget(companyId);

  // 6. Webhook no app da empresa. A Meta testa a URL na hora: se este backend
  // não estiver acessível pela internet, a tela mostra como configurar à mão.
  const hook = manualWebhook(companyId, requestBase);
  let webhookError: string | null = null;
  try {
    await graph(`${input.appId}/subscriptions`, appToken, {
      method: 'POST',
      body: { object: 'whatsapp_business_account', callback_url: hook.url, verify_token: hook.verifyToken, fields: hook.fields.join(','), include_values: true },
    });
  } catch (err) {
    webhookError = err instanceof Error ? err.message : String(err);
  }

  await syncTemplates(companyId).catch((err) => console.error('Falha ao criar os templates do WhatsApp:', err));
  return { webhookConfigured: !webhookError, webhookError };
}

// Situação da conta na Meta para o checklist da tela: forma de pagamento,
// nome de exibição e qualidade do número. Consulta a Meta no máximo a cada
// 5 minutos (a tela atualiza o status a cada 15 s); campo que não der para
// ler fica nulo, sem quebrar o status.
type AccountHealth = {
  paymentConfigured: boolean | null;
  nameStatus: string | null;
  qualityRating: string | null;
  businessVerification: string | null;
};
const HEALTH_CACHE_MS = 5 * 60 * 1000;
const healthCache = new Map<string, { health: AccountHealth; at: number }>();

async function accountHealth(account: WhatsAppCloudAccount): Promise<AccountHealth> {
  const hit = healthCache.get(account.companyId);
  if (hit && Date.now() - hit.at < HEALTH_CACHE_MS) return hit.health;
  const token = tokenOf(account);
  const [waba, phone] = await Promise.all([
    graph<{ primary_funding_id?: string; business_verification_status?: string }>(account.wabaId, token, { query: { fields: 'primary_funding_id,business_verification_status' } }).catch(() => null),
    graph<{ name_status?: string; quality_rating?: string }>(account.phoneNumberId, token, { query: { fields: 'name_status,quality_rating' } }).catch(() => null),
  ]);
  const health: AccountHealth = {
    paymentConfigured: waba ? Boolean(waba.primary_funding_id) : null,
    nameStatus: phone?.name_status ?? null,
    qualityRating: phone?.quality_rating ?? null,
    businessVerification: waba?.business_verification_status ?? null,
  };
  healthCache.set(account.companyId, { health, at: Date.now() });
  return health;
}

// "Atualizar situação" na tela: consulta a Meta de novo na próxima leitura.
export const refreshHealth = (companyId: string) => healthCache.delete(companyId);

export async function cloudStatus(companyId: string, requestBase = '') {
  const account = await prisma.whatsAppCloudAccount.findUnique({ where: { companyId } });
  if (!account) return null;
  return {
    health: await accountHealth(account),
    phone: account.displayPhone ? digits(account.displayPhone) : null,
    verifiedName: account.verifiedName,
    wabaId: account.wabaId,
    phoneNumberId: account.phoneNumberId,
    coexistence: account.coexistence,
    manual: account.manual,
    appId: account.appId,
    // Conexão manual: dados para configurar o webhook no app da empresa, se precisar.
    webhook: account.manual ? manualWebhook(companyId, requestBase) : null,
    lastWebhookAt: account.lastWebhookAt,
    templates: REMINDER_TEMPLATES.map((t) => ({ name: t.name, label: t.label, status: templateStatus(account, t.kind) })),
    lastError: account.lastError,
    lastErrorAt: account.lastErrorAt,
    connectedAt: account.createdAt,
    managerUrl: WHATSAPP_MANAGER_URL,
  };
}

// ============ Envio ============

// Cliente que veio da conexão por QR Code com o número escondido pelo WhatsApp
// (id anônimo, termina em @lid): a API oficial só envia para números.
export const HIDDEN_NUMBER_ERROR = 'O WhatsApp não mostrou o número deste cliente (ele veio da conexão antiga por QR Code). Informe o telefone dele na ficha do cliente.';

export async function sendCloudText(companyId: string, contact: string, text: string): Promise<void> {
  if (contact.includes('@')) throw HttpError.badRequest(HIDDEN_NUMBER_ERROR);
  const account = await requireAccount(companyId);
  try {
    await graph(`${account.phoneNumberId}/messages`, tokenOf(account), {
      method: 'POST',
      body: { messaging_product: 'whatsapp', recipient_type: 'individual', to: digits(contact), type: 'text', text: { body: text.slice(0, 4096), preview_url: false } },
    });
  } catch (err) {
    throw friendlyError(err, 'O WhatsApp não aceitou a mensagem');
  }
}

// Até quando a API aceita texto livre para o cliente: 24 h depois da última
// mensagem dele (um minuto de folga para não chegar já fora da janela).
export async function customerWindowEndsAt(companyId: string, clientId: string): Promise<Date | null> {
  const last = await prisma.message.findFirst({
    where: { companyId, clientId, sender: MessageSender.CLIENT },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  });
  return last ? new Date(last.createdAt.getTime() + WINDOW_MS - 60_000) : null;
}

export async function customerWindowOpen(companyId: string, clientId: string): Promise<boolean> {
  const endsAt = await customerWindowEndsAt(companyId, clientId);
  return Boolean(endsAt && endsAt.getTime() > Date.now());
}

// Mensagem recebida: marca como lida (tiques azuis) e mostra "digitando..."
// para o cliente enquanto o bot prepara a resposta (some ao responder ou em 25 s).
async function markReadAndTyping(account: WhatsAppCloudAccount, messageId: string): Promise<void> {
  await graph(`${account.phoneNumberId}/messages`, tokenOf(account), {
    method: 'POST',
    body: { messaging_product: 'whatsapp', status: 'read', message_id: messageId, typing_indicator: { type: 'text' } },
  });
}

// ============ Templates dos lembretes ============

export type ReminderKind = 'day' | 'hour';

// Fora da janela de 24 h os lembretes só podem sair como template aprovado
// (categoria Utilidade). O texto é fixo; o que a empresa escreveu em
// Lembretes vale quando o cliente conversou nas últimas 24 h.
const REMINDER_TEMPLATES: { kind: ReminderKind; name: string; label: string; body: string; example: string[]; buttons?: string[] }[] = [
  {
    kind: 'day',
    name: 'sysora_lembrete_vespera',
    label: 'Lembrete da véspera',
    body: 'Olá, {{1}}! Passando para lembrar do seu horário amanhã em {{2}}: {{3}} no dia {{4}} às {{5}}. Você confirma?',
    example: ['Maria', 'Barbearia Exemplo', 'Corte de cabelo', '10/10', '14:00'],
    // O bot entende as respostas dos botões como as opções 1, 2 e 3 da confirmação.
    buttons: ['Confirmar', 'Remarcar', 'Cancelar'],
  },
  {
    kind: 'hour',
    name: 'sysora_lembrete_horario',
    label: 'Aviso pouco antes do horário',
    body: 'Oi, {{1}}! Seu horário em {{2}} é hoje às {{3}}: {{4}}. Te esperamos!',
    example: ['Maria', 'Barbearia Exemplo', '14:00', 'Corte de cabelo'],
  },
];

const templateOf = (kind: ReminderKind) => REMINDER_TEMPLATES.find((t) => t.kind === kind)!;
const templateStatus = (account: WhatsAppCloudAccount, kind: ReminderKind) =>
  ((account.templates ?? {}) as Record<string, string>)[templateOf(kind).name] ?? 'MISSING';
export const templateApproved = (account: WhatsAppCloudAccount, kind: ReminderKind) => templateStatus(account, kind) === 'APPROVED';

async function saveTemplateStatus(companyId: string, statuses: Record<string, string>) {
  await prisma.whatsAppCloudAccount.update({ where: { companyId }, data: { templates: statuses as Prisma.InputJsonValue } });
  forget(companyId);
}

// Cria na conta da empresa os templates que faltam e atualiza a situação de todos.
export async function syncTemplates(companyId: string) {
  const account = await requireAccount(companyId);
  refreshHealth(companyId);
  const token = tokenOf(account);
  try {
    const existing = await graph<{ data: { name: string; language: string; status: string }[] }>(`${account.wabaId}/message_templates`, token, {
      query: { fields: 'name,language,status', limit: '200' },
    });
    const statuses: Record<string, string> = {};
    for (const template of REMINDER_TEMPLATES) {
      const found = existing.data.find((t) => t.name === template.name && t.language === TEMPLATE_LANGUAGE);
      if (found) {
        statuses[template.name] = found.status;
        continue;
      }
      const created = await graph<{ status?: string }>(`${account.wabaId}/message_templates`, token, {
        method: 'POST',
        body: {
          name: template.name,
          language: TEMPLATE_LANGUAGE,
          category: 'UTILITY',
          components: [
            { type: 'BODY', text: template.body, example: { body_text: [template.example] } },
            ...(template.buttons ? [{ type: 'BUTTONS', buttons: template.buttons.map((text) => ({ type: 'QUICK_REPLY', text })) }] : []),
          ],
        },
      });
      statuses[template.name] = created.status ?? 'PENDING';
    }
    await saveTemplateStatus(companyId, statuses);
  } catch (err) {
    throw friendlyError(err, 'Não foi possível atualizar os templates na Meta');
  }
  return cloudStatus(companyId);
}

// Parâmetro de template não aceita quebra de linha, tab nem muitos espaços seguidos.
const param = (value: string) => value.replace(/[\n\t]+/g, ' ').replace(/ {4,}/g, '   ').trim().slice(0, 200) || '-';

function reminderParams(kind: ReminderKind, appointment: AppointmentWithRelations, companyName: string): string[] {
  const name = appointment.client.name.trim().split(/\s+/)[0] || 'tudo bem';
  const services = appointment.items.map((i) => i.name).join(' + ') || 'Atendimento';
  return kind === 'day'
    ? [name, companyName, services, brDate(appointment.date), appointment.startTime]
    : [name, companyName, appointment.startTime, services];
}

// Envia o template do lembrete e devolve o texto como o cliente vê (para a conversa).
export async function sendReminderTemplate(companyId: string, kind: ReminderKind, appointment: AppointmentWithRelations, companyName: string): Promise<string> {
  const account = await requireAccount(companyId);
  const template = templateOf(kind);
  const params = reminderParams(kind, appointment, companyName).map(param);
  try {
    await graph(`${account.phoneNumberId}/messages`, tokenOf(account), {
      method: 'POST',
      body: {
        messaging_product: 'whatsapp',
        to: digits(appointment.client.whatsappId!),
        type: 'template',
        template: {
          name: template.name,
          language: { code: TEMPLATE_LANGUAGE },
          components: [{ type: 'body', parameters: params.map((text) => ({ type: 'text', text })) }],
        },
      },
    });
  } catch (err) {
    throw friendlyError(err, 'O WhatsApp não aceitou o lembrete');
  }
  const text = template.body.replace(/\{\{(\d+)\}\}/g, (_, n: string) => params[Number(n) - 1] ?? '');
  return template.buttons ? `${text}\n\n[${template.buttons.join('] [')}]` : text;
}

// ============ Consumo do mês ============

const monthKey = (date = new Date()) => toIsoDate(date).slice(0, 7);
type Category = 'service' | 'utility' | 'marketing' | 'authentication';

function categoryOf(value: string | undefined): Category | null {
  if (!value) return null;
  if (value.startsWith('marketing')) return 'marketing';
  if (value.startsWith('authentication')) return 'authentication';
  if (value === 'utility' || value === 'service') return value;
  return null;
}

type Pricing = { billable?: boolean; category?: string; type?: string; pricing_model?: string };

async function recordDelivered(companyId: string, pricing: Pricing) {
  const category = categoryOf(pricing.category);
  // Mensagens na janela grátis de anúncio (free_entry_point) não contam na cota.
  if (!category || pricing.type === 'free_entry_point') return;
  const billable = pricing.billable ? 1 : 0;
  await prisma.whatsAppUsage.upsert({
    where: { companyId_month: { companyId, month: monthKey() } },
    update: { [`${category}Total`]: { increment: 1 }, [`${category}Billable`]: { increment: billable } },
    create: { companyId, month: monthKey(), [`${category}Total`]: 1, [`${category}Billable`]: billable },
  });
}

export async function usageOf(companyId: string) {
  const month = monthKey();
  const row = await prisma.whatsAppUsage.findUnique({ where: { companyId_month: { companyId, month } } });
  const count = (category: Category) => ({ total: row?.[`${category}Total`] ?? 0, billable: row?.[`${category}Billable`] ?? 0 });
  const prices: Record<Category, number> = {
    service: env.WHATSAPP_PRICE_SERVICE_BRL,
    utility: env.WHATSAPP_PRICE_UTILITY_BRL,
    marketing: env.WHATSAPP_PRICE_MARKETING_BRL,
    authentication: env.WHATSAPP_PRICE_AUTHENTICATION_BRL,
  };
  const categories = { service: count('service'), utility: count('utility'), marketing: count('marketing'), authentication: count('authentication') };
  const estimated = (Object.keys(categories) as Category[]).reduce((sum, c) => sum + categories[c].billable * prices[c], 0);
  return {
    month,
    freeLimit: env.WHATSAPP_FREE_SERVICE_MONTHLY,
    freeUsed: Math.min(categories.service.total, env.WHATSAPP_FREE_SERVICE_MONTHLY),
    ...categories,
    estimatedCents: Math.round(estimated * 100),
    prices,
  };
}

// ============ Webhook ============

function checkSignature(secret: string | undefined, rawBody: Buffer | undefined, header: string | undefined): boolean {
  if (!secret || !rawBody || !header?.startsWith('sha256=')) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const given = header.slice('sha256='.length);
  return given.length === expected.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

// Webhook do app da Sysora (cadastro incorporado).
export const verifySignature = (rawBody: Buffer | undefined, header: string | undefined) => checkSignature(env.META_APP_SECRET, rawBody, header);

// Webhook do app da própria empresa (conexão manual), assinado com o segredo do app dela.
export async function verifyCompanySignature(companyId: string, rawBody: Buffer | undefined, header: string | undefined): Promise<boolean> {
  const account = await prisma.whatsAppCloudAccount.findUnique({ where: { companyId } });
  if (!account?.manual || !account.appSecret) return false;
  return checkSignature(decryptSecret(account.appSecret), rawBody, header);
}

// Marca que o webhook da empresa está chegando (no máximo uma escrita por minuto).
const webhookSeenAt = new Map<string, number>();
export async function markWebhookReceived(companyId: string): Promise<void> {
  if (Date.now() - (webhookSeenAt.get(companyId) ?? 0) < 60_000) return;
  webhookSeenAt.set(companyId, Date.now());
  await prisma.whatsAppCloudAccount.updateMany({ where: { companyId }, data: { lastWebhookAt: new Date() } });
}

// A Meta reenvia o webhook se não recebe 200 a tempo: não conta o mesmo status duas vezes.
const seenStatuses = new Set<string>();
function alreadySeen(key: string): boolean {
  if (seenStatuses.has(key)) return true;
  seenStatuses.add(key);
  if (seenStatuses.size > 5000) seenStatuses.delete(seenStatuses.values().next().value!);
  return false;
}

// Erros de envio que são da conta (e não do cliente final): aparecem na tela WhatsApp.
const ACCOUNT_ERRORS: Record<number, string> = {
  131042: 'A Meta recusou mensagens por um problema de pagamento. Cadastre ou atualize a forma de pagamento no WhatsApp Manager.',
  131031: 'A Meta bloqueou a conta do WhatsApp. Veja os detalhes no WhatsApp Manager.',
  131048: 'A Meta limitou os envios porque muitas mensagens foram bloqueadas ou denunciadas pelos clientes.',
  131056: 'Muitas mensagens para o mesmo cliente em pouco tempo. Aguarde alguns minutos.',
  368: 'A Meta restringiu a conta por violar as políticas do WhatsApp. Veja os detalhes no WhatsApp Manager.',
};

// Motivos de não entrega ligados ao cliente final, em português para a conversa.
const DELIVERY_ERRORS: Record<number, string> = {
  131047: 'passaram mais de 24 horas desde a última mensagem do cliente. Espere ele escrever de novo.',
  131026: 'o número não pode receber mensagens (não tem WhatsApp, bloqueou a empresa ou está com o app desatualizado).',
  131049: 'a Meta limitou mensagens para este cliente para evitar excesso de contatos.',
  131051: 'tipo de mensagem não suportado.',
  131053: 'não foi possível enviar o arquivo.',
  131021: 'o destinatário é o próprio número da empresa.',
  132001: 'o template ainda não existe ou não foi aprovado.',
  132015: 'o template foi pausado pela Meta por baixa qualidade.',
  132016: 'o template foi desativado pela Meta.',
};

const MEDIA_TYPES: Record<string, string> = {
  image: 'image', audio: 'audio', video: 'video', document: 'document', sticker: 'sticker', location: 'location', contacts: 'contact',
};
const IGNORED_TYPES = new Set(['reaction', 'system', 'request_welcome']);
// Bytes por segundo de um áudio de voz do WhatsApp (Opus), para respeitar
// TRANSCRIBE_MAX_SECONDS: a Cloud API não informa a duração.
const AUDIO_BYTES_PER_SECOND = 4000;

type IncomingMessage = {
  from: string;
  id: string;
  type: string;
  text?: { body?: string };
  button?: { text?: string };
  interactive?: { button_reply?: { title?: string }; list_reply?: { title?: string } };
  image?: { caption?: string };
  video?: { caption?: string };
  document?: { caption?: string };
  audio?: { id: string; mime_type?: string };
};

type MessagesValue = {
  metadata?: { phone_number_id?: string };
  contacts?: { wa_id?: string; profile?: { name?: string } }[];
  messages?: IncomingMessage[];
  statuses?: { id: string; status: string; recipient_id?: string; pricing?: Pricing; errors?: { code?: number; title?: string; message?: string }[] }[];
  message_echoes?: { to?: string; type?: string; text?: { body?: string } }[];
};

type WebhookPayload = { object?: string; entry?: { id?: string; changes?: { field?: string; value?: unknown }[] }[] };

async function downloadMedia(account: WhatsAppCloudAccount, mediaId: string): Promise<Buffer> {
  const token = tokenOf(account);
  const media = await graph<{ url: string }>(mediaId, token);
  const response = await fetch(media.url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Download da mídia falhou (${response.status}).`);
  return Buffer.from(await response.arrayBuffer());
}

// scope: empresa dona do webhook (conexão manual). O app de uma empresa só
// pode mexer no número dela, mesmo que o evento cite o número de outra.
async function accountByPhoneNumberId(phoneNumberId: string | undefined, scope: string | null) {
  const account = phoneNumberId ? await prisma.whatsAppCloudAccount.findUnique({ where: { phoneNumberId } }) : null;
  if (!account || (scope && account.companyId !== scope) || (!scope && account.manual)) return null;
  return account;
}

async function handleMessages(value: MessagesValue, scope: string | null) {
  const account = await accountByPhoneNumberId(value.metadata?.phone_number_id, scope);
  if (!account) return;
  // Marca o checklist "teste feito" (e, na conexão manual, que o webhook chega).
  markWebhookReceived(account.companyId).catch(() => {});

  for (const message of value.messages ?? []) {
    if (IGNORED_TYPES.has(message.type)) continue;
    const text = (
      message.text?.body
      ?? message.button?.text
      ?? message.interactive?.button_reply?.title
      ?? message.interactive?.list_reply?.title
      ?? message.image?.caption
      ?? message.video?.caption
      ?? message.document?.caption
    )?.trim() || null;
    const audio = message.audio;
    await handleIncomingMessage({
      companyId: account.companyId,
      contactId: message.from,
      messageId: message.id,
      text,
      mediaType: MEDIA_TYPES[message.type],
      audio: audio ? {
        seconds: 0,
        mimetype: audio.mime_type ?? 'audio/ogg',
        load: async () => {
          const buffer = await downloadMedia(account, audio.id);
          if (buffer.length > env.TRANSCRIBE_MAX_SECONDS * AUDIO_BYTES_PER_SECOND) throw new Error('Áudio longo demais para transcrever.');
          return buffer;
        },
      } : undefined,
      profileName: value.contacts?.find((c) => c.wa_id === message.from)?.profile?.name,
      send: (reply) => sendCloudText(account.companyId, message.from, reply),
      typing: () => markReadAndTyping(account, message.id),
    });
  }

  for (const status of value.statuses ?? []) {
    if (alreadySeen(`${status.id}:${status.status}`)) continue;
    if (status.status === 'delivered' && status.pricing) {
      await recordDelivered(account.companyId, status.pricing);
      // Mensagem paga entregue: o problema de pagamento (se havia) foi resolvido.
      if (status.pricing.billable) {
        const cleared = await prisma.whatsAppCloudAccount.updateMany({
          where: { companyId: account.companyId, lastError: ACCOUNT_ERRORS[131042] },
          data: { lastError: null, lastErrorAt: null },
        });
        if (cleared.count) forget(account.companyId);
      }
    }
    if (status.status === 'failed') {
      const error = status.errors?.[0];
      const accountError = error?.code ? ACCOUNT_ERRORS[error.code] : undefined;
      if (accountError) {
        await prisma.whatsAppCloudAccount.update({ where: { companyId: account.companyId }, data: { lastError: accountError, lastErrorAt: new Date() } });
        forget(account.companyId);
      }
      console.error(`WhatsApp oficial: mensagem para ${status.recipient_id} falhou (${error?.code} ${error?.title ?? ''} ${error?.message ?? ''}).`);
      // Avisa na conversa do cliente, para a equipe saber que ele não recebeu.
      const client = status.recipient_id ? await findClientByWhatsApp(account.companyId, status.recipient_id) : null;
      if (client) {
        const reason = (error?.code && (DELIVERY_ERRORS[error.code] ?? ACCOUNT_ERRORS[error.code])) || error?.title || 'motivo não informado pela Meta';
        await logMessage(account.companyId, client.id, `⚠️ O WhatsApp não entregou a mensagem anterior: ${reason}`, MessageSender.BOT);
      }
    }
  }
}

// Coexistência: a equipe respondeu pelo app WhatsApp Business do celular.
async function handleEchoes(value: MessagesValue, scope: string | null) {
  const account = await accountByPhoneNumberId(value.metadata?.phone_number_id, scope);
  if (!account) return;
  for (const echo of value.message_echoes ?? []) {
    const text = echo.text?.body?.trim();
    if (echo.to && text) await handleMessageFromPhone(account.companyId, echo.to, text);
  }
}

async function handleTemplateStatus(wabaId: string, value: { event?: string; message_template_name?: string; message_template_language?: string }, scope: string | null) {
  if (!value.message_template_name || !value.event || (value.message_template_language && value.message_template_language !== TEMPLATE_LANGUAGE)) return;
  // Atualiza só a chave do template, no banco: a Meta pode avisar de dois templates ao mesmo tempo.
  const updated = await prisma.$queryRaw<{ companyId: string }[]>`
    UPDATE whatsapp_cloud_accounts
    SET templates = templates || jsonb_build_object(${value.message_template_name}::text, ${value.event}::text), "updatedAt" = now()
    WHERE "wabaId" = ${wabaId}
      AND (CASE WHEN ${scope}::text IS NULL THEN NOT manual ELSE "companyId" = ${scope}::text END)
    RETURNING "companyId"`;
  updated.forEach((row) => forget(row.companyId));
}

// A empresa tirou a Sysora da conta (ou apagou a conta) pelo lado da Meta.
async function handleAccountUpdate(wabaId: string, value: { event?: string }, scope: string | null) {
  if (value.event !== 'PARTNER_REMOVED' && value.event !== 'ACCOUNT_DELETED') return;
  const accounts = await prisma.whatsAppCloudAccount.findMany({ where: { wabaId, ...(scope ? { companyId: scope } : { manual: false }) } });
  for (const account of accounts) {
    await prisma.whatsAppCloudAccount.delete({ where: { companyId: account.companyId } });
    await setConnectedFlag(account.companyId, false, null);
    forget(account.companyId);
  }
}

// scope = empresa dona do webhook na conexão manual; null = webhook do app da Sysora.
export async function handleWebhook(payload: WebhookPayload, scope: string | null = null): Promise<void> {
  if (payload.object !== 'whatsapp_business_account') return;
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      try {
        if (change.field === 'messages') await handleMessages(change.value as MessagesValue, scope);
        else if (change.field === 'smb_message_echoes') await handleEchoes(change.value as MessagesValue, scope);
        else if (change.field === 'message_template_status_update' && entry.id) await handleTemplateStatus(entry.id, change.value as never, scope);
        else if (change.field === 'account_update' && entry.id) await handleAccountUpdate(entry.id, change.value as never, scope);
      } catch (err) {
        console.error(`Erro processando webhook do WhatsApp (${change.field}):`, err);
      }
    }
  }
}
