import { Request, Response, Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../lib/asyncHandler';
import { prisma } from '../../lib/prisma';
import { authenticate } from '../../middlewares/auth.middleware';
import { validate } from '../../middlewares/validate.middleware';

// Pesquisa inicial: todo usuário de empresa (administrador ou funcionário, conta
// nova ou antiga) conta como conheceu a Sysora, o ramo, o tamanho da equipe e o
// que quer num sistema. O convite aparece uma vez, no login; "Responder depois"
// guarda surveyDismissedAt e daí em diante só o painel lembra, até a pessoa
// responder. As respostas aparecem no painel master.

const optionId = z.string().trim().min(1).max(40);
const otherText = z.string().trim().max(200).nullish();

const surveySchema = z.object({
  sources: z.array(optionId).min(1, 'Conte como conheceu a Sysora.').max(12),
  sourceOther: otherText,
  business: optionId,
  businessOther: otherText,
  teamSize: optionId,
  features: z.array(optionId).min(1, 'Escolha ao menos uma funcionalidade.').max(20),
  featuresOther: otherText,
  comment: z.string().trim().max(1000).nullish(),
});

export const surveyRouter = Router();

surveyRouter.use(authenticate);

// eligible: usuário dentro de uma empresa (o admin master não responde).
// status: done = respondeu; dismissed = escolheu "Agora não"; pending = ainda não viu o convite.
surveyRouter.get('/', asyncHandler(async (req: Request, res: Response) => {
  const { userId, isSuperAdmin, companyId } = req.auth!;
  const eligible = Boolean(companyId) && !isSuperAdmin;
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { surveyDismissedAt: true, survey: { select: { id: true } } } });
  const status = user.survey ? 'done' : user.surveyDismissedAt ? 'dismissed' : 'pending';
  return res.json({ eligible, status });
}));

surveyRouter.post('/', validate(surveySchema), asyncHandler(async (req: Request, res: Response) => {
  const { userId, companyId } = req.auth!;
  const body = req.body as z.infer<typeof surveySchema>;
  const data = {
    companyId: companyId ?? null,
    sources: [...new Set(body.sources)],
    sourceOther: body.sources.includes('outro') ? body.sourceOther || null : null,
    business: body.business,
    businessOther: body.business === 'outro' ? body.businessOther || null : null,
    teamSize: body.teamSize,
    features: [...new Set(body.features)],
    featuresOther: body.features.includes('outro') ? body.featuresOther || null : null,
    comment: body.comment || null,
  };
  await prisma.onboardingSurvey.upsert({ where: { userId }, update: data, create: { userId, ...data } });
  return res.status(201).json({ status: 'done' });
}));

surveyRouter.post('/dismiss', asyncHandler(async (req: Request, res: Response) => {
  await prisma.user.update({ where: { id: req.auth!.userId }, data: { surveyDismissedAt: new Date() } });
  return res.json({ status: 'dismissed' });
}));
