import crypto from 'crypto';
import jwt, { SignOptions } from 'jsonwebtoken';
import { Role } from '@prisma/client';
import { env } from '../config/env';

// companyId/role nulos = admin master no painel master (fora de uma empresa).
export type AccessTokenPayload = {
  type: 'access';
  sub: string;
  companyId: string | null;
  role: Role | null;
  isSuperAdmin: boolean;
};

export type PreAuthTokenPayload = {
  type: 'pre-auth';
  sub: string;
};

export function signAccessToken(payload: Omit<AccessTokenPayload, 'type'>): string {
  const body: AccessTokenPayload = { type: 'access', ...payload };
  return jwt.sign(body, env.JWT_ACCESS_SECRET, { expiresIn: env.JWT_ACCESS_EXPIRES_IN } as SignOptions);
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET) as AccessTokenPayload;
  if (decoded.type !== 'access') throw new Error('Tipo de token inválido.');
  return decoded;
}

export function signPreAuthToken(payload: Omit<PreAuthTokenPayload, 'type'>): string {
  const body: PreAuthTokenPayload = { type: 'pre-auth', ...payload };
  return jwt.sign(body, env.JWT_PREAUTH_SECRET, { expiresIn: env.JWT_PREAUTH_EXPIRES_IN } as SignOptions);
}

export function verifyPreAuthToken(token: string): PreAuthTokenPayload {
  const decoded = jwt.verify(token, env.JWT_PREAUTH_SECRET) as PreAuthTokenPayload;
  if (decoded.type !== 'pre-auth') throw new Error('Tipo de token inválido.');
  return decoded;
}

// E-mail confirmado pelo Google que ainda não tem conta: vale para concluir o
// cadastro (empresa ou pedido de acesso) sem senha.
export type GoogleSignupTokenPayload = {
  type: 'google-signup';
  email: string;
  name: string;
  avatarUrl: string | null;
};

export function signGoogleSignupToken(payload: Omit<GoogleSignupTokenPayload, 'type'>): string {
  const body: GoogleSignupTokenPayload = { type: 'google-signup', ...payload };
  return jwt.sign(body, env.JWT_PREAUTH_SECRET, { expiresIn: '30m' });
}

export function verifyGoogleSignupToken(token: string): GoogleSignupTokenPayload {
  const decoded = jwt.verify(token, env.JWT_PREAUTH_SECRET) as GoogleSignupTokenPayload;
  if (decoded.type !== 'google-signup') throw new Error('Tipo de token inválido.');
  return decoded;
}

// Refresh tokens são opacos: um valor aleatório enviado ao cliente, do qual
// só guardamos o hash SHA-256 no banco.
export function generateOpaqueToken(): string {
  return crypto.randomBytes(48).toString('hex');
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function refreshTokenExpiryDate(): Date {
  return new Date(Date.now() + parseDurationToMs(env.JWT_REFRESH_EXPIRES_IN));
}

function parseDurationToMs(duration: string): number {
  const match = /^(\d+)(ms|s|m|h|d)$/.exec(duration.trim());
  if (!match) throw new Error(`Duração inválida: ${duration}`);
  const factor = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2]]!;
  return Number(match[1]) * factor;
}
