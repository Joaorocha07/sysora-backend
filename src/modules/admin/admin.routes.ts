import { Request, Response, Router } from 'express';
import { Plan, SubscriptionStatus } from '@prisma/client';
import { z } from 'zod';
import { asyncHandler } from '../../lib/asyncHandler';
import { HttpError } from '../../lib/httpError';
import { prisma } from '../../lib/prisma';
import { documentField } from '../../lib/document';
import { getPlatformSettings, updatePlatformSettings } from '../../lib/platformSettings';
import { planCatalog } from '../../lib/plans';
import { authenticate, requireSuperAdmin } from '../../middlewares/auth.middleware';
import { validate } from '../../middlewares/validate.middleware';
import { email, password } from '../auth/auth.schema';
import * as whatsappCloud from '../whatsapp/whatsapp.cloud';
import * as adminService from './admin.service';

const optionalText = z.string().trim().max(120).nullish();

const companyFields = {
  name: z.string().trim().min(2, 'Informe o nome da empresa.'),
  document: documentField,
  phone: optionalText,
  email: z.string().trim().email('E-mail da empresa inválido.').nullish().or(z.literal('')),
};

const createCompanySchema = z.object({
  ...companyFields,
  plan: z.nativeEnum(Plan).default(Plan.INICIAL),
  // true = começa no teste grátis; false = já pago por 30 dias.
  trial: z.boolean().default(true),
  admin: z.object({
    name: z.string().trim().min(2, 'Informe o nome do administrador.'),
    email,
    password,
  }),
});

const updateCompanySchema = z.object({
  ...companyFields,
  name: companyFields.name.optional(),
  active: z.boolean().optional(),
  // Recurso "Receber código" (códigos por e-mail no bot), liberado por empresa.
  emailCodesEnabled: z.boolean().optional(),
});

const isoDateTime = z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).nullish();
const updateAccountSchema = z.object({
  plan: z.nativeEnum(Plan).optional(),
  status: z.nativeEnum(SubscriptionStatus).optional(),
  trialEndsAt: isoDateTime,
  paidUntil: isoDateTime,
});

export const adminRouter = Router();

adminRouter.use(authenticate, requireSuperAdmin);

// ============ WhatsApp oficial (app da Meta da Sysora) ============
const requestBase = (req: Request) => `${req.protocol}://${req.get('host')}`;

adminRouter.get('/whatsapp', asyncHandler(async (req: Request, res: Response) => {
  return res.json(await whatsappCloud.platformSetup(requestBase(req)));
}));

adminRouter.post('/whatsapp/check', asyncHandler(async (req: Request, res: Response) => {
  return res.json(await whatsappCloud.checkPlatform(requestBase(req)));
}));

// LGPD: pedidos dos titulares (acesso, correção, exclusão...). Prazo de 15 dias (art. 19).
adminRouter.get('/privacy/requests', asyncHandler(async (_req: Request, res: Response) => {
  return res.json(await adminService.privacyRequests());
}));

adminRouter.post('/privacy/requests/:id/resolve', validate(z.object({ response: z.string().trim().min(1, 'Escreva a resposta enviada ao titular.').max(2000) })), asyncHandler(async (req: Request, res: Response) => {
  return res.json({ request: await adminService.resolvePrivacyRequest(req.params.id, req.body.response) });
}));

// Pesquisa inicial: totais por resposta e as últimas respostas.
adminRouter.get('/surveys', asyncHandler(async (_req: Request, res: Response) => {
  return res.json(await adminService.surveySummary());
}));

adminRouter.post('/whatsapp/webhook', asyncHandler(async (req: Request, res: Response) => {
  return res.json(await whatsappCloud.configurePlatformWebhook(requestBase(req)));
}));

adminRouter.get('/stats', asyncHandler(async (_req: Request, res: Response) => {
  return res.json(await adminService.stats());
}));

// Configurações da plataforma (ex.: cadastro público de empresas).
const platformSettingsSchema = z.object({
  publicSignupEnabled: z.boolean().optional(),
  // Créditos colocados na Anthropic (centavos de dólar), para o saldo estimado da IA.
  aiCreditCents: z.number().int().min(0).max(100_000_000).optional(),
});

adminRouter.get('/settings', asyncHandler(async (_req: Request, res: Response) => {
  return res.json({ settings: await getPlatformSettings() });
}));

adminRouter.patch('/settings', validate(platformSettingsSchema), asyncHandler(async (req: Request, res: Response) => {
  return res.json({ settings: await updatePlatformSettings(req.body) });
}));

// Gastos com IA (Sora): créditos, gasto estimado, saldo, por empresa e últimas chamadas.
adminRouter.get('/ai-usage', asyncHandler(async (_req: Request, res: Response) => {
  return res.json(await adminService.aiUsageSummary());
}));

adminRouter.get('/users',asyncHandler(async (_req: Request, res: Response) => {
  return res.json({ users: await adminService.listUsers() });
}));

adminRouter.get('/plans', (_req: Request, res: Response) => res.json({ plans: planCatalog() }));

adminRouter.get('/companies', asyncHandler(async (_req: Request, res: Response) => {
  return res.json({ companies: await adminService.listCompanies() });
}));

adminRouter.post('/companies', validate(createCompanySchema), asyncHandler(async (req: Request, res: Response) => {
  return res.status(201).json(await adminService.createCompany(req.body));
}));

adminRouter.patch('/companies/:id', validate(updateCompanySchema), asyncHandler(async (req: Request, res: Response) => {
  return res.json({ company: await adminService.updateCompany(req.params.id, req.body) });
}));

// Trava: excluir apaga tudo da empresa, então exige o nome dela digitado (confirmName).
adminRouter.delete('/companies/:id', asyncHandler(async (req: Request, res: Response) => {
  const company = await prisma.company.findUnique({ where: { id: req.params.id }, select: { name: true } });
  if (!company) throw HttpError.notFound('Empresa não encontrada.');
  const typed = String((req.body as { confirmName?: unknown } | undefined)?.confirmName ?? '').trim().toLowerCase();
  if (typed !== company.name.trim().toLowerCase()) {
    throw HttpError.badRequest('Para excluir, digite o nome da empresa exatamente como aparece no painel.');
  }
  await adminService.deleteCompany(req.params.id);
  return res.status(204).send();
}));

adminRouter.patch('/accounts/:id', validate(updateAccountSchema), asyncHandler(async (req: Request, res: Response) => {
  return res.json({ subscription: await adminService.updateAccount(req.params.id, req.body) });
}));

adminRouter.post('/accounts/:id/payment', asyncHandler(async (req: Request, res: Response) => {
  return res.json({ subscription: await adminService.registerPayment(req.params.id) });
}));
