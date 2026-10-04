// Proteções contra bloqueio do número na conexão por QR Code (WhatsApp Web).
// O WhatsApp restringe números que se comportam como robô: respostas
// instantâneas, rajadas de mensagens, conversa infinita com outro robô e,
// principalmente, mensagens para quem nunca falou com a empresa (que viram
// denúncias e bloqueios). Tudo aqui fica na memória do processo, que já é
// único por banco (ver whatsapp.connection.ts).

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const jitter = (min: number, max: number) => min + Math.random() * (max - min);

// "Digitando..." proporcional ao tamanho do texto, como uma pessoa rápida.
export function typingDelay(text: string): number {
  return Math.round(Math.min(6_000, 900 + text.length * 30) * jitter(0.85, 1.15));
}

// Intervalo mínimo entre dois envios do mesmo número (qualquer contato).
const MIN_GAP_MS: [number, number] = [900, 2_200];
const nextSlot = new Map<string, number>();

export async function waitSendSlot(companyId: string): Promise<void> {
  const now = Date.now();
  const at = Math.max(now, nextSlot.get(companyId) ?? 0);
  nextSlot.set(companyId, at + jitter(...MIN_GAP_MS));
  if (at > now) await sleep(at - now);
}

// Robô respondendo robô (outra empresa com resposta automática) ou alguém
// disparando mensagens: o bot fica em silêncio com esse contato por um tempo.
const BURST_LIMIT = 8;
const BURST_WINDOW_MS = 60_000;
const MUTE_MS = 15 * 60_000;
const incoming = new Map<string, number[]>();
const mutedUntil = new Map<string, number>();

export function shouldStaySilent(companyId: string, contactId: string, now = Date.now()): boolean {
  const key = `${companyId}:${contactId}`;
  if ((mutedUntil.get(key) ?? 0) > now) return true;
  const recent = (incoming.get(key) ?? []).filter((t) => now - t < BURST_WINDOW_MS);
  recent.push(now);
  incoming.set(key, recent);
  if (recent.length <= BURST_LIMIT) return false;
  mutedUntil.set(key, now + MUTE_MS);
  incoming.delete(key);
  // eslint-disable-next-line no-console
  console.warn(`WhatsApp: ${contactId} mandou mais de ${BURST_LIMIT} mensagens em 1 min; bot em silêncio por 15 min (empresa ${companyId}).`);
  return true;
}

// Lembrete para cliente que nunca escreveu para a empresa (cadastrado pela
// equipe): é o envio de maior risco, então tem limite diário por número.
export const FIRST_CONTACT_DAILY_LIMIT = 20;
const firstContacts = new Map<string, { day: string; count: number }>();

export function takeFirstContact(companyId: string, day = new Date().toDateString()): boolean {
  const entry = firstContacts.get(companyId);
  const count = entry?.day === day ? entry.count : 0;
  if (count >= FIRST_CONTACT_DAILY_LIMIT) return false;
  firstContacts.set(companyId, { day, count: count + 1 });
  return true;
}

// Mensagem de teste para qualquer número: poucas por vez.
const TEST_LIMIT = 3;
const TEST_WINDOW_MS = 10 * 60_000;
const tests = new Map<string, number[]>();

export function takeTestSend(companyId: string, now = Date.now()): boolean {
  const recent = (tests.get(companyId) ?? []).filter((t) => now - t < TEST_WINDOW_MS);
  if (recent.length >= TEST_LIMIT) return false;
  recent.push(now);
  tests.set(companyId, recent);
  return true;
}

// Pedidos de código por e-mail ("Receber código"): poucos por cliente.
const CODE_LIMIT = 6;
const CODE_WINDOW_MS = 60 * 60_000;
const codeRequests = new Map<string, number[]>();

export function takeCodeRequest(companyId: string, contactId: string, now = Date.now()): boolean {
  const key = `${companyId}:${contactId}`;
  const recent = (codeRequests.get(key) ?? []).filter((t) => now - t < CODE_WINDOW_MS);
  if (recent.length >= CODE_LIMIT) return false;
  recent.push(now);
  codeRequests.set(key, recent);
  return true;
}

// Cache de "esse número tem WhatsApp?", para não consultar a cada minuto.
const NUMBER_CACHE_MS = 24 * 60 * 60_000;
const numberCache = new Map<string, { jid: string | null; at: number }>();

export async function cachedLookup(key: string, lookup: () => Promise<string | null>): Promise<string | null> {
  const hit = numberCache.get(key);
  if (hit && Date.now() - hit.at < NUMBER_CACHE_MS) return hit.jid;
  const jid = await lookup();
  numberCache.set(key, { jid, at: Date.now() });
  return jid;
}

// Cliente pedindo para não receber mais mensagens automáticas.
export const OPT_OUT = /^(parar|pare|stop|sair da lista|nao quero (mais )?receber( mensagens| lembretes)?|parar lembretes|descadastrar)[\s!.]*$/;
export const OPT_OUT_HINT = 'Para não receber mais lembretes, responda PARAR.';
