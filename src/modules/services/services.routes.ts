import { Request, Response, Router } from 'express';
import { Role, ServiceKind } from '@prisma/client';
import { z } from 'zod';
import { asyncHandler } from '../../lib/asyncHandler';
import { HttpError } from '../../lib/httpError';
import { prisma } from '../../lib/prisma';
import { authenticate, companyOf, requireCompany, requireRole } from '../../middlewares/auth.middleware';
import { requireActiveSubscription } from '../../middlewares/subscription.middleware';
import { validate } from '../../middlewares/validate.middleware';
import { improveDescription } from './services.ai';

// Catálogo da empresa: serviços com horário (o bot oferece os ativos para
// agendar, na ordem de `position`) e produtos de pronta entrega (sem duração:
// aparecem no catálogo do bot, entram junto num agendamento ou a equipe vende
// pela conversa).

const serviceSchema = z.object({
  kind: z.nativeEnum(ServiceKind).optional(),
  name: z.string().trim().min(1, 'Informe o nome.').max(60, 'Nome muito longo.'),
  description: z.string().trim().max(300).nullish(),
  // Produto: ignorado (fica 0). Serviço: mínimo de 5 minutos (conferido em withDuration).
  durationMinutes: z.number().int().min(0).max(600, 'Duração máxima de 10 horas.').optional(),
  priceCents: z.number().int().min(0, 'Preço inválido.').max(100_000_000),
  active: z.boolean().optional(),
  position: z.number().int().min(0).optional(),
  // Produto que é conta de acesso (códigos por e-mail). Vazio = produto comum.
  accessEmail: z.string().trim().toLowerCase().email('E-mail de acesso inválido.').nullish().or(z.literal('')),
});

// Produto não ocupa horário; serviço precisa de uma duração de verdade.
function withDuration<T extends { kind?: ServiceKind; durationMinutes?: number }>(body: T, current?: { kind: ServiceKind; durationMinutes: number }) {
  const kind = body.kind ?? current?.kind ?? ServiceKind.SERVICE;
  const accessEmail = (body as { accessEmail?: string | null }).accessEmail;
  const access = accessEmail === undefined ? {} : { accessEmail: kind === ServiceKind.PRODUCT && accessEmail ? accessEmail : null };
  if (kind === ServiceKind.PRODUCT) return { ...body, ...access, kind, durationMinutes: 0 };
  const duration = body.durationMinutes ?? current?.durationMinutes ?? 0;
  if (duration < 5) throw HttpError.badRequest('Informe a duração do serviço (mínimo de 5 minutos).');
  return { ...body, ...access, kind, durationMinutes: duration };
}

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
  kind: z.nativeEnum(ServiceKind).optional(),
  name: z.string().trim().min(1, 'Informe o nome antes de usar a IA.').max(60),
  description: z.string().trim().max(300).nullish(),
  priceCents: z.number().int().min(0).max(100_000_000).optional(),
  durationMinutes: z.number().int().min(0).max(600).optional(),
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
    data: { ...withDuration(req.body), companyId, position: req.body.position ?? (last._max.position ?? -1) + 1 },
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
  const service = await prisma.service.update({ where: { id: existing.id }, data: withDuration(req.body, existing) });
  return res.json({ service });
}));

// Agendamentos antigos mantêm nome, duração e preço (AppointmentItem).
servicesRouter.delete('/:id', requireRole(Role.ADMIN), asyncHandler(async (req: Request, res: Response) => {
  const existing = await prisma.service.findFirst({ where: { id: req.params.id, companyId: companyOf(req) } });
  if (!existing) throw HttpError.notFound('Serviço não encontrado.');
  await prisma.service.delete({ where: { id: existing.id } });
  return res.status(204).send();
}));
