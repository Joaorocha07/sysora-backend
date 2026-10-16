import { Request, Response, Router } from 'express';
import { Role } from '@prisma/client';
import { z } from 'zod';
import { asyncHandler } from '../../lib/asyncHandler';
import { HttpError } from '../../lib/httpError';
import { prisma } from '../../lib/prisma';
import { authenticate, companyOf, requireCompany, requireRole } from '../../middlewares/auth.middleware';
import { requireActiveSubscription } from '../../middlewares/subscription.middleware';
import { validate } from '../../middlewares/validate.middleware';
import { reactivationOverview, writeReactivation } from './reactivation.service';

// Reativação de clientes (aba Mensagens agendadas). Ver reactivation.service.ts.
const configSchema = z.object({
  enabled: z.boolean(),
  days: z.number().int().min(7, 'Use no mínimo 7 dias.').max(365, 'Use no máximo 365 dias.'),
  message: z.string().trim().min(10, 'Escreva a mensagem.').max(1000, 'Use até 1000 caracteres.'),
});
const aiSchema = z.object({
  request: z.string().trim().max(300).nullish(),
  draft: z.string().max(1000).nullish(),
  days: z.number().int().min(7).max(365),
});

export const reactivationRouter = Router();

reactivationRouter.use(authenticate, requireCompany, requireActiveSubscription);

reactivationRouter.get('/', asyncHandler(async (req: Request, res: Response) => res.json(await reactivationOverview(companyOf(req)))));

reactivationRouter.put('/', requireRole(Role.ADMIN), validate(configSchema), asyncHandler(async (req: Request, res: Response) => {
  const companyId = companyOf(req);
  const { enabled, days, message } = req.body as z.infer<typeof configSchema>;
  if (enabled && !message.includes('{link}')) {
    throw HttpError.badRequest('Coloque {link} na mensagem: é por ele que o cliente escolhe o horário.');
  }
  await prisma.companySettings.upsert({
    where: { companyId },
    update: { reactivationEnabled: enabled, reactivationDays: days, reactivationMessage: message },
    create: { companyId, reactivationEnabled: enabled, reactivationDays: days, reactivationMessage: message },
  });
  return res.json(await reactivationOverview(companyId));
}));

reactivationRouter.post('/ai', requireRole(Role.ADMIN), validate(aiSchema), asyncHandler(async (req: Request, res: Response) => {
  return res.json(await writeReactivation(companyOf(req), req.body));
}));
