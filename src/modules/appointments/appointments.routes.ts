import { Request, Response, Router } from 'express';
import { AppointmentStatus, Role } from '@prisma/client';
import { z } from 'zod';
import { asyncHandler } from '../../lib/asyncHandler';
import { authenticate, companyOf, requireCompany, requireRole } from '../../middlewares/auth.middleware';
import { requireActiveSubscription } from '../../middlewares/subscription.middleware';
import { validate } from '../../middlewares/validate.middleware';
import { getSettings } from '../settings/settings.service';
import * as appointmentsService from './appointments.service';
import { freeTimes } from './availability';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inválida.');
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Horário inválido.');

const createSchema = z.object({
  clientId: z.string().uuid('Selecione o cliente.'),
  serviceIds: z.array(z.string().uuid()).min(1, 'Selecione pelo menos um serviço.'),
  date: isoDate,
  startTime: time,
  staffId: z.string().uuid().nullish(),
  notes: z.string().trim().max(1000).nullish(),
  ignoreConflicts: z.boolean().optional(),
});

const updateSchema = createSchema.omit({ clientId: true }).partial();

const statusSchema = z.object({ status: z.nativeEnum(AppointmentStatus) });

const listQuerySchema = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  status: z.nativeEnum(AppointmentStatus).optional(),
  clientId: z.string().uuid().optional(),
  staffId: z.string().uuid().optional(),
});

const availabilityQuerySchema = z.object({
  date: isoDate,
  serviceIds: z.string().min(1, 'Selecione pelo menos um serviço.'),
  excludeId: z.string().uuid().optional(),
});

export const appointmentsRouter = Router();

appointmentsRouter.use(authenticate, requireCompany, requireActiveSubscription);

appointmentsRouter.get('/', validate(listQuerySchema, 'query'), asyncHandler(async (req: Request, res: Response) => {
  const appointments = await appointmentsService.listAppointments(companyOf(req), req.query as z.infer<typeof listQuerySchema>);
  return res.json({ appointments });
}));

// Horários livres de um dia para os serviços escolhidos (mesma regra do bot).
appointmentsRouter.get('/availability', validate(availabilityQuerySchema, 'query'), asyncHandler(async (req: Request, res: Response) => {
  const companyId = companyOf(req);
  const query = req.query as z.infer<typeof availabilityQuerySchema>;
  const services = await appointmentsService.resolveServices(companyId, query.serviceIds.split(','));
  const duration = services.reduce((sum, s) => sum + s.durationMinutes, 0);
  const times = await freeTimes(companyId, await getSettings(companyId), query.date, duration, query.excludeId);
  return res.json({ times, duration });
}));

appointmentsRouter.get('/:id', asyncHandler(async (req: Request, res: Response) => {
  return res.json({ appointment: await appointmentsService.getAppointment(companyOf(req), req.params.id) });
}));

appointmentsRouter.post('/', validate(createSchema), asyncHandler(async (req: Request, res: Response) => {
  return res.status(201).json({ appointment: await appointmentsService.createAppointment(companyOf(req), req.body) });
}));

appointmentsRouter.patch('/:id', validate(updateSchema), asyncHandler(async (req: Request, res: Response) => {
  return res.json({ appointment: await appointmentsService.updateAppointment(companyOf(req), req.params.id, req.body) });
}));

appointmentsRouter.post('/:id/status', validate(statusSchema), asyncHandler(async (req: Request, res: Response) => {
  return res.json({ appointment: await appointmentsService.setStatus(companyOf(req), req.params.id, req.body.status) });
}));

appointmentsRouter.delete('/:id', requireRole(Role.ADMIN), asyncHandler(async (req: Request, res: Response) => {
  await appointmentsService.deleteAppointment(companyOf(req), req.params.id);
  return res.status(204).send();
}));
