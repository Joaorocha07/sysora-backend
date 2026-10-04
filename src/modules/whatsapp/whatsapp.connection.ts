import {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  WAMessage,
  WAMessageKey,
  WASocket,
  fetchLatestBaileysVersion,
  getContentType,
  isJidBroadcast,
  isJidGroup,
  isJidNewsletter,
  isJidStatusBroadcast,
  isLidUser,
  jidDecode,
  jidNormalizedUser,
  makeCacheableSignalKeyStore,
  makeWASocket,
  normalizeMessageContent,
  proto,
} from 'baileys';
import pino from 'pino';
import QRCode from 'qrcode';
import { env } from '../../config/env';
import { prisma } from '../../lib/prisma';
import { HttpError } from '../../lib/httpError';
import { clearStoredSession, listCompaniesWithSession, useDatabaseAuthState } from '../../lib/whatsappAuthState';
import { handleIncomingMessage, handleMessageFromPhone } from './whatsapp.bot';
import { cachedLookup, sleep, typingDelay, waitSendSlot } from './whatsapp.safety';

// Conexão de cada empresa com o WhatsApp Web (Baileys). O administrador lê o
// QR Code na tela da Sysora e o servidor passa a funcionar como um "aparelho
// conectado" daquele número. As conexões vivem na memória deste processo:
// rode apenas UMA instância do backend por banco, senão as duas disputam a
// mesma sessão.

export type ConnectionStatus = 'disconnected' | 'connecting' | 'qr' | 'connected';
export type WhatsAppConnectionState = {
  status: ConnectionStatus;
  // QR Code em data URL (image/png), presente só enquanto status = 'qr'.
  qr: string | null;
  phone: string | null;
  error: string | null;
};

type Connection = WhatsAppConnectionState & {
  sock: WASocket | null;
  retries: number;
  closing: boolean;
  timer?: NodeJS.Timeout;
};

const logger = pino({ level: 'error' });
const connections = new Map<string, Connection>();
const MEDIA_TYPES: Record<string, string> = {
  imageMessage: 'image', audioMessage: 'audio', videoMessage: 'video', documentMessage: 'document',
  documentWithCaptionMessage: 'document', stickerMessage: 'sticker', locationMessage: 'location',
  liveLocationMessage: 'location', contactMessage: 'contact', contactsArrayMessage: 'contact',
};
// Reações, edições, apagados etc. não são mensagens para o bot responder.
const IGNORED_TYPES = new Set(['protocolMessage', 'reactionMessage', 'senderKeyDistributionMessage', 'pollUpdateMessage', 'keepInChatMessage']);
// Mensagem do celular da equipe mais antiga que isso é histórico sincronizado, não conversa nova.
const PHONE_MESSAGE_MAX_AGE_S = 120;

// Mensagens enviadas recentemente, para o WhatsApp conseguir reenviar quando o
// aparelho do cliente pede de novo (sem isso aparece "Aguardando mensagem").
const sentMessages = new Map<string, proto.IMessage>();
function rememberSent(message: WAMessage | undefined) {
  if (!message?.key.id || !message.message) return;
  sentMessages.set(message.key.id, message.message);
  if (sentMessages.size > 1000) sentMessages.delete(sentMessages.keys().next().value!);
}

let versionPromise: Promise<[number, number, number] | undefined> | null = null;
function latestVersion() {
  versionPromise ??= fetchLatestBaileysVersion().then((r) => r.version).catch(() => undefined);
  return versionPromise;
}

function publicState(conn: Connection | undefined): WhatsAppConnectionState {
  if (!conn) return { status: 'disconnected', qr: null, phone: null, error: null };
  return { status: conn.status, qr: conn.qr, phone: conn.phone, error: conn.error };
}

function statusCode(error: unknown): number | undefined {
  return (error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
}

async function setConnectedFlag(companyId: string, connected: boolean, phone: string | null) {
  await prisma.companySettings.upsert({
    where: { companyId },
    update: { whatsappConnected: connected, whatsappPhone: phone },
    create: { companyId, whatsappConnected: connected, whatsappPhone: phone },
  });
}

export function getConnectionState(companyId: string): WhatsAppConnectionState {
  return publicState(connections.get(companyId));
}

export function isConnected(companyId: string): boolean {
  const conn = connections.get(companyId);
  return Boolean(conn?.sock && conn.status === 'connected');
}

export async function connect(companyId: string): Promise<WhatsAppConnectionState> {
  if (!env.WHATSAPP_ENABLED) throw HttpError.badRequest('O WhatsApp está desativado neste servidor (WHATSAPP_ENABLED=false).');
  const existing = connections.get(companyId);
  if (existing && existing.status !== 'disconnected') return publicState(existing);

  const conn: Connection = { status: 'connecting', qr: null, phone: null, error: null, sock: null, retries: 0, closing: false };
  connections.set(companyId, conn);
  await openSocket(companyId, conn);
  return publicState(conn);
}

// Desconecta o aparelho (some da lista "Aparelhos conectados" do celular) e
// apaga a sessão salva. Para usar de novo é preciso ler outro QR Code.
export async function disconnect(companyId: string): Promise<void> {
  const conn = connections.get(companyId);
  if (conn) {
    conn.closing = true;
    clearTimeout(conn.timer);
    await conn.sock?.logout().catch(() => {});
    conn.sock?.end(undefined);
    connections.delete(companyId);
  }
  await clearStoredSession(companyId);
  await setConnectedFlag(companyId, false, null);
}

// Reabre as sessões salvas quando o servidor sobe, sem precisar ler o QR de novo.
export async function restoreConnections(): Promise<void> {
  const companyIds = await listCompaniesWithSession();
  await Promise.all(companyIds.map((companyId) => connect(companyId).catch((err) => {
    logger.error({ err, companyId }, 'Falha ao restaurar a sessão do WhatsApp');
  })));
}

function toJid(contact: string): string {
  return contact.includes('@') ? contact : `${contact.replace(/\D/g, '')}@s.whatsapp.net`;
}

function requireSocket(companyId: string): WASocket {
  const conn = connections.get(companyId);
  if (!conn?.sock || conn.status !== 'connected') {
    throw HttpError.badRequest('O WhatsApp não está conectado. Conecte o número na tela WhatsApp da Sysora.');
  }
  return conn.sock;
}

// `contact` é o whatsappId salvo no cliente (só dígitos) ou um JID completo.
// Antes de enviar mostra "digitando..." por alguns segundos e respeita um
// intervalo entre envios do número (whatsapp.safety.ts): resposta instantânea
// e rajada de mensagens são os sinais de robô que levam a bloqueio.
export async function sendText(companyId: string, contact: string, text: string): Promise<void> {
  const jid = toJid(contact);
  const presence = (state: 'composing' | 'paused') => requireSocket(companyId).sendPresenceUpdate(state, jid).catch(() => {});
  await presence('composing');
  await sleep(typingDelay(text));
  await waitSendSlot(companyId);
  await presence('paused');
  rememberSent(await requireSocket(companyId).sendMessage(jid, { text }));
}

// Salva (ou atualiza) o cliente nos contatos do WhatsApp da empresa, que
// sincroniza com a agenda do celular.
export async function saveContact(companyId: string, contactId: string, chatJid: string, name: string): Promise<void> {
  const sock = requireSocket(companyId);
  const pnJid = contactId.includes('@') ? null : `${contactId}@s.whatsapp.net`;
  await sock.addOrEditContact(pnJid ?? chatJid, {
    fullName: name,
    firstName: name.split(' ')[0],
    saveOnPrimaryAddressbook: true,
    ...(pnJid ? { pnJid } : {}),
    ...(isLidUser(chatJid) ? { lidJid: chatJid } : {}),
  });
}

// Confere se o número tem WhatsApp e devolve o JID correto (resolve, por
// exemplo, números brasileiros com ou sem o nono dígito).
export async function findWhatsAppJid(companyId: string, phoneDigits: string): Promise<string | null> {
  const sock = requireSocket(companyId);
  return cachedLookup(phoneDigits, async () => {
    const [result] = (await sock.onWhatsApp(phoneDigits)) ?? [];
    return result?.exists ? result.jid : null;
  });
}

async function openSocket(companyId: string, conn: Connection): Promise<void> {
  let auth;
  try {
    auth = await useDatabaseAuthState(companyId);
  } catch (err) {
    // Sessão ilegível (ex.: JWT_REFRESH_SECRET trocado): recomeça do zero.
    logger.error({ err, companyId }, 'Sessão do WhatsApp inválida, gerando uma nova');
    await clearStoredSession(companyId);
    auth = await useDatabaseAuthState(companyId);
  }
  const { state, saveCreds } = auth;

  const sock = makeWASocket({
    version: await latestVersion(),
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
    logger,
    browser: Browsers.ubuntu('Sysora'),
    // Sem isso o celular para de receber notificações enquanto o servidor está conectado.
    markOnlineOnConnect: false,
    syncFullHistory: false,
    shouldSyncHistoryMessage: () => false,
    getMessage: async (key: WAMessageKey) => (key.id ? sentMessages.get(key.id) : undefined),
  });
  if (conn.closing) {
    sock.end(undefined);
    return;
  }
  conn.sock = sock;
  conn.status = 'connecting';

  sock.ev.on('creds.update', () => { saveCreds().catch((err) => logger.error({ err }, 'Falha ao salvar a sessão do WhatsApp')); });

  sock.ev.on('connection.update', (update) => {
    void (async () => {
      if (conn.sock !== sock) return;

      if (update.qr) {
        conn.status = 'qr';
        conn.error = null;
        conn.qr = await QRCode.toDataURL(update.qr, { margin: 1, width: 280 });
      }

      if (update.connection === 'open') {
        conn.status = 'connected';
        conn.qr = null;
        conn.error = null;
        conn.retries = 0;
        conn.phone = jidDecode(sock.user?.id)?.user ?? null;
        await setConnectedFlag(companyId, true, conn.phone);
      }

      if (update.connection === 'close') {
        conn.sock = null;
        conn.qr = null;
        if (conn.closing) return;
        const code = statusCode(update.lastDisconnect?.error);

        if (code === DisconnectReason.loggedOut) {
          // Desconectado pelo celular (Aparelhos conectados > Desconectar).
          conn.status = 'disconnected';
          conn.phone = null;
          conn.error = 'O WhatsApp foi desconectado pelo celular. Leia o QR Code novamente para reconectar.';
          await clearStoredSession(companyId);
          await setConnectedFlag(companyId, false, null);
          return;
        }
        if (code === DisconnectReason.connectionReplaced) {
          conn.status = 'disconnected';
          conn.error = 'Esta sessão foi aberta em outro servidor. Mantenha só uma instância do sistema conectada e clique em Reconectar.';
          return;
        }
        if (!state.creds.registered && code !== DisconnectReason.restartRequired) {
          // Ninguém leu o QR Code a tempo.
          conn.status = 'disconnected';
          conn.error = 'O QR Code expirou. Clique em Conectar para gerar outro.';
          await clearStoredSession(companyId);
          return;
        }

        // Queda de rede ou reinício pedido pelo WhatsApp (logo após ler o QR): reconecta.
        conn.status = 'connecting';
        const delay = code === DisconnectReason.restartRequired ? 0 : Math.min(30_000, 2_000 * 2 ** conn.retries++);
        conn.timer = setTimeout(() => {
          openSocket(companyId, conn).catch((err) => {
            logger.error({ err, companyId }, 'Falha ao reconectar o WhatsApp');
            conn.status = 'disconnected';
            conn.error = 'Não foi possível reconectar. Clique em Reconectar.';
          });
        }, delay);
      }
    })().catch((err) => logger.error({ err, companyId }, 'Erro na conexão do WhatsApp'));
  });

  sock.ev.on('messages.upsert', ({ messages, type }) => {
    for (const message of messages) {
      handleUpsert(companyId, sock, message, type).catch((err) => {
        // eslint-disable-next-line no-console
        console.error('Erro processando mensagem do WhatsApp:', err);
      });
    }
  });
}

// Número do contato (só dígitos). Contas que o WhatsApp identifica por LID
// (id anônimo) trazem o número em remoteJidAlt ou no mapeamento LID -> número.
async function resolveContactId(sock: WASocket, key: WAMessageKey): Promise<string> {
  const jid = key.remoteJid!;
  if (isLidUser(jid)) {
    const pn = key.remoteJidAlt ?? await sock.signalRepository.lidMapping.getPNForLID(jid).catch(() => null);
    const digits = pn ? jidDecode(pn)?.user : null;
    return digits ?? jidNormalizedUser(jid);
  }
  return jidDecode(jid)?.user ?? jid;
}

async function handleUpsert(companyId: string, sock: WASocket, message: WAMessage, type: string) {
  const jid = message.key.remoteJid;
  if (!jid || !message.message) return;
  if (isJidGroup(jid) || isJidBroadcast(jid) || isJidStatusBroadcast(jid) || isJidNewsletter(jid)) return;
  // 'append' = mensagens enviadas por este próprio servidor ou histórico.
  if (type !== 'notify') return;

  const content = normalizeMessageContent(message.message);
  const contentType = getContentType(content);
  if (!contentType || IGNORED_TYPES.has(contentType)) return;

  const text = (
    content?.conversation
    ?? content?.extendedTextMessage?.text
    ?? content?.buttonsResponseMessage?.selectedDisplayText
    ?? content?.listResponseMessage?.title
    ?? content?.templateButtonReplyMessage?.selectedDisplayText
    ?? content?.imageMessage?.caption
    ?? content?.videoMessage?.caption
  )?.trim() || null;

  const contactId = await resolveContactId(sock, message.key);

  if (message.key.fromMe) {
    // A equipe respondeu direto pelo celular: o bot sai da conversa.
    const age = Date.now() / 1000 - Number(message.messageTimestamp ?? 0);
    if (text && age < PHONE_MESSAGE_MAX_AGE_S) await handleMessageFromPhone(companyId, contactId, text);
    return;
  }

  const audio = content?.audioMessage;
  await handleIncomingMessage({
    companyId,
    contactId,
    messageId: message.key.id ?? undefined,
    text,
    mediaType: MEDIA_TYPES[contentType],
    // Baixado só se o bot for transcrever (whatsapp.bot.ts).
    audio: audio ? {
      seconds: audio.seconds ?? 0,
      mimetype: audio.mimetype ?? 'audio/ogg',
      load: () => downloadMediaMessage(message, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage }),
    } : undefined,
    profileName: message.pushName ?? undefined,
    send: (reply) => sendText(companyId, jid, reply),
    // Marca como lida só quando o bot vai responder (com a equipe atendendo, fica não lida no celular).
    typing: () => sock.readMessages([message.key]),
    saveContact: (name) => saveContact(companyId, contactId, jid, name),
  });
}
