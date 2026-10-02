import { Request, Response, Router } from 'express';
import { Role } from '@prisma/client';
import { z } from 'zod';
import { asyncHandler } from '../../lib/asyncHandler';
import { HttpError } from '../../lib/httpError';
import { prisma } from '../../lib/prisma';
import { authenticate, companyOf, requireCompany, requireRole } from '../../middlewares/auth.middleware';
import { requireActiveSubscription } from '../../middlewares/subscription.middleware';
import { validate } from '../../middlewares/validate.middleware';
import { improveDescription } from './services.ai';

// Catálogo de serviços da empresa. O bot oferece os serviços ativos, na
// ordem de `position`.

const serviceSchema = z.object({
  name: z.string().trim().min(1, 'Informe o nome do serviço.').max(60, 'Nome muito longo.'),
  description: z.string().trim().max(300).nullish(),
  durationMinutes: z.number().int().min(5, 'Duração mínima de 5 minutos.').max(600, 'Duração máxima de 10 horas.'),
  priceCents: z.number().int().min(0, 'Preço inválido.').max(100_000_000),
  active: z.boolean().optional(),
  position: z.number().int().min(0).optional(),
});

export const servicesRouter = Router();

servicesRouter.use(authenticate, requireCompany, requireActiveSubscription);

servicesRouter.get('/', asyncHandler(async (req: Request, res: Response) => {
  const services = await prisma.service.findMany({
    where: { companyId: companyOf(req) },
    orderBy: [{ position: 'asc' }, { name: 'asc' }],
    include: { _count: { select: { appointments: true } } },
  });
  return res.json({ services });
}));

// "Melhorar com IA" no formulário do serviço (ainda não salvo): devolve o texto sugerido.
const improveSchema = z.object({
  name: z.string().trim().min(1, 'Informe o nome do serviço antes de usar a IA.').max(60),
  description: z.string().trim().max(300).nullish(),
  priceCents: z.number().int().min(0).max(100_000_000).optional(),
  durationMinutes: z.number().int().min(1).max(600).optional(),
});

servicesRouter.post('/improve-description', requireRole(Role.ADMIN), validate(improveSchema), asyncHandler(async (req: Request, res: Response) => {
  return res.json({ description: await improveDescription(companyOf(req), req.body) });
}));

servicesRouter.post('/', requireRole(Role.ADMIN), validate(serviceSchema), asyncHandler(async (req: Request, res: Response) => {
  const companyId = companyOf(req);
  const duplicate = await prisma.service.findFirst({ where: { companyId, name: { equals: req.body.name, mode: 'insensitive' } } });
  if (duplicate) throw HttpError.conflict('Já existe um serviço com esse nome.');
  const last = await prisma.service.aggregate({ where: { companyId }, _max: { position: true } });
  const service = await prisma.service.create({
    data: { ...req.body, companyId, position: req.body.position ?? (last._max.position ?? -1) + 1 },
  });
  return res.status(201).json({ service });
}));

servicesRouter.patch('/:id', requireRole(Role.ADMIN), validate(serviceSchema.partial()), asyncHandler(async (req: Request, res: Response) => {
  const companyId = companyOf(req);
  const existing = await prisma.service.findFirst({ where: { id: req.params.id, companyId } });
  if (!existing) throw HttpError.notFound('Serviço não encontrado.');
  if (req.body.name) {
    const duplicate = await prisma.service.findFirst({
      where: { companyId, id: { not: existing.id }, name: { equals: req.body.name, mode: 'insensitive' } },
    });
    if (duplicate) throw HttpError.conflict('Já existe um serviço com esse nome.');
  }
  const service = await prisma.service.update({ where: { id: existing.id }, data: req.body });
  return res.json({ service });
}));

// Agendamentos antigos mantêm nome, duração e preço (AppointmentItem).
servicesRouter.delete('/:id', requireRole(Role.ADMIN), asyncHandler(async (req: Request, res: Response) => {
  const existing = await prisma.service.findFirst({ where: { id: req.params.id, companyId: companyOf(req) } });
  if (!existing) throw HttpError.notFound('Serviço não encontrado.');
  await prisma.service.delete({ where: { id: existing.id } });
  return res.status(204).send();
}));
