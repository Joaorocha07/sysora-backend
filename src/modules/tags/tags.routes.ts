import { Request, Response, Router } from 'express';
import { Prisma, Role } from '@prisma/client';
import { z } from 'zod';
import { asyncHandler } from '../../lib/asyncHandler';
import { HttpError } from '../../lib/httpError';
import { prisma } from '../../lib/prisma';
import { authenticate, companyOf, requireCompany, requireRole } from '../../middlewares/auth.middleware';
import { requireActiveSubscription } from '../../middlewares/subscription.middleware';
import { validate } from '../../middlewares/validate.middleware';

// Etiquetas dos clientes (filtram clientes, conversas e o funil).
// Cores: tons discretos que combinam com o preto e branco do sistema (ver lib/tags.ts no frontend).
export const TAG_COLORS = ['graphite', 'stone', 'sand', 'clay', 'moss', 'sage', 'mist', 'plum'] as const;
const MAX_TAGS = 60;

const tagSchema = z.object({
  name: z.string().trim().min(1, 'Informe o nome.').max(30, 'Use até 30 caracteres.'),
  color: z.enum(TAG_COLORS).default('graphite'),
});

export const tagsRouter = Router();

tagsRouter.use(authenticate, requireCompany, requireActiveSubscription);

tagsRouter.get('/', asyncHandler(async (req: Request, res: Response) => {
  const tags = await prisma.tag.findMany({
    where: { companyId: companyOf(req) },
    orderBy: { name: 'asc' },
    include: { _count: { select: { clients: true } } },
  });
  return res.json({ tags });
}));

const uniqueName = (err: unknown) => err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

tagsRouter.post('/', validate(tagSchema), asyncHandler(async (req: Request, res: Response) => {
  const companyId = companyOf(req);
  if ((await prisma.tag.count({ where: { companyId } })) >= MAX_TAGS) throw HttpError.badRequest(`Limite de ${MAX_TAGS} etiquetas.`);
  try {
    const tag = await prisma.tag.create({ data: { ...req.body, companyId } });
    return res.status(201).json({ tag: { ...tag, _count: { clients: 0 } } });
  } catch (err) {
    if (uniqueName(err)) throw HttpError.conflict('Já existe uma etiqueta com esse nome.');
    throw err;
  }
}));

tagsRouter.patch('/:id', validate(tagSchema.partial()), asyncHandler(async (req: Request, res: Response) => {
  const existing = await prisma.tag.findFirst({ where: { id: req.params.id, companyId: companyOf(req) } });
  if (!existing) throw HttpError.notFound('Etiqueta não encontrada.');
  try {
    const tag = await prisma.tag.update({ where: { id: existing.id }, data: req.body, include: { _count: { select: { clients: true } } } });
    return res.json({ tag });
  } catch (err) {
    if (uniqueName(err)) throw HttpError.conflict('Já existe uma etiqueta com esse nome.');
    throw err;
  }
}));

tagsRouter.delete('/:id', requireRole(Role.ADMIN), asyncHandler(async (req: Request, res: Response) => {
  const existing = await prisma.tag.findFirst({ where: { id: req.params.id, companyId: companyOf(req) } });
  if (!existing) throw HttpError.notFound('Etiqueta não encontrada.');
  await prisma.tag.delete({ where: { id: existing.id } });
  return res.status(204).send();
}));

// Etiquetas de vários nomes (importação de CSV): devolve os ids, criando as que faltam.
export async function tagIdsByName(companyId: string, names: string[]): Promise<Map<string, string>> {
  const wanted = [...new Set(names.map((n) => n.trim().slice(0, 30)).filter(Boolean))];
  const map = new Map<string, string>();
  if (!wanted.length) return map;
  const existing = await prisma.tag.findMany({ where: { companyId } });
  for (const tag of existing) map.set(tag.name.toLowerCase(), tag.id);
  let room = MAX_TAGS - existing.length;
  for (const name of wanted) {
    if (map.has(name.toLowerCase()) || room <= 0) continue;
    const tag = await prisma.tag.create({ data: { companyId, name } });
    map.set(name.toLowerCase(), tag.id);
    room -= 1;
  }
  return map;
}
