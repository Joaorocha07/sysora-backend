import { Request, Response, Router } from 'express';
import { AppointmentStatus, Source } from '@prisma/client';
import { asyncHandler } from '../../lib/asyncHandler';
import { prisma } from '../../lib/prisma';
import { salesSummary } from '../../lib/sales';
import { addDays, toIsoDate } from '../../lib/time';
import { authenticate, companyOf, requireCompany } from '../../middlewares/auth.middleware';
import { requireActiveSubscription } from '../../middlewares/subscription.middleware';
import { appointmentInclude } from '../appointments/appointments.service';
import { ACTIVE_STATUSES } from '../appointments/availability';
import * as connection from '../whatsapp/whatsapp.connection';

// Números do painel inicial da empresa.
export const dashboardRouter = Router();

dashboardRouter.use(authenticate, requireCompany, requireActiveSubscription);

dashboardRouter.get('/', asyncHandler(async (req: Request, res: Response) => {
  const companyId = companyOf(req);
  await connection.syncConnectedFlag(companyId);
  const now = new Date();
  const today = toIsoDate(now);
  const monthStart = `${today.slice(0, 8)}01`;
  const weekAgo = addDays(now, -6);

  const monthEnd = toIsoDate(new Date(now.getFullYear(), now.getMonth() + 1, 0));

  const [clients, newClientsMonth, todayAppointments, monthAppointments, monthCompleted, monthSales] = await Promise.all([
    prisma.client.count({ where: { companyId } }),
    prisma.client.count({ where: { companyId, createdAt: { gte: new Date(`${monthStart}T00:00:00`) } } }),
    prisma.appointment.findMany({
      where: { companyId, date: today, status: { not: AppointmentStatus.CANCELED } },
      include: appointmentInclude,
      orderBy: { startTime: 'asc' },
    }),
    prisma.appointment.count({ where: { companyId, date: { gte: monthStart }, status: { not: AppointmentStatus.CANCELED } } }),
    prisma.appointment.count({ where: { companyId, date: { gte: monthStart }, status: AppointmentStatus.COMPLETED } }),
    // Faturado no mês: serviços + produtos (atendimentos concluídos e assinaturas vendidas), só o total.
    salesSummary(companyId, monthStart, monthEnd),
  ]);

  const [botAppointmentsMonth, unread, settings, weekAppointments, servicesCount, pendingUsers, upcoming] = await Promise.all([
    prisma.appointment.count({ where: { companyId, date: { gte: monthStart }, source: Source.BOT } }),
    prisma.client.aggregate({ where: { companyId }, _sum: { unreadCount: true } }),
    prisma.companySettings.findUnique({ where: { companyId }, select: { whatsappConnected: true, whatsappPhone: true, botEnabled: true, hoursReviewedAt: true } }),
    prisma.appointment.groupBy({
      by: ['date'],
      where: { companyId, date: { gte: toIsoDate(weekAgo), lte: today }, status: { not: AppointmentStatus.CANCELED } },
      _count: true,
    }),
    prisma.service.count({ where: { companyId, active: true } }),
    prisma.companyMembership.count({ where: { companyId, status: 'PENDING' } }),
    prisma.appointment.findMany({
      where: { companyId, date: { gt: today }, status: { in: ACTIVE_STATUSES } },
      include: appointmentInclude,
      orderBy: [{ date: 'asc' }, { startTime: 'asc' }],
      take: 6,
    }),
  ]);

  const byDay = new Map(weekAppointments.map((d) => [d.date, d._count]));
  const week = Array.from({ length: 7 }, (_, i) => {
    const date = toIsoDate(addDays(weekAgo, i));
    return { date, count: byDay.get(date) ?? 0 };
  });

  return res.json({
    clients,
    newClientsMonth,
    todayCount: todayAppointments.length,
    monthAppointments,
    monthCompleted,
    monthRevenueCents: monthSales.totalCents,
    monthSales: monthSales.sales,
    botAppointmentsMonth,
    unreadMessages: unread._sum.unreadCount ?? 0,
    servicesCount,
    pendingUsers,
    whatsapp: {
      whatsappConnected: settings?.whatsappConnected ?? false,
      whatsappPhone: settings?.whatsappPhone ?? null,
      botEnabled: settings?.botEnabled ?? false,
    },
    // Passo "Confira os horários" dos primeiros passos: o admin já salvou a aba Horários.
    hoursReviewed: Boolean(settings?.hoursReviewedAt),
    today: todayAppointments,
    upcoming,
    week,
  });
}));
