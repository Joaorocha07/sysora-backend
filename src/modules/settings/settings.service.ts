import { prisma } from '../../lib/prisma';
import { HttpError } from '../../lib/httpError';

export async function getSettings(companyId: string) {
  return prisma.companySettings.upsert({ where: { companyId }, update: {}, create: { companyId } });
}

export async function updateSettings(companyId: string, input: Record<string, unknown>) {
  const current = await getSettings(companyId);
  const pick = <K extends keyof typeof current>(key: K) => (input[key] as (typeof current)[K] | undefined) ?? current[key];

  const opening = pick('openingTime');
  const closing = pick('closingTime');
  if (opening >= closing) throw HttpError.badRequest('O horário de fechamento deve ser depois da abertura.');

  if (pick('lunchEnabled')) {
    const lunchStart = pick('lunchStart');
    const lunchEnd = pick('lunchEnd');
    if (lunchStart >= lunchEnd) throw HttpError.badRequest('O fim do intervalo deve ser depois do início.');
    if (lunchStart < opening || lunchEnd > closing) throw HttpError.badRequest('O intervalo precisa estar dentro do horário de funcionamento.');
  }

  return prisma.companySettings.update({ where: { companyId }, data: input });
}
