import crypto from 'crypto';
import { Request, Response, Router } from 'express';
import { z } from 'zod';
import { env } from '../../config/env';
import { asyncHandler } from '../../lib/asyncHandler';
import { COOKIE_POLICY_VERSION } from '../../lib/legal';
import { prisma } from '../../lib/prisma';
import { authenticate, optionalAuthenticate } from '../../middlewares/auth.middleware';
import { validate } from '../../middlewares/validate.middleware';

// LGPD (Lei 13.709/2018) para quem usa a Sysora:
// - consentimento de cookies: registra a escolha de cada navegador (prova do
//   consentimento, art. 8º, § 2º). Cookies necessários não dependem dele;
// - direitos do titular (art. 18): baixar os próprios dados (acesso e
//   portabilidade) e abrir pedidos de correção, exclusão etc., atendidos pelo
//   admin master no painel Privacidade.

export const PRIVACY_REQUEST_TYPES = ['ACCESS', 'CORRECTION', 'DELETION', 'REVOKE_CONSENT', 'INFO_SHARING', 'OTHER'] as const;

const consentSchema = z.object({
  consentId: z.string().uuid(),
  analytics: z.boolean(),
  marketing: z.boolean(),
  policyVersion: z.string().trim().max(20).default(COOKIE_POLICY_VERSION),
});

const requestSchema = z.object({
  type: z.enum(PRIVACY_REQUEST_TYPES),
  message: z.string().trim().max(2000).nullish(),
});

// IP só como hash (com segredo do servidor): identifica o registro sem guardar o endereço.
const hashIp = (ip: string | undefined) => (ip ? crypto.createHmac('sha256', env.JWT_REFRESH_SECRET).update(`consent-ip:${ip}`).digest('hex') : null);

export const privacyRouter = Router();

// Público: visitantes do site também escolhem os cookies.
privacyRouter.post('/consent', optionalAuthenticate, validate(consentSchema), asyncHandler(async (req: Request, res: Response) => {
  const { consentId, analytics, marketing, policyVersion } = req.body as z.infer<typeof consentSchema>;
  const data = {
    userId: req.auth?.userId ?? undefined,
    analytics,
    marketing,
    policyVersion,
    ipHash: hashIp(req.ip),
    userAgent: req.get('user-agent')?.slice(0, 300) ?? null,
  };
  await prisma.cookieConsent.upsert({ where: { id: consentId }, update: data, create: { id: consentId, ...data } });
  return res.status(204).send();
}));

// Cópia dos dados pessoais de quem está logado (acesso e portabilidade).
privacyRouter.get('/me/export', authenticate, asyncHandler(async (req: Request, res: Response) => {
  const userId = req.auth!.userId;
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: {
      id: true, name: true, email: true, phone: true, avatarUrl: true, active: true,
      googleLinkedAt: true, lastLoginAt: true, createdAt: true, updatedAt: true,
      termsAcceptedAt: true, termsVersion: true, surveyDismissedAt: true,
      memberships: { select: { role: true, status: true, active: true, createdAt: true, decidedAt: true, company: { select: { name: true, document: true, phone: true, email: true } } } },
      survey: { select: { sources: true, sourceOther: true, business: true, businessOther: true, teamSize: true, features: true, featuresOther: true, comment: true, createdAt: true } },
      privacyRequests: { select: { type: true, message: true, status: true, response: true, createdAt: true, resolvedAt: true }, orderBy: { createdAt: 'desc' } },
    },
  });
  const [cookieConsents, appointmentsAsProfessional] = await Promise.all([
    prisma.cookieConsent.findMany({ where: { userId }, select: { analytics: true, marketing: true, policyVersion: true, createdAt: true, updatedAt: true } }),
    prisma.appointment.count({ where: { staffId: userId } }),
  ]);
  const body = {
    generatedAt: new Date().toISOString(),
    note: 'Dados pessoais vinculados à sua conta na Sysora. Os dados dos clientes cadastrados pelas empresas pertencem a cada empresa (controladora) e são exportados por ela.',
    account: user,
    cookieConsents,
    appointmentsAsProfessional,
  };
  res.setHeader('Content-Disposition', `attachment; filename="meus-dados-sysora-${new Date().toISOString().slice(0, 10)}.json"`);
  return res.json(body);
}));

privacyRouter.get('/requests', authenticate, asyncHandler(async (req: Request, res: Response) => {
  const requests = await prisma.privacyRequest.findMany({ where: { userId: req.auth!.userId }, orderBy: { createdAt: 'desc' } });
  return res.json({ requests });
}));

privacyRouter.post('/requests', authenticate, validate(requestSchema), asyncHandler(async (req: Request, res: Response) => {
  const userId = req.auth!.userId;
  const { type, message } = req.body as z.infer<typeof requestSchema>;
  // Um pedido do mesmo tipo em aberto por vez.
  const open = await prisma.privacyRequest.findFirst({ where: { userId, type, status: 'OPEN' } });
  if (open) return res.status(200).json({ request: open, alreadyOpen: true });
  const request = await prisma.privacyRequest.create({ data: { userId, type, message: message || null } });
  return res.status(201).json({ request });
}));
