import { Request, Response, Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../lib/asyncHandler';
import { HttpError } from '../../lib/httpError';
import { prisma } from '../../lib/prisma';
import { authenticate, companyOf, requireCompany } from '../../middlewares/auth.middleware';
import { requireActiveSubscription } from '../../middlewares/subscription.middleware';
import { validate } from '../../middlewares/validate.middleware';
import { writeQuickReply } from './quickReplies.ai';

// Respostas rápidas: textos prontos que a equipe insere no chat pelo botão ou
// digitando "/atalho". {nome} vira o primeiro nome do cliente (no frontend).
const MAX_REPLIES = 200;

const replySchema = z.object({
  title: z.string().trim().min(1, 'Informe o título.').max(60),
  // Só letras, números e hífen (é o que vem depois da barra).
  shortcut: z.string().trim().toLowerCase().max(24)
    .regex(/^[a-z0-9-]*$/, 'O atalho aceita só letras sem acento, números e hífen.')
    .nullish().transform((v) => v || null),
  text: z.string().trim().min(1, 'Escreva a mensagem.').max(4096),
});

export const quickRepliesRouter = Router();

quickRepliesRouter.use(authenticate, requireCompany, requireActiveSubscription);

quickRepliesRouter.get('/', asyncHandler(async (req: Request, res: Response) => {
  const replies = await prisma.quickReply.findMany({ where: { companyId: companyOf(req) }, orderBy: { title: 'asc' } });
  return res.json({ replies });
}));

async function ensureFreeShortcut(companyId: string, shortcut: string | null | undefined, exceptId?: string) {
  if (!shortcut) return;
  const taken = await prisma.quickReply.findFirst({ where: { companyId, shortcut, ...(exceptId ? { id: { not: exceptId } } : {}) } });
  if (taken) throw HttpError.conflict(`O atalho /${shortcut} já é usado por "${taken.title}".`);
}

quickRepliesRouter.post('/', validate(replySchema), asyncHandler(async (req: Request, res: Response) => {
  const companyId = companyOf(req);
  if ((await prisma.quickReply.count({ where: { companyId } })) >= MAX_REPLIES) throw HttpError.badRequest(`Limite de ${MAX_REPLIES} respostas rápidas.`);
  await ensureFreeShortcut(companyId, req.body.shortcut);
  const reply = await prisma.quickReply.create({ data: { ...req.body, companyId } });
  return res.status(201).json({ reply });
}));

// Texto sugerido pela IA (não salva nada; a pessoa revisa no formulário).
const aiSchema = z.object({
  request: z.string().trim().min(3, 'Diga sobre o que é a mensagem.').max(300),
  draft: z.string().max(4096).nullish(),
});

quickRepliesRouter.post('/ai', validate(aiSchema), asyncHandler(async (req: Request, res: Response) => {
  return res.json(await writeQuickReply(companyOf(req), req.body));
}));

quickRepliesRouter.patch('/:id', validate(replySchema.partial()), asyncHandler(async (req: Request, res: Response) => {
  const companyId = companyOf(req);
  const existing = await prisma.quickReply.findFirst({ where: { id: req.params.id, companyId } });
  if (!existing) throw HttpError.notFound('Resposta rápida não encontrada.');
  await ensureFreeShortcut(companyId, req.body.shortcut, existing.id);
  const reply = await prisma.quickReply.update({ where: { id: existing.id }, data: req.body });
  return res.json({ reply });
}));

quickRepliesRouter.delete('/:id', asyncHandler(async (req: Request, res: Response) => {
  const existing = await prisma.quickReply.findFirst({ where: { id: req.params.id, companyId: companyOf(req) } });
  if (!existing) throw HttpError.notFound('Resposta rápida não encontrada.');
  await prisma.quickReply.delete({ where: { id: existing.id } });
  return res.status(204).send();
}));
