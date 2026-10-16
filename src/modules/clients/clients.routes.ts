import { randomUUID } from 'crypto';
import { Request, Response, Router } from 'express';
import { Prisma, Role } from '@prisma/client';
import { z } from 'zod';
import { asyncHandler } from '../../lib/asyncHandler';
import { HttpError } from '../../lib/httpError';
import { prisma } from '../../lib/prisma';
import { authenticate, companyOf, requireCompany, requireRole } from '../../middlewares/auth.middleware';
import { requireActiveSubscription } from '../../middlewares/subscription.middleware';
import { validate } from '../../middlewares/validate.middleware';
import { appointmentInclude } from '../appointments/appointments.service';
import { stagesOf } from '../pipeline/pipeline.routes';
import { tagIdsByName } from '../tags/tags.routes';

const clientSchema = z.object({
  name: z.string().trim().min(1, 'Informe o nome.').max(120),
  phone: z.string().trim().min(8, 'Telefone inválido.').max(30),
  email: z.string().trim().email('E-mail inválido.').nullish().or(z.literal('')),
  birthday: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inválida.').nullish().or(z.literal('')),
  notes: z.string().trim().max(2000).nullish(),
  // false = não enviar lembretes automáticos pelo WhatsApp (o cliente pediu PARAR).
  reminders: z.boolean().optional(),
});

const listQuerySchema = z.object({
  search: z.string().trim().optional(),
  tagId: z.string().uuid().optional(),
  stageId: z.string().uuid().optional(),
});

const tagsSchema = z.object({ tagIds: z.array(z.string().uuid()).max(30) });
const noteSchema = z.object({ text: z.string().trim().min(1, 'Escreva a anotação.').max(4000) });

// Importação de planilha (CSV lido no navegador). tags: nomes, criados se não existirem.
const MAX_IMPORT = 2000;
const importSchema = z.object({
  clients: z.array(z.object({
    name: z.string().trim().max(120).optional().default(''),
    phone: z.string().trim().max(30).optional().default(''),
    email: z.string().trim().max(200).optional().default(''),
    birthday: z.string().trim().max(20).optional().default(''),
    notes: z.string().trim().max(2000).optional().default(''),
    tags: z.array(z.string().trim().max(30)).max(10).optional().default([]),
  })).min(1, 'A planilha está vazia.').max(MAX_IMPORT, `Importe até ${MAX_IMPORT} clientes por vez.`),
  // Etiqueta extra para todos os importados (ex.: "Importados out/2026").
  tagId: z.string().uuid().nullish(),
});

// Etiquetas como lista simples ({ id, name, color }) em vez da tabela de ligação.
const withTags = <T extends { tags: { tag: { id: string; name: string; color: string } }[] }>({ tags, ...client }: T) => ({
  ...client,
  tags: tags.map((t) => t.tag),
});
const tagsInclude = { tags: { select: { tag: { select: { id: true, name: true, color: true } } }, orderBy: { createdAt: 'asc' } } } satisfies Prisma.ClientInclude;

// "31/12/1990" ou "1990-12-31" -> "1990-12-31"; o resto vira nulo.
function importDate(value: string): string | null {
  const br = value.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  const iso = br ? `${br[3]}-${br[2].padStart(2, '0')}-${br[1].padStart(2, '0')}` : value;
  return /^\d{4}-\d{2}-\d{2}$/.test(iso) && !Number.isNaN(Date.parse(iso)) ? iso : null;
}

const onlyDigits = (value: string) => value.replace(/\D/g, '');

// Telefone digitado no sistema -> wa_id (55 + DDD + número), para o bot
// reconhecer o cliente quando ele mandar mensagem.
function whatsappIdFromPhone(phone: string): string | null {
  const digits = onlyDigits(phone);
  if (digits.length === 10 || digits.length === 11) return `55${digits}`;
  if (digits.length >= 12) return digits;
  return null;
}

function clean<T extends Partial<z.infer<typeof clientSchema>>>({ reminders, ...body }: T) {
  return {
    ...body,
    email: body.email || null,
    birthday: body.birthday || null,
    ...(reminders === undefined ? {} : { whatsappOptOutAt: reminders ? null : new Date() }),
  };
}

export const clientsRouter = Router();

clientsRouter.use(authenticate, requireCompany, requireActiveSubscription);

clientsRouter.get('/', validate(listQuerySchema, 'query'), asyncHandler(async (req: Request, res: Response) => {
  const { search, tagId, stageId } = req.query as z.infer<typeof listQuerySchema>;
  const digits = search ? onlyDigits(search) : '';
  const companyId = companyOf(req);
  // Cliente sem etapa está na primeira.
  const firstStage = stageId ? (await stagesOf(companyId))[0]?.id : undefined;
  const where: Prisma.ClientWhereInput = {
    companyId,
    ...(tagId ? { tags: { some: { tagId } } } : {}),
    ...(stageId ? (stageId === firstStage ? { AND: [{ OR: [{ stageId }, { stageId: null }] }] } : { stageId }) : {}),
    ...(search
      ? {
          OR: [
            { name: { contains: search, mode: 'insensitive' } },
            { email: { contains: search, mode: 'insensitive' } },
            ...(digits ? [{ phone: { contains: digits } }, { whatsappId: { contains: digits } }] : []),
          ],
        }
      : {}),
  };
  const [clients, total] = await Promise.all([
    prisma.client.findMany({
      where,
      orderBy: [{ lastMessageAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
      include: { _count: { select: { appointments: true } }, ...tagsInclude },
      take: 500,
    }),
    prisma.client.count({ where }),
  ]);
  return res.json({ clients: clients.map(withTags), total });
}));

// Todos os clientes para a planilha (CSV montado no navegador).
clientsRouter.get('/export', asyncHandler(async (req: Request, res: Response) => {
  const companyId = companyOf(req);
  const clients = await prisma.client.findMany({
    where: { companyId },
    orderBy: { name: 'asc' },
    take: 20000,
    select: {
      name: true, phone: true, email: true, birthday: true, notes: true, source: true, createdAt: true, lastMessageAt: true,
      stage: { select: { name: true } },
      tags: { select: { tag: { select: { name: true } } } },
      _count: { select: { appointments: true } },
    },
  });
  return res.json({
    clients: clients.map(({ stage, tags, _count, ...c }) => ({
      ...c, stage: stage?.name ?? null, tags: tags.map((t) => t.tag.name), appointments: _count.appointments,
    })),
  });
}));

clientsRouter.post('/import', requireRole(Role.ADMIN), validate(importSchema), asyncHandler(async (req: Request, res: Response) => {
  const companyId = companyOf(req);
  const { clients: rows, tagId } = req.body as z.infer<typeof importSchema>;
  if (tagId && !(await prisma.tag.findFirst({ where: { id: tagId, companyId } }))) throw HttpError.notFound('Etiqueta não encontrada.');

  const existing = await prisma.client.findMany({ where: { companyId, whatsappId: { not: null } }, select: { whatsappId: true } });
  const seen = new Set(existing.map((c) => c.whatsappId!));
  const skipped: { line: number; name: string; reason: string }[] = [];
  const toCreate: { id: string; row: (typeof rows)[number]; whatsappId: string | null }[] = [];

  for (const [index, row] of rows.entries()) {
    const line = index + 2; // linha 1 é o cabeçalho
    const skip = (reason: string) => skipped.push({ line, name: row.name || row.phone || '—', reason });
    if (!row.name) { skip('Sem nome'); continue; }
    if (onlyDigits(row.phone).length < 8) { skip('Telefone inválido'); continue; }
    const whatsappId = whatsappIdFromPhone(row.phone);
    if (whatsappId && seen.has(whatsappId)) { skip('Telefone já cadastrado'); continue; }
    if (whatsappId) seen.add(whatsappId);
    toCreate.push({ id: randomUUID(), row, whatsappId });
  }

  const tagIds = await tagIdsByName(companyId, toCreate.flatMap((c) => c.row.tags));
  for (let i = 0; i < toCreate.length; i += 500) {
    const chunk = toCreate.slice(i, i + 500);
    const links = chunk.flatMap(({ id, row }) => [
      ...row.tags.map((name) => tagIds.get(name.trim().toLowerCase())).filter((t): t is string => Boolean(t)),
      ...(tagId ? [tagId] : []),
    ].map((t) => ({ clientId: id, tagId: t })));
    await prisma.$transaction([
      prisma.client.createMany({
        data: chunk.map(({ id, row, whatsappId }) => ({
          id, companyId, whatsappId,
          name: row.name.slice(0, 120),
          phone: row.phone,
          email: z.string().email().safeParse(row.email).success ? row.email : null,
          birthday: row.birthday ? importDate(row.birthday) : null,
          notes: row.notes || null,
        })),
      }),
      prisma.clientTag.createMany({ data: links, skipDuplicates: true }),
    ]);
  }
  return res.json({ created: toCreate.length, skipped: skipped.slice(0, 100), skippedCount: skipped.length });
}));

clientsRouter.get('/:id', asyncHandler(async (req: Request, res: Response) => {
  const client = await prisma.client.findFirst({
    where: { id: req.params.id, companyId: companyOf(req) },
    include: { appointments: { include: appointmentInclude, orderBy: [{ date: 'desc' }, { startTime: 'desc' }] }, ...tagsInclude },
  });
  if (!client) throw HttpError.notFound('Cliente não encontrado.');
  return res.json({ client: withTags(client) });
}));

clientsRouter.put('/:id/tags', validate(tagsSchema), asyncHandler(async (req: Request, res: Response) => {
  const companyId = companyOf(req);
  const client = await prisma.client.findFirst({ where: { id: req.params.id, companyId }, select: { id: true } });
  if (!client) throw HttpError.notFound('Cliente não encontrado.');
  const tags = await prisma.tag.findMany({ where: { companyId, id: { in: req.body.tagIds } }, select: { id: true } });
  await prisma.$transaction([
    prisma.clientTag.deleteMany({ where: { clientId: client.id } }),
    prisma.clientTag.createMany({ data: tags.map((t) => ({ clientId: client.id, tagId: t.id })) }),
  ]);
  const updated = await prisma.client.findUniqueOrThrow({ where: { id: client.id }, select: tagsInclude });
  return res.json({ tags: withTags(updated).tags });
}));

// Anotações com data (histórico da ficha).
clientsRouter.get('/:id/notes', asyncHandler(async (req: Request, res: Response) => {
  const notes = await prisma.clientNote.findMany({
    where: { clientId: req.params.id, companyId: companyOf(req) },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
  return res.json({ notes });
}));

clientsRouter.post('/:id/notes', validate(noteSchema), asyncHandler(async (req: Request, res: Response) => {
  const companyId = companyOf(req);
  const client = await prisma.client.findFirst({ where: { id: req.params.id, companyId }, select: { id: true } });
  if (!client) throw HttpError.notFound('Cliente não encontrado.');
  const user = await prisma.user.findUniqueOrThrow({ where: { id: req.auth!.userId }, select: { id: true, name: true } });
  const note = await prisma.clientNote.create({ data: { companyId, clientId: client.id, authorId: user.id, authorName: user.name, text: req.body.text } });
  return res.status(201).json({ note });
}));

// Quem escreveu apaga a própria; o admin apaga qualquer uma.
clientsRouter.delete('/:id/notes/:noteId', asyncHandler(async (req: Request, res: Response) => {
  const note = await prisma.clientNote.findFirst({ where: { id: req.params.noteId, clientId: req.params.id, companyId: companyOf(req) } });
  if (!note) throw HttpError.notFound('Anotação não encontrada.');
  if (note.authorId !== req.auth!.userId && req.auth!.role !== Role.ADMIN) throw HttpError.forbidden('Só quem escreveu ou um administrador pode apagar.');
  await prisma.clientNote.delete({ where: { id: note.id } });
  return res.status(204).send();
}));

clientsRouter.post('/', validate(clientSchema), asyncHandler(async (req: Request, res: Response) => {
  const companyId = companyOf(req);
  const whatsappId = whatsappIdFromPhone(req.body.phone);
  if (whatsappId) {
    const duplicate = await prisma.client.findFirst({ where: { companyId, whatsappId } });
    if (duplicate) throw HttpError.conflict(`Já existe um cliente com esse telefone: ${duplicate.name}.`);
  }
  const client = await prisma.client.create({ data: { ...clean(req.body as z.infer<typeof clientSchema>), companyId, whatsappId } });
  return res.status(201).json({ client });
}));

clientsRouter.patch('/:id', validate(clientSchema.partial()), asyncHandler(async (req: Request, res: Response) => {
  const companyId = companyOf(req);
  const existing = await prisma.client.findFirst({ where: { id: req.params.id, companyId } });
  if (!existing) throw HttpError.notFound('Cliente não encontrado.');
  const data: Prisma.ClientUpdateInput = clean(req.body);
  // Telefone alterado à mão: atualiza o destino do WhatsApp (se o cliente
  // ainda não tiver conversado pelo bot, que já traz o número certo, ou se o
  // WhatsApp tinha escondido o número dele: id anônimo @lid da conexão por QR Code).
  if (req.body.phone) {
    const whatsappId = whatsappIdFromPhone(req.body.phone);
    if (existing.source !== 'BOT' || (existing.whatsappId?.includes('@') && whatsappId)) data.whatsappId = whatsappId;
  }
  const client = await prisma.client.update({ where: { id: existing.id }, data });
  return res.json({ client });
}));

clientsRouter.delete('/:id', requireRole(Role.ADMIN), asyncHandler(async (req: Request, res: Response) => {
  const existing = await prisma.client.findFirst({ where: { id: req.params.id, companyId: companyOf(req) } });
  if (!existing) throw HttpError.notFound('Cliente não encontrado.');
  await prisma.client.delete({ where: { id: existing.id } });
  return res.status(204).send();
}));
