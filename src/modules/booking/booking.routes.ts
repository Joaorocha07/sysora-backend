import { Request, Response, Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../lib/asyncHandler';
import { bookingRateLimiter } from '../../middlewares/rateLimit.middleware';
import { validate } from '../../middlewares/validate.middleware';
import { prisma } from '../../lib/prisma';
import { confirmLinkBooking, withContactLock } from '../whatsapp/whatsapp.bot';
import { customerWindowOpen, getCloudAccount } from '../whatsapp/whatsapp.cloud';
import { findWhatsAppJid } from '../whatsapp/whatsapp.connection';
import { takeFirstContact } from '../whatsapp/whatsapp.safety';
import { isReady, sendText } from '../whatsapp/whatsapp.transport';
import * as service from './booking.service';

// Página pública de agendamento pelo link do bot (/agendar/[token]). Sem
// login: o token do link identifica a empresa e o cliente.

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inválida.');
const ids = z.string().trim().min(1, 'Escolha os serviços.').transform((v) => v.split(',').filter(Boolean)).pipe(z.array(z.string().uuid()).min(1).max(10));
const daysQuery = z.object({ services: ids });
const timesQuery = z.object({ services: ids, date: isoDay });
const bookSchema = z.object({
  serviceIds: z.array(z.string().uuid()).min(1, 'Escolha um serviço.').max(10),
  date: isoDay,
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Horário inválido.'),
  name: z.string().trim().min(2, 'Informe seu nome.').max(120).optional(),
});

export const bookingRouter = Router();

// Comprovante do agendamento (link que vai na confirmação do WhatsApp).
bookingRouter.get('/receipt/:token', asyncHandler(async (req: Request, res: Response) => {
  return res.json(await service.getReceipt(req.params.token));
}));

// ============ Link aberto da empresa (/reservar/[token]) ============
const openBookSchema = bookSchema.extend({
  name: z.string().trim().min(2, 'Informe seu nome.').max(120),
  phone: z.string().trim().min(10, 'Informe o WhatsApp com DDD.').max(30),
});

bookingRouter.get('/open/:token', asyncHandler(async (req: Request, res: Response) => {
  return res.json(await service.getOpenBooking(req.params.token));
}));

bookingRouter.get('/open/:token/days', validate(daysQuery, 'query'), asyncHandler(async (req: Request, res: Response) => {
  const { services } = req.query as unknown as z.infer<typeof daysQuery>;
  return res.json({ days: await service.getOpenDays(req.params.token, services) });
}));

bookingRouter.get('/open/:token/times', validate(timesQuery, 'query'), asyncHandler(async (req: Request, res: Response) => {
  const { services, date } = req.query as unknown as z.infer<typeof timesQuery>;
  return res.json({ times: await service.getOpenTimes(req.params.token, services, date) });
}));

bookingRouter.post('/open/:token', bookingRateLimiter, validate(openBookSchema), asyncHandler(async (req: Request, res: Response) => {
  const { appointment, settings, company } = await service.bookOpen(req.params.token, req.body);
  const receiptUrl = service.receiptUrl(appointment.receiptToken!);
  const { companyId, client } = appointment;
  // Confirmação no WhatsApp. Quem nunca escreveu para a empresa: só se o número
  // tem WhatsApp e dentro do limite diário de primeiros contatos. API oficial:
  // só dentro da janela de 24 h.
  let to: string | null = null;
  if (client.whatsappId && await isReady(companyId)) {
    if (await getCloudAccount(companyId)) {
      if (!client.whatsappId.includes('@') && await customerWindowOpen(companyId, client.id)) to = client.whatsappId;
    } else if (await prisma.message.findFirst({ where: { clientId: client.id, sender: 'CLIENT' }, select: { id: true } })) {
      to = client.whatsappId;
    } else {
      const jid = await findWhatsAppJid(companyId, client.whatsappId.replace(/\D/g, '')).catch(() => null);
      if (jid && takeFirstContact(companyId)) to = jid;
    }
  }
  if (to) {
    const target = to;
    withContactLock(companyId, client.whatsappId!, () => confirmLinkBooking(settings, company, appointment, receiptUrl, (text) => sendText(companyId, target, text)))
      .catch((err) => console.error('Falha ao confirmar no WhatsApp o agendamento pelo link aberto:', err));
  }
  return res.status(201).json({
    notified: Boolean(to),
    receiptUrl,
    address: company.address,
    appointment: {
      date: appointment.date,
      startTime: appointment.startTime,
      endTime: appointment.endTime,
      totalCents: appointment.totalCents,
      services: appointment.items.map((i) => i.name),
    },
  });
}));

bookingRouter.get('/:token', asyncHandler(async (req: Request, res: Response) => {
  return res.json(await service.getBooking(req.params.token));
}));

bookingRouter.get('/:token/days', validate(daysQuery, 'query'), asyncHandler(async (req: Request, res: Response) => {
  const { services } = req.query as unknown as z.infer<typeof daysQuery>;
  return res.json({ days: await service.getDays(req.params.token, services) });
}));

bookingRouter.get('/:token/times', validate(timesQuery, 'query'), asyncHandler(async (req: Request, res: Response) => {
  const { services, date } = req.query as unknown as z.infer<typeof timesQuery>;
  return res.json({ times: await service.getTimes(req.params.token, services, date) });
}));

bookingRouter.post('/:token', bookingRateLimiter, validate(bookSchema), asyncHandler(async (req: Request, res: Response) => {
  const { appointment, settings, company } = await service.book(req.params.token, req.body);
  const receiptUrl = service.receiptUrl(appointment.receiptToken!);
  // Confirmação também no WhatsApp (se a empresa estiver conectada).
  const waId = appointment.client.whatsappId;
  const notified = Boolean(waId && await isReady(appointment.companyId));
  if (waId && notified) {
    withContactLock(appointment.companyId, waId, () => confirmLinkBooking(settings, company, appointment, receiptUrl, (text) => sendText(appointment.companyId, waId, text)))
      .catch((err) => console.error('Falha ao confirmar no WhatsApp o agendamento pelo link:', err));
  }
  return res.status(201).json({
    notified,
    receiptUrl,
    address: company.address,
    appointment: {
      date: appointment.date,
      startTime: appointment.startTime,
      endTime: appointment.endTime,
      totalCents: appointment.totalCents,
      services: appointment.items.map((i) => i.name),
    },
  });
}));
