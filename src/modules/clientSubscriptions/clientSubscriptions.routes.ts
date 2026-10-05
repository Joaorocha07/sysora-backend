import { NextFunction, Request, Response, Router } from 'express';
import { Role } from '@prisma/client';
import { z } from 'zod';
import { asyncHandler } from '../../lib/asyncHandler';
import { HttpError } from '../../lib/httpError';
import { authenticate, companyOf, requireCompany, requireRole } from '../../middlewares/auth.middleware';
import { requireActiveSubscription } from '../../middlewares/subscription.middleware';
import { validate } from '../../middlewares/validate.middleware';
import * as service from './clientSubscriptions.service';

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inválida.');
const price = z.number().int().min(0).max(100_000_000);
const months = z.number().int().min(1, 'Informe ao menos 1 mês.').max(24);
const notes = z.string().trim().max(1000).nullish();

const createSchema = z.object({
  clientId: z.string().uuid('Escolha o cliente.'),
  serviceId: z.string().uuid().nullish(),
  name: z.string().trim().max(120).optional(),
  priceCents: price.optional(),
  startDate: isoDay,
  dueDate: isoDay.optional(),
  months: months.optional(),
  notes,
});
const renewSchema = z.object({ startDate: isoDay.optional(), months: months.optional(), priceCents: price.optional(), notes });
const updateSchema = z.object({
  name: z.string().trim().min(1, 'Informe o nome.').max(120).optional(),
  priceCents: price.optional(),
  startDate: isoDay.optional(),
  dueDate: isoDay.optional(),
  notes,
});

export const clientSubscriptionsRouter = Router();

clientSubscriptionsRouter.use(authenticate, requireCompany, requireActiveSubscription);
// Recurso liberado pelo admin master só para algumas empresas.
clientSubscriptionsRouter.use(asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
  if (!(await service.isEnabled(companyOf(req)))) throw HttpError.forbidden('As assinaturas de clientes não estão liberadas para esta empresa.');
  next();
}));

clientSubscriptionsRouter.get('/', asyncHandler(async (req: Request, res: Response) => {
  return res.json({ subscriptions: await service.listCurrent(companyOf(req)) });
}));

clientSubscriptionsRouter.get('/client/:clientId', asyncHandler(async (req: Request, res: Response) => {
  return res.json({ subscriptions: await service.listForClient(companyOf(req), req.params.clientId) });
}));

clientSubscriptionsRouter.post('/', validate(createSchema), asyncHandler(async (req: Request, res: Response) => {
  return res.status(201).json({ subscription: await service.create(companyOf(req), req.body) });
}));

clientSubscriptionsRouter.post('/:id/renew', validate(renewSchema), asyncHandler(async (req: Request, res: Response) => {
  return res.status(201).json({ subscription: await service.renew(companyOf(req), req.params.id, req.body) });
}));

clientSubscriptionsRouter.patch('/:id', validate(updateSchema), asyncHandler(async (req: Request, res: Response) => {
  return res.json({ subscription: await service.update(companyOf(req), req.params.id, req.body) });
}));

clientSubscriptionsRouter.post('/:id/cancel', asyncHandler(async (req: Request, res: Response) => {
  return res.json({ subscription: await service.cancel(companyOf(req), req.params.id) });
}));

clientSubscriptionsRouter.delete('/:id', requireRole(Role.ADMIN), asyncHandler(async (req: Request, res: Response) => {
  await service.remove(companyOf(req), req.params.id);
  return res.status(204).send();
}));
