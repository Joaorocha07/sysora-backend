import nodemailer, { Transporter } from 'nodemailer';
import { env } from '../config/env';

// Envio de e-mails por SMTP (Gmail com senha de app, Resend, Brevo...).

let transporter: Transporter | null = null;

export function isMailConfigured(): boolean {
  return Boolean(env.SMTP_HOST);
}

function getTransporter(): Transporter {
  transporter ??= nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
  });
  return transporter;
}

export async function sendMail(input: { to: string; subject: string; text: string; html: string }): Promise<void> {
  await getTransporter().sendMail({ from: env.MAIL_FROM || env.SMTP_USER, ...input });
}

// Endereço público do frontend, para os links dos e-mails.
export function appUrl(): string {
  const base = env.APP_URL || env.CORS_ORIGIN.split(',')[0].trim();
  return base.replace(/\/+$/, '');
}

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);

export function passwordResetEmail(name: string, link: string, minutes: number) {
  const firstName = name.trim().split(/\s+/)[0] || '';
  const hello = firstName ? `Olá, ${firstName}!` : 'Olá!';
  const text = [
    hello,
    '',
    'Recebemos um pedido para redefinir a senha da sua conta na Sysora.',
    `Para criar uma nova senha, acesse o link abaixo (válido por ${minutes} minutos):`,
    '',
    link,
    '',
    'Se não foi você, ignore este e-mail: sua senha continua a mesma.',
  ].join('\n');

  const html = `<!doctype html>
<html lang="pt-BR"><body style="margin:0;background:#f4f4f4;font-family:Arial,Helvetica,sans-serif;color:#111">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#fff;border-radius:18px;padding:32px">
        <tr><td>
          <p style="margin:0 0 6px;font-size:11px;letter-spacing:2px;color:#777">SYSORA</p>
          <h1 style="margin:0 0 16px;font-size:22px">Redefinir sua senha</h1>
          <p style="margin:0 0 12px;font-size:14px;line-height:1.6">${escapeHtml(hello)}</p>
          <p style="margin:0 0 24px;font-size:14px;line-height:1.6">Clique no botão abaixo para criar uma nova senha. O link vale por ${minutes} minutos.</p>
          <p style="margin:0 0 24px"><a href="${escapeHtml(link)}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:12px 22px;border-radius:999px;font-size:14px;font-weight:bold">Criar nova senha</a></p>
          <p style="margin:0;font-size:12px;color:#777;line-height:1.6">Se não foi você, ignore este e-mail: sua senha continua a mesma.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  return { subject: 'Redefinir sua senha - Sysora', text, html };
}
