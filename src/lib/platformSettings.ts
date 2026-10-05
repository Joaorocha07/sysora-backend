import { prisma } from './prisma';

// Configurações da plataforma (linha única), editadas pelo admin master.
// Sem a linha no banco valem os padrões do schema.
// aiCreditCents: créditos colocados na conta da Anthropic, para o saldo estimado da IA.
// usdBrlRate: cotação do dólar (R$ por US$ 1) para o gasto da IA em reais (página Gastos).
export type PlatformSettingsInput = { publicSignupEnabled?: boolean; aiCreditCents?: number; usdBrlRate?: number };

const ID = 1;

export async function getPlatformSettings() {
  const settings = await prisma.platformSettings.findUnique({ where: { id: ID } });
  return {
    publicSignupEnabled: settings?.publicSignupEnabled ?? true,
    aiCreditCents: settings?.aiCreditCents ?? 0,
    usdBrlRate: settings?.usdBrlRate ?? 5.5,
  };
}

export async function updatePlatformSettings(input: PlatformSettingsInput) {
  const settings = await prisma.platformSettings.upsert({
    where: { id: ID },
    update: input,
    create: { id: ID, ...input },
  });
  return { publicSignupEnabled: settings.publicSignupEnabled, aiCreditCents: settings.aiCreditCents, usdBrlRate: settings.usdBrlRate };
}
