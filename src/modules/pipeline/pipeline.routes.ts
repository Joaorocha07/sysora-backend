import { Request, Response, Router } from 'express';
import { Role } from '@prisma/client';
import { z } from 'zod';
import { asyncHandler } from '../../lib/asyncHandler';
import { HttpError } from '../../lib/httpError';
import { prisma } from '../../lib/prisma';
import { authenticate, companyOf, requireCompany, requireRole } from '../../middlewares/auth.middleware';
import { requireActiveSubscription } from '../../middlewares/subscription.middleware';
import { validate } from '../../middlewares/validate.middleware';

// Funil de vendas (Kanban): etapas da empresa e em qual etapa cada cliente está.
// Cliente sem etapa (stageId nulo) fica na primeira.
const DEFAULT_STAGES = [
  { name: 'Novo contato', won: false },
  { name: 'Em conversa', won: false },
  { name: 'Proposta enviada', won: false },
  { name: 'Agendado', won: false },
  { name: 'Fechado', won: true },
];
const MAX_STAGES = 10;
// Clientes no quadro (os mais recentes); o resto continua na lista de Clientes.
const BOARD_LIMIT = 1000;

// Duas telas abrindo o funil juntas pela primeira vez não podem criar as etapas padrão duas vezes.
const creating = new Map<string, Promise<void>>();

export async function stagesOf(companyId: string) {
  const list = () => prisma.pipelineStage.findMany({ where: { companyId }, orderBy: { position: 'asc' } });
  const stages = await list();
  if (stages.length) return stages;
  let pending = creating.get(companyId);
  if (!pending) {
    pending = (async () => {
      if (await prisma.pipelineStage.count({ where: { companyId } })) return;
      await prisma.pipelineStage.createMany({ data: DEFAULT_STAGES.map((s, position) => ({ ...s, position, companyId })) });
    })().finally(() => creating.delete(companyId));
    creating.set(companyId, pending);
  }
  await pending;
  return list();
}

const stagesSchema = z.object({
  stages: z.array(z.object({
    id: z.string().uuid().optional(),
    name: z.string().trim().min(1, 'Dê um nome para cada etapa.').max(40),
    won: z.boolean().default(false),
  })).min(2, 'O funil precisa de pelo menos 2 etapas.').max(MAX_STAGES, `Use até ${MAX_STAGES} etapas.`),
});

const moveSchema = z.object({
  clientId: z.string().uuid(),
  stageId: z.string().uuid(),
});

export const pipelineRouter = Router();

pipelineRouter.use(authenticate, requireCompany, requireActiveSubscription);

pipelineRouter.get('/', asyncHandler(async (req: Request, res: Response) => {
  const companyId = companyOf(req);
  const stages = await stagesOf(companyId);
  const clients = await prisma.client.findMany({
    where: { companyId },
    orderBy: [{ lastMessageAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
    take: BOARD_LIMIT,
    select: {
      id: true, name: true, phone: true, stageId: true, lastMessageAt: true, unreadCount: true, createdAt: true,
      tags: { select: { tagId: true } },
    },
  });
  const total = await prisma.client.count({ where: { companyId } });
  return res.json({
    stages,
    clients: clients.map(({ tags, ...c }) => ({ ...c, stageId: c.stageId ?? stages[0].id, tagIds: tags.map((t) => t.tagId) })),
    total,
    limit: BOARD_LIMIT,
  });
}));

// Só as etapas (seletor de etapa no chat e na ficha do cliente).
pipelineRouter.get('/stages', asyncHandler(async (req: Request, res: Response) => res.json({ stages: await stagesOf(companyOf(req)) })));

// Salva as etapas na ordem enviada. Etapa que saiu da lista é apagada e os
// clientes dela voltam para a primeira.
pipelineRouter.put('/stages', requireRole(Role.ADMIN), validate(stagesSchema), asyncHandler(async (req: Request, res: Response) => {
  const companyId = companyOf(req);
  const input = req.body.stages as z.infer<typeof stagesSchema>['stages'];
  const current = await stagesOf(companyId);
  const known = new Set(current.map((s) => s.id));
  const keep = new Set(input.map((s) => s.id).filter((id): id is string => Boolean(id && known.has(id))));
  await prisma.$transaction(async (tx) => {
    await tx.pipelineStage.deleteMany({ where: { companyId, id: { notIn: [...keep] } } });
    for (const [position, stage] of input.entries()) {
      if (stage.id && keep.has(stage.id)) {
        await tx.pipelineStage.update({ where: { id: stage.id }, data: { name: stage.name, won: stage.won, position } });
      } else {
        await tx.pipelineStage.create({ data: { companyId, name: stage.name, won: stage.won, position } });
      }
    }
  });
  return res.json({ stages: await stagesOf(companyId) });
}));

pipelineRouter.post('/move', validate(moveSchema), asyncHandler(async (req: Request, res: Response) => {
  const companyId = companyOf(req);
  const [client, stage] = await Promise.all([
    prisma.client.findFirst({ where: { id: req.body.clientId, companyId }, select: { id: true } }),
    prisma.pipelineStage.findFirst({ where: { id: req.body.stageId, companyId }, select: { id: true } }),
  ]);
  if (!client) throw HttpError.notFound('Cliente não encontrado.');
  if (!stage) throw HttpError.notFound('Etapa não encontrada.');
  await prisma.client.update({ where: { id: client.id }, data: { stageId: stage.id } });
  return res.json({ ok: true });
}));
