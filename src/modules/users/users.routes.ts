import { Request, Response, Router } from 'express';
import { Role } from '@prisma/client';
import { z } from 'zod';
import { asyncHandler } from '../../lib/asyncHandler';
import { authenticate, companyOf, requireCompany, requireRole } from '../../middlewares/auth.middleware';
import { requireActiveSubscription } from '../../middlewares/subscription.middleware';
import { validate } from '../../middlewares/validate.middleware';
import { email, password } from '../auth/auth.schema';
import * as usersService from './users.service';

const phone = z.string().trim().max(30).nullish();

const createUserSchema = z.object({
  name: z.string().trim().min(2, 'Informe o nome completo.'),
  email,
  phone,
  password,
  role: z.nativeEnum(Role).default(Role.EMPLOYEE),
});

const updateUserSchema = z.object({
  name: z.string().trim().min(2).optional(),
  phone,
  role: z.nativeEnum(Role).optional(),
  active: z.boolean().optional(),
  password: password.optional(),
});

const approveSchema = z.object({ role: z.nativeEnum(Role).default(Role.EMPLOYEE) });

export const usersRouter = Router();

usersRouter.use(authenticate, requireCompany, requireActiveSubscription);

// Funcionários também listam a equipe (para atribuir atendimentos na agenda).
usersRouter.get('/', asyncHandler(async (req: Request, res: Response) => {
  return res.json({ users: await usersService.listMembers(companyOf(req)) });
}));

usersRouter.get('/pending', requireRole(Role.ADMIN), asyncHandler(async (req: Request, res: Response) => {
  return res.json({ users: await usersService.listPending(companyOf(req)) });
}));

usersRouter.post('/:membershipId/approve', requireRole(Role.ADMIN), validate(approveSchema), asyncHandler(async (req: Request, res: Response) => {
  return res.json({ user: await usersService.approveMember(companyOf(req), req.params.membershipId, req.body.role) });
}));

usersRouter.post('/:membershipId/reject', requireRole(Role.ADMIN), asyncHandler(async (req: Request, res: Response) => {
  await usersService.rejectMember(companyOf(req), req.params.membershipId);
  return res.status(204).send();
}));

usersRouter.post('/', requireRole(Role.ADMIN), validate(createUserSchema), asyncHandler(async (req: Request, res: Response) => {
  return res.status(201).json({ user: await usersService.createMember(companyOf(req), req.body) });
}));

usersRouter.patch('/:membershipId', requireRole(Role.ADMIN), validate(updateUserSchema), asyncHandler(async (req: Request, res: Response) => {
  const user = await usersService.updateMember(req.auth!.userId, companyOf(req), req.params.membershipId, req.body);
  return res.json({ user });
}));

usersRouter.delete('/:membershipId', requireRole(Role.ADMIN), asyncHandler(async (req: Request, res: Response) => {
  await usersService.removeMember(req.auth!.userId, companyOf(req), req.params.membershipId);
  return res.status(204).send();
}));
