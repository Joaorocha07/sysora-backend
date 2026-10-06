import { AuthenticationCreds, AuthenticationState, BufferJSON, SignalDataTypeMap, initAuthCreds, proto } from 'baileys';
import { prisma } from './prisma';
import { decryptSecret, encryptSecret } from './crypto';

// Versão em banco do useMultiFileAuthState do Baileys (que grava em arquivos
// e não é recomendado em produção). Cada chave vira uma linha em
// whatsapp_auth, criptografada, então a sessão sobrevive a reinícios e deploys.

const CREDS_KEY = 'creds';
const WRITE_BATCH_SIZE = 50;

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
        // Uma query só para todos os ids (antes era uma por id, o que esgotava o pool).
        get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
          const data: { [id: string]: SignalDataTypeMap[T] } = {};
          if (ids.length === 0) return data;
          const prefix = `${type}-`;
          const rows = await prisma.whatsAppAuth.findMany({
            where: { companyId, key: { in: ids.map((id) => prefix + id) } },
            select: { key: true, value: true },
          });
          for (const row of rows) {
            let value = JSON.parse(decryptSecret(row.value), BufferJSON.reviver);
            if (type === 'app-state-sync-key' && value) value = proto.Message.AppStateSyncKeyData.fromObject(value);
            data[row.key.slice(prefix.length)] = value;
          }
          return data;
        },
        // O Baileys manda centenas de chaves de uma vez (pre-keys no pareamento).
        // Gravar tudo em paralelo esgota o pool de conexões; então as remoções
        // vão num deleteMany só e os upserts em lotes sequenciais, cada lote
        // numa transação (= uma conexão).
        set: async (data) => {
          const upserts: { key: string; value: string }[] = [];
          const deletes: string[] = [];
          for (const category of Object.keys(data) as (keyof SignalDataTypeMap)[]) {
            for (const [id, value] of Object.entries(data[category] ?? {})) {
              const key = `${category}-${id}`;
              if (value) upserts.push({ key, value: encryptSecret(JSON.stringify(value, BufferJSON.replacer)) });
              else deletes.push(key);
            }
          }
          if (deletes.length) await prisma.whatsAppAuth.deleteMany({ where: { companyId, key: { in: deletes } } });
          for (let i = 0; i < upserts.length; i += WRITE_BATCH_SIZE) {
            await prisma.$transaction(upserts.slice(i, i + WRITE_BATCH_SIZE).map(({ key, value }) =>
              prisma.whatsAppAuth.upsert({
                where: { companyId_key: { companyId, key } },
                update: { value },
                create: { companyId, key, value },
              })));
          }
        },
      },
    },
    saveCreds: () => writeValue(companyId, CREDS_KEY, creds),
  };
}
