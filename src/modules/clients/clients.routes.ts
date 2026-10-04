import { Request, Response, Router } from 'express';
import { Prisma, Role } from '@prisma/client';
import { z } from 'zod';
import { asyncHandler } from '../../lib/asyncHandler';
import { HttpError } from '../../lib/httpError';
import { prisma } from '../../lib/prisma';
import { authenticate, companyOf, requireCompany, requireRole } from '../../middlewares/auth.middleware';
import { requireActiveSubscription } from '../../middlewares/subscription.middleware';
import { validate } from '../../middlewares/validate.middleware';
import { appointmentInclude } from '../appointments/appointments.service';

const clientSchema = z.object({
  name: z.string().trim().min(1, 'Informe o nome.').max(120),
  phone: z.string().trim().min(8, 'Telefone inválido.').max(30),
  email: z.string().trim().email('E-mail inválido.').nullish().or(z.literal('')),
  birthday: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inválida.').nullish().or(z.literal('')),
  notes: z.string().trim().max(2000).nullish(),
  // false = não enviar lembretes automáticos pelo WhatsApp (o cliente pediu PARAR).
  reminders: z.boolean().optional(),
});

const listQuerySchema = z.object({
  search: z.string().trim().optional(),
});

const onlyDigits = (value: string) => value.replace(/\D/g, '');

// Telefone digitado no sistema -> wa_id (55 + DDD + número), para o bot
// reconhecer o cliente quando ele mandar mensagem.
function whatsappIdFromPhone(phone: string): string | null {
  const digits = onlyDigits(phone);
  if (digits.length === 10 || digits.length === 11) return `55${digits}`;
  if (digits.length >= 12) return digits;
  return null;
}

function clean<T extends Partial<z.infer<typeof clientSchema>>>({ reminders, ...body }: T) {
  return {
    ...body,
    email: body.email || null,
    birthday: body.birthday || null,
    ...(reminders === undefined ? {} : { whatsappOptOutAt: reminders ? null : new Date() }),
  };
}

export const clientsRouter = Router();

clientsRouter.use(authenticate, requireCompany, requireActiveSubscription);

clientsRouter.get('/', validate(listQuerySchema, 'query'), asyncHandler(async (req: Request, res: Response) => {
  const search = req.query.search as string | undefined;
  const digits = search ? onlyDigits(search) : '';
  const where: Prisma.ClientWhereInput = {
    companyId: companyOf(req),
    ...(search
      ? {
          OR: [
            { name: { contains: search, mode: 'insensitive' } },
            { email: { contains: search, mode: 'insensitive' } },
            ...(digits ? [{ phone: { contains: digits } }, { whatsappId: { contains: digits } }] : []),
          ],
        }
      : {}),
  };
  const clients = await prisma.client.findMany({
    where,
    orderBy: [{ lastMessageAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
    include: { _count: { select: { appointments: true } } },
    take: 500,
  });
  return res.json({ clients });
}));

clientsRouter.get('/:id', asyncHandler(async (req: Request, res: Response) => {
  const client = await prisma.client.findFirst({
    where: { id: req.params.id, companyId: companyOf(req) },
    include: { appointments: { include: appointmentInclude, orderBy: [{ date: 'desc' }, { startTime: 'desc' }] } },
  });
  if (!client) throw HttpError.notFound('Cliente não encontrado.');
  return res.json({ client });
}));

clientsRouter.post('/', validate(clientSchema), asyncHandler(async (req: Request, res: Response) => {
  const companyId = companyOf(req);
  const whatsappId = whatsappIdFromPhone(req.body.phone);
  if (whatsappId) {
    const duplicate = await prisma.client.findFirst({ where: { companyId, whatsappId } });
    if (duplicate) throw HttpError.conflict(`Já existe um cliente com esse telefone: ${duplicate.name}.`);
  }
  const client = await prisma.client.create({ data: { ...clean(req.body as z.infer<typeof clientSchema>), companyId, whatsappId } });
  return res.status(201).json({ client });
}));

clientsRouter.patch('/:id', validate(clientSchema.partial()), asyncHandler(async (req: Request, res: Response) => {
  const companyId = companyOf(req);
  const existing = await prisma.client.findFirst({ where: { id: req.params.id, companyId } });
  if (!existing) throw HttpError.notFound('Cliente não encontrado.');
  const data: Prisma.ClientUpdateInput = clean(req.body);
  // Telefone alterado à mão: atualiza o destino do WhatsApp (se o cliente
  // ainda não tiver conversado pelo bot, que já traz o número certo, ou se o
  // WhatsApp tinha escondido o número dele: id anônimo @lid da conexão por QR Code).
  if (req.body.phone) {
    const whatsappId = whatsappIdFromPhone(req.body.phone);
    if (existing.source !== 'BOT' || (existing.whatsappId?.includes('@') && whatsappId)) data.whatsappId = whatsappId;
  }
  const client = await prisma.client.update({ where: { id: existing.id }, data });
  return res.json({ client });
}));

clientsRouter.delete('/:id', requireRole(Role.ADMIN), asyncHandler(async (req: Request, res: Response) => {
  const existing = await prisma.client.findFirst({ where: { id: req.params.id, companyId: companyOf(req) } });
  if (!existing) throw HttpError.notFound('Cliente não encontrado.');
  await prisma.client.delete({ where: { id: existing.id } });
  return res.status(204).send();
}));
