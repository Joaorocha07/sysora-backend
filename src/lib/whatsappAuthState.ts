import { AuthenticationCreds, AuthenticationState, BufferJSON, SignalDataTypeMap, initAuthCreds, proto } from 'baileys';
import { prisma } from './prisma';
import { decryptSecret, encryptSecret } from './crypto';

// Versão em banco do useMultiFileAuthState do Baileys (que grava em arquivos
// e não é recomendado em produção). Cada chave vira uma linha em
// whatsapp_auth, criptografada, então a sessão sobrevive a reinícios e deploys.

const CREDS_KEY = 'creds';

async function readValue(companyId: string, key: string) {
  const row = await prisma.whatsAppAuth.findUnique({ where: { companyId_key: { companyId, key } } });
  if (!row) return null;
  return JSON.parse(decryptSecret(row.value), BufferJSON.reviver);
}

async function writeValue(companyId: string, key: string, value: unknown) {
  const encrypted = encryptSecret(JSON.stringify(value, BufferJSON.replacer));
  await prisma.whatsAppAuth.upsert({
    where: { companyId_key: { companyId, key } },
    update: { value: encrypted },
    create: { companyId, key, value: encrypted },
  });
}

export async function hasStoredSession(companyId: string): Promise<boolean> {
  const count = await prisma.whatsAppAuth.count({ where: { companyId, key: CREDS_KEY } });
  return count > 0;
}

export async function clearStoredSession(companyId: string): Promise<void> {
  await prisma.whatsAppAuth.deleteMany({ where: { companyId } });
}

export async function listCompaniesWithSession(): Promise<string[]> {
  const rows = await prisma.whatsAppAuth.findMany({ where: { key: CREDS_KEY }, select: { companyId: true } });
  return rows.map((r) => r.companyId);
}

export async function useDatabaseAuthState(companyId: string): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }> {
  const creds: AuthenticationCreds = (await readValue(companyId, CREDS_KEY)) ?? initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
          const data: { [id: string]: SignalDataTypeMap[T] } = {};
          await Promise.all(ids.map(async (id) => {
            let value = await readValue(companyId, `${type}-${id}`);
            if (type === 'app-state-sync-key' && value) value = proto.Message.AppStateSyncKeyData.fromObject(value);
            data[id] = value;
          }));
          return data;
        },
        set: async (data) => {
          const tasks: Promise<unknown>[] = [];
          for (const category of Object.keys(data) as (keyof SignalDataTypeMap)[]) {
            for (const [id, value] of Object.entries(data[category] ?? {})) {
              const key = `${category}-${id}`;
              tasks.push(value
                ? writeValue(companyId, key, value)
                : prisma.whatsAppAuth.deleteMany({ where: { companyId, key } }));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: () => writeValue(companyId, CREDS_KEY, creds),
  };
}
