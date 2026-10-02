import { Request, Response, Router } from 'express';
import { Role } from '@prisma/client';
import { z } from 'zod';
import { asyncHandler } from '../../lib/asyncHandler';
import { uniqueInviteCode } from '../../lib/inviteCode';
import { prisma } from '../../lib/prisma';
import { authenticate, companyOf, requireCompany, requireRole } from '../../middlewares/auth.middleware';
import { requireActiveSubscription } from '../../middlewares/subscription.middleware';
import { validate } from '../../middlewares/validate.middleware';
import * as settingsService from './settings.service';

const time = (label: string) => z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, `${label} inválido.`);
const message = (label: string) => z.string().trim().min(1, `Informe a ${label}.`).max(1000);

const updateSettingsSchema = z.object({
  openingTime: time('Horário de abertura').optional(),
  closingTime: time('Horário de fechamento').optional(),
  workDays: z.array(z.number().int().min(0).max(6)).min(1, 'Selecione ao menos um dia de atendimento.').optional(),
  slotMinutes: z.number().int().min(5, 'Intervalo mínimo de 5 minutos.').max(240).optional(),
  slotCapacity: z.number().int().min(1, 'Informe ao menos 1 atendimento por horário.').max(50).optional(),
  lunchEnabled: z.boolean().optional(),
  lunchStart: time('Início do intervalo').optional(),
  lunchEnd: time('Fim do intervalo').optional(),

  botEnabled: z.boolean().optional(),
  autoCreateClient: z.boolean().optional(),
  askName: z.boolean().optional(),
  botAiEnabled: z.boolean().optional(),
  transcribeAudio: z.boolean().optional(),
  greetingMessage: message('mensagem de boas-vindas').optional(),
  handoffMessage: message('mensagem de transferência para a equipe').optional(),
  confirmationMessage: message('mensagem de confirmação').optional(),
  reminderEnabled: z.boolean().optional(),
  reminderTime: time('Horário do lembrete').optional(),
  reminderMessage: message('mensagem do lembrete').optional(),
  hourReminderEnabled: z.boolean().optional(),
  hourReminderMinutes: z.number().int().min(10).max(720).optional(),
  hourReminderMessage: message('mensagem do aviso').optional(),
  pauseOnStaffReply: z.boolean().optional(),
  humanTimeoutMinutes: z.number().int().min(1).max(1440).optional(),
  humanEndMessage: message('mensagem de encerramento').optional(),
});

const companyProfileSchema = z.object({
  name: z.string().trim().min(2, 'Informe o nome da empresa.').optional(),
  document: z.string().trim().max(30).nullish(),
  phone: z.string().trim().max(30).nullish(),
  email: z.string().trim().email('E-mail inválido.').nullish().or(z.literal('')),
});

const companyProfileSelect = { id: true, name: true, slug: true, document: true, phone: true, email: true, inviteCode: true } as const;

export const settingsRouter = Router();

settingsRouter.use(authenticate, requireCompany, requireActiveSubscription);

settingsRouter.get('/', asyncHandler(async (req: Request, res: Response) => {
  const companyId = companyOf(req);
  const [settings, company] = await Promise.all([
    settingsService.getSettings(companyId),
    prisma.company.findUniqueOrThrow({
      where: { id: companyId },
      select: companyProfileSelect,
    }),
  ]);
  return res.json({ settings, company });
}));

settingsRouter.put('/', requireRole(Role.ADMIN), validate(updateSettingsSchema), asyncHandler(async (req: Request, res: Response) => {
  return res.json({ settings: await settingsService.updateSettings(companyOf(req), req.body) });
}));

settingsRouter.patch('/company', requireRole(Role.ADMIN), validate(companyProfileSchema), asyncHandler(async (req: Request, res: Response) => {
  const company = await prisma.company.update({
    where: { id: companyOf(req) },
    data: { ...req.body, email: req.body.email || null },
    select: companyProfileSelect,
  });
  return res.json({ company });
}));

// Novo código de convite (o antigo deixa de funcionar, ex.: vazou).
settingsRouter.post('/invite-code', requireRole(Role.ADMIN), asyncHandler(async (req: Request, res: Response) => {
  const company = await prisma.company.update({ where: { id: companyOf(req) }, data: { inviteCode: await uniqueInviteCode() }, select: { inviteCode: true } });
  return res.json(company);
}));
