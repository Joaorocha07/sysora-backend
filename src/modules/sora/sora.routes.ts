import { Request, Response, Router } from 'express';
import { Role } from '@prisma/client';
import { z } from 'zod';
import { asyncHandler } from '../../lib/asyncHandler';
import { authenticate, companyOf, requireCompany, requireRole } from '../../middlewares/auth.middleware';
import { requireActiveSubscription } from '../../middlewares/subscription.middleware';
import { validate } from '../../middlewares/validate.middleware';
import { flowSchema } from '../whatsapp/whatsapp.flow';
import * as service from './sora.service';

// Menu Sora: conversas com a IA (histórico), catálogo e fluxo.
// O plano (IA só no Avançado pago) é conferido em askSora.

const messageSchema = z.object({
  conversationId: z.string().uuid().nullish(),
  text: z.string().trim().min(1, 'Escreva o que você quer que a Sora faça.').max(2000),
  mode: z.enum(['chat', 'fluxo']).default('chat'),
  // Modo fluxo: o fluxo que está no editor (pode não estar salvo).
  flow: flowSchema.optional(),
});

export const soraRouter = Router();

soraRouter.use(authenticate, requireCompany, requireActiveSubscription, requireRole(Role.ADMIN));

soraRouter.get('/usage', asyncHandler(async (req: Request, res: Response) => {
  return res.json(await service.soraUsage(companyOf(req)));
}));

soraRouter.get('/conversations', asyncHandler(async (req: Request, res: Response) => {
  return res.json({ conversations: await service.listConversations(companyOf(req)) });
}));

soraRouter.get('/conversations/:id', asyncHandler(async (req: Request, res: Response) => {
  return res.json(await service.getConversation(companyOf(req), req.params.id));
}));

soraRouter.delete('/conversations/:id', asyncHandler(async (req: Request, res: Response) => {
  await service.deleteConversation(companyOf(req), req.params.id);
  return res.status(204).send();
}));

soraRouter.post('/messages', validate(messageSchema), asyncHandler(async (req: Request, res: Response) => {
  return res.json(await service.sendMessage(companyOf(req), req.auth!.userId, req.body));
}));

// Confirma as mudanças de catálogo propostas numa resposta da Sora.
soraRouter.post('/messages/:id/apply-catalog', asyncHandler(async (req: Request, res: Response) => {
  return res.json(await service.applyCatalog(companyOf(req), req.params.id));
}));
