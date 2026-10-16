import { Request, Response, Router } from 'express';
import { Role } from '@prisma/client';
import { z } from 'zod';
import { asyncHandler } from '../../lib/asyncHandler';
import { HttpError } from '../../lib/httpError';
import { prisma } from '../../lib/prisma';
import { authenticate, companyOf, requireCompany, requireRole } from '../../middlewares/auth.middleware';
import { requireActiveSubscription } from '../../middlewares/subscription.middleware';
import { validate } from '../../middlewares/validate.middleware';
import { bookingLinkFor, newOpenToken, openBookingUrl } from './booking.service';

// Links de agendamento que o dono gera e manda para o cliente:
// - de um cliente: o link pessoal (/agendar/[token], 7 dias, uso único), já com nome e telefone;
// - aberto: um link da empresa (/reservar/[token]) em que a pessoa informa nome e WhatsApp.

export const bookingLinksRouter = Router();

bookingLinksRouter.use(authenticate, requireCompany, requireActiveSubscription);

bookingLinksRouter.post('/client', validate(z.object({ clientId: z.string().uuid() })), asyncHandler(async (req: Request, res: Response) => {
  const companyId = companyOf(req);
  const client = await prisma.client.findFirst({ where: { id: req.body.clientId, companyId }, select: { id: true, name: true, phone: true, whatsappId: true } });
  if (!client) throw HttpError.notFound('Cliente não encontrado.');
  const { url, expiresAt } = await bookingLinkFor(companyId, client.id);
  return res.json({ url, expiresAt, client });
}));

async function openLink(companyId: string) {
  const settings = await prisma.companySettings.findUnique({ where: { companyId }, select: { publicBookingEnabled: true, publicBookingToken: true } });
  return {
    enabled: Boolean(settings?.publicBookingEnabled),
    url: settings?.publicBookingToken ? openBookingUrl(settings.publicBookingToken) : null,
  };
}

bookingLinksRouter.get('/open', asyncHandler(async (req: Request, res: Response) => res.json(await openLink(companyOf(req)))));

// Liga/desliga o link aberto (cria o código na primeira vez).
bookingLinksRouter.put('/open', requireRole(Role.ADMIN), validate(z.object({ enabled: z.boolean() })), asyncHandler(async (req: Request, res: Response) => {
  const companyId = companyOf(req);
  const current = await prisma.companySettings.findUnique({ where: { companyId }, select: { publicBookingToken: true } });
  const token = current?.publicBookingToken ?? newOpenToken();
  await prisma.companySettings.upsert({
    where: { companyId },
    update: { publicBookingEnabled: req.body.enabled, publicBookingToken: token },
    create: { companyId, publicBookingEnabled: req.body.enabled, publicBookingToken: token },
  });
  return res.json(await openLink(companyId));
}));

// Troca o código: o link antigo para de funcionar.
bookingLinksRouter.post('/open/regenerate', requireRole(Role.ADMIN), asyncHandler(async (req: Request, res: Response) => {
  const companyId = companyOf(req);
  await prisma.companySettings.upsert({
    where: { companyId },
    update: { publicBookingToken: newOpenToken() },
    create: { companyId, publicBookingToken: newOpenToken() },
  });
  return res.json(await openLink(companyId));
}));
