import { NextFunction, Request, Response, Router } from 'express';
import { Role } from '@prisma/client';
import { z } from 'zod';
import { asyncHandler } from '../../lib/asyncHandler';
import { HttpError } from '../../lib/httpError';
import { authenticate, companyOf, requireCompany, requireRole } from '../../middlewares/auth.middleware';
import { requireActiveSubscription } from '../../middlewares/subscription.middleware';
import { validate } from '../../middlewares/validate.middleware';
import * as service from './emailCodes.service';

const inboxSchema = z.object({
  label: z.string().trim().min(1, 'Dê um nome para a caixa (ex.: ChatGPT 1).').max(60),
  email: z.string().trim().email('E-mail inválido.').refine((v) => /@(gmail|googlemail)\.com$/i.test(v), 'Por enquanto só caixas do Gmail.'),
  appPassword: z.string().trim().min(16, 'A senha de app do Google tem 16 letras.').max(40),
  senders: z.string().trim().max(300).optional(),
});
const updateSchema = inboxSchema.omit({ email: true }).partial().extend({ active: z.boolean().optional() });
const idsSchema = z.object({ ids: z.array(z.string().uuid()).max(500) });

export const emailCodesRouter = Router();

emailCodesRouter.use(authenticate, requireCompany, requireActiveSubscription, requireRole(Role.ADMIN));
// Recurso liberado pelo admin master só para algumas empresas.
emailCodesRouter.use(asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
  if (!(await service.isEnabled(companyOf(req)))) throw HttpError.forbidden('Os códigos por e-mail não estão liberados para esta empresa.');
  next();
}));

emailCodesRouter.get('/', asyncHandler(async (req: Request, res: Response) => {
  return res.json({ inboxes: await service.listInboxes(companyOf(req)), defaultSenders: service.DEFAULT_SENDERS, windowMinutes: service.CODE_WINDOW_MINUTES });
}));

emailCodesRouter.post('/', validate(inboxSchema), asyncHandler(async (req: Request, res: Response) => {
  return res.status(201).json({ inbox: await service.createInbox(companyOf(req), req.body) });
}));

emailCodesRouter.patch('/:id', validate(updateSchema), asyncHandler(async (req: Request, res: Response) => {
  return res.json({ inbox: await service.updateInbox(companyOf(req), req.params.id, req.body) });
}));

emailCodesRouter.delete('/:id', asyncHandler(async (req: Request, res: Response) => {
  await service.deleteInbox(companyOf(req), req.params.id);
  return res.status(204).send();
}));

emailCodesRouter.post('/:id/test', asyncHandler(async (req: Request, res: Response) => {
  return res.json(await service.testInbox(companyOf(req), req.params.id));
}));

// Clientes liberados para a caixa (substitui a lista).
emailCodesRouter.put('/:id/clients', validate(idsSchema), asyncHandler(async (req: Request, res: Response) => {
  return res.json({ inbox: await service.setInboxClients(companyOf(req), req.params.id, req.body.ids) });
}));

// Caixas liberadas para um cliente (substitui a lista).
emailCodesRouter.put('/clients/:clientId', validate(idsSchema), asyncHandler(async (req: Request, res: Response) => {
  await service.setClientInboxes(companyOf(req), req.params.clientId, req.body.ids);
  return res.status(204).send();
}));
