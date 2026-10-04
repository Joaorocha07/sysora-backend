import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

// Lê a caixa do Gmail por IMAP (senha de app do Google) e acha o código mais
// recente enviado por um dos remetentes aceitos (ex.: openai.com manda
// "Your ChatGPT code is 123456"). Só leitura: não marca nem apaga e-mails.

export type InboxLogin = { email: string; password: string };
export type FoundCode = { code: string | null; link: string | null; subject: string; from: string; receivedAt: Date };

const IMAP_HOST = 'imap.gmail.com';
const MAX_MESSAGES = 15;

// "openai.com, noreply@tm.openai.com" -> ['openai.com', 'noreply@tm.openai.com']
export function parseSenders(value: string): string[] {
  return value.split(/[\s,;]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
}

function senderMatches(address: string, senders: string[]): boolean {
  const from = address.toLowerCase();
  const domain = from.split('@')[1] ?? '';
  return senders.some((s) => (s.includes('@') ? from === s : domain === s || domain.endsWith(`.${s}`)));
}

// Código no assunto ("Your ChatGPT code is 123456") ou no texto, perto da
// palavra código/code. 4 a 8 dígitos (com ou sem espaço/hífen no meio).
export function extractCode(subject: string, text: string): string | null {
  const clean = (v: string) => v.replace(/[\s-]/g, '');
  const DIGITS = String.raw`\b(\d{3}[\s-]?\d{3}|\d{4,8})\b`;
  // Número perto da palavra código/code (antes ou depois); "fatura 2026" não conta.
  const after = new RegExp(String.raw`(c[óo]digo|code|verifica\w*|verification|otp)[^\d]{0,80}` + DIGITS, 'i');
  const before = new RegExp(DIGITS + String.raw`[^\d]{0,40}(c[óo]digo|code)`, 'i');
  for (const source of [subject, text]) {
    const a = after.exec(source);
    if (a) return clean(a[2]);
    const b = before.exec(source);
    if (b) return clean(b[1]);
  }
  return null;
}

// E-mails que trazem um botão em vez do código ("Confirmar", "Get code"...).
function extractLink(html: string, senders: string[]): string | null {
  for (const match of html.matchAll(/<a\b[^>]*href="(https:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const label = match[2].replace(/<[^>]+>/g, ' ').trim();
    let host = '';
    try { host = new URL(match[1]).hostname.toLowerCase(); } catch { continue; }
    const fromSender = senders.some((s) => { const d = s.split('@').pop()!; return host === d || host.endsWith(`.${d}`); });
    if (fromSender && /c[óo]digo|code|verif|confirm|log ?in|entrar|acessar|sou eu|fui eu|yes,? (it|this) was me/i.test(label)) return match[1];
  }
  return null;
}

function client(login: InboxLogin) {
  return new ImapFlow({
    host: IMAP_HOST,
    port: 993,
    secure: true,
    auth: { user: login.email, pass: login.password },
    logger: false,
    socketTimeout: 30_000,
  });
}

// Pasta "Todos os e-mails" (pega também o que caiu em Promoções/Atualizações).
async function allMailPath(imap: ImapFlow): Promise<string> {
  const boxes = await imap.list();
  return boxes.find((b) => b.specialUse === '\\All')?.path ?? 'INBOX';
}

// Confere o login (usado ao cadastrar a caixa).
export async function testLogin(login: InboxLogin): Promise<void> {
  const imap = client(login);
  try {
    await imap.connect();
  } finally {
    await imap.logout().catch(() => {});
  }
}

// recipient: só e-mails para esse endereço (caixa que recebe por
// encaminhamento os códigos de várias contas). after: só os que chegaram
// depois disso (código pedido agora, não um antigo).
export type FindOptions = { recipient?: string; after?: Date };

export async function findLatestCode(login: InboxLogin, sendersText: string, withinMinutes: number, options: FindOptions = {}): Promise<FoundCode | null> {
  const senders = parseSenders(sendersText);
  if (!senders.length) return null;
  const window = new Date(Date.now() - withinMinutes * 60_000);
  const since = options.after && options.after > window ? options.after : window;
  const recipient = options.recipient?.toLowerCase();
  const imap = client(login);
  await imap.connect();
  try {
    const lock = await imap.getMailboxLock(await allMailPath(imap));
    try {
      // SINCE do IMAP só olha a data (sem hora): o filtro fino é pelo internalDate.
      const day = new Date(since);
      day.setHours(0, 0, 0, 0);
      const query = {
        since: day,
        ...(senders.length === 1 ? { from: senders[0] } : { or: senders.map((s) => ({ from: s })) }),
        ...(recipient && recipient !== login.email.toLowerCase() ? { to: recipient } : {}),
      };
      const uids = ((await imap.search(query, { uid: true })) || []).sort((a, b) => b - a).slice(0, MAX_MESSAGES);
      for (const uid of uids) {
        const message = await imap.fetchOne(String(uid), { source: true, internalDate: true, envelope: true }, { uid: true });
        if (!message || !message.source) continue;
        const receivedAt = new Date(message.internalDate ?? 0);
        if (receivedAt < since) continue;
        const parsed = await simpleParser(message.source);
        const from = parsed.from?.value[0]?.address ?? '';
        if (!senderMatches(from, senders)) continue;
        if (recipient && recipient !== login.email.toLowerCase()) {
          const to = [parsed.to, parsed.cc].flatMap((a) => (Array.isArray(a) ? a : a ? [a] : [])).flatMap((a) => a.value.map((v) => v.address?.toLowerCase()));
          if (!to.includes(recipient)) continue;
        }
        const subject = parsed.subject ?? '';
        const code = extractCode(subject, parsed.text ?? '');
        const link = code ? null : extractLink(typeof parsed.html === 'string' ? parsed.html : '', senders);
        if (code || link) return { code, link, subject, from, receivedAt };
      }
      return null;
    } finally {
      lock.release();
    }
  } finally {
    await imap.logout().catch(() => {});
  }
}

// Mensagem de erro do Gmail em português, para a tela.
export function loginErrorMessage(err: unknown): string {
  const text = `${(err as { responseText?: string })?.responseText ?? ''} ${(err as Error)?.message ?? ''}`;
  if (/AUTHENTICATIONFAILED|Invalid credentials|Application-specific password/i.test(text)) {
    return 'O Gmail recusou o login. Use uma senha de app (16 letras) gerada em myaccount.google.com/apppasswords, não a senha normal da conta.';
  }
  if (/IMAP access|disabled/i.test(text)) return 'O acesso IMAP está desativado nesta conta do Gmail.';
  if (/timeout|ETIMEDOUT|ENOTFOUND|ECONNRESET/i.test(text)) return 'Não foi possível falar com o Gmail agora. Tente de novo em instantes.';
  return 'Não foi possível acessar o e-mail. Confira o endereço e a senha de app.';
}
