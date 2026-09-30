import { Request, Response, Router } from 'express';
import { Plan, SubscriptionStatus } from '@prisma/client';
import { z } from 'zod';
import { asyncHandler } from '../../lib/asyncHandler';
import { getPlatformSettings, updatePlatformSettings } from '../../lib/platformSettings';
import { planCatalog } from '../../lib/plans';
import { authenticate, requireSuperAdmin } from '../../middlewares/auth.middleware';
import { validate } from '../../middlewares/validate.middleware';
import { email, password } from '../auth/auth.schema';
import * as adminService from './admin.service';

const optionalText = z.string().trim().max(120).nullish();

const companyFields = {
  name: z.string().trim().min(2, 'Informe o nome da empresa.'),
  document: optionalText,
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

adminRouter.get('/stats', asyncHandler(async (_req: Request, res: Response) => {
  return res.json(await adminService.stats());
}));

// Configurações da plataforma (ex.: cadastro público de empresas).
const platformSettingsSchema = z.object({ publicSignupEnabled: z.boolean().optional() });

adminRouter.get('/settings', asyncHandler(async (_req: Request, res: Response) => {
  return res.json({ settings: await getPlatformSettings() });
}));

adminRouter.patch('/settings', validate(platformSettingsSchema), asyncHandler(async (req: Request, res: Response) => {
  return res.json({ settings: await updatePlatformSettings(req.body) });
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

adminRouter.delete('/companies/:id', asyncHandler(async (req: Request, res: Response) => {
  await adminService.deleteCompany(req.params.id);
  return res.status(204).send();
}));

adminRouter.patch('/accounts/:id', validate(updateAccountSchema), asyncHandler(async (req: Request, res: Response) => {
  return res.json({ subscription: await adminService.updateAccount(req.params.id, req.body) });
}));

adminRouter.post('/accounts/:id/payment', asyncHandler(async (req: Request, res: Response) => {
  return res.json({ subscription: await adminService.registerPayment(req.params.id) });
}));
