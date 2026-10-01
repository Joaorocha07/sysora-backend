import { Request, Response, Router } from 'express';
import { AppointmentStatus, Source } from '@prisma/client';
import { asyncHandler } from '../../lib/asyncHandler';
import { prisma } from '../../lib/prisma';
import { addDays, toIsoDate } from '../../lib/time';
import { authenticate, companyOf, requireCompany } from '../../middlewares/auth.middleware';
import { requireActiveSubscription } from '../../middlewares/subscription.middleware';
import { appointmentInclude } from '../appointments/appointments.service';
import { ACTIVE_STATUSES } from '../appointments/availability';

// Números do painel inicial da empresa.
export const dashboardRouter = Router();

dashboardRouter.use(authenticate, requireCompany, requireActiveSubscription);

dashboardRouter.get('/', asyncHandler(async (req: Request, res: Response) => {
  const companyId = companyOf(req);
  const now = new Date();
  const today = toIsoDate(now);
  const monthStart = `${today.slice(0, 8)}01`;
  const weekAgo = addDays(now, -6);

  const [clients, newClientsMonth, todayAppointments, monthAppointments, monthCompleted] = await Promise.all([
    prisma.client.count({ where: { companyId } }),
    prisma.client.count({ where: { companyId, createdAt: { gte: new Date(`${monthStart}T00:00:00`) } } }),
    prisma.appointment.findMany({
      where: { companyId, date: today, status: { not: AppointmentStatus.CANCELED } },
      include: appointmentInclude,
      orderBy: { startTime: 'asc' },
    }),
    prisma.appointment.count({ where: { companyId, date: { gte: monthStart }, status: { not: AppointmentStatus.CANCELED } } }),
    prisma.appointment.aggregate({ where: { companyId, date: { gte: monthStart }, status: AppointmentStatus.COMPLETED }, _sum: { totalCents: true }, _count: true }),
  ]);

  const [botAppointmentsMonth, unread, settings, weekAppointments, servicesCount, pendingUsers, upcoming] = await Promise.all([
    prisma.appointment.count({ where: { companyId, date: { gte: monthStart }, source: Source.BOT } }),
    prisma.client.aggregate({ where: { companyId }, _sum: { unreadCount: true } }),
    prisma.companySettings.findUnique({ where: { companyId }, select: { whatsappConnected: true, whatsappPhone: true, botEnabled: true } }),
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
    monthCompleted: monthCompleted._count,
    monthRevenueCents: monthCompleted._sum.totalCents ?? 0,
    botAppointmentsMonth,
    unreadMessages: unread._sum.unreadCount ?? 0,
    servicesCount,
    pendingUsers,
    whatsapp: settings ?? { whatsappConnected: false, whatsappPhone: null, botEnabled: false },
    today: todayAppointments,
    upcoming,
    week,
  });
}));
