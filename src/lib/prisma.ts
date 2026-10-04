import { AsyncLocalStorage } from 'async_hooks';
import { Prisma, PrismaClient } from '@prisma/client';
import { env } from '../config/env';

declare global {
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
}

const base =
  global.__prisma ??
  new PrismaClient({
    log: env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });

if (env.NODE_ENV !== 'production') {
  global.__prisma = base;
}

// Caixa de areia do simulador do bot (whatsapp.simulator.ts): dentro de
// runSandboxed, todo acesso por `prisma` vai para uma transação que é desfeita
// no fim. Fora dela, `prisma` é o cliente normal.
const sandbox = new AsyncLocalStorage<Prisma.TransactionClient>();

export const prisma = new Proxy(base, {
  get(target, prop) {
    const tx = sandbox.getStore();
    const source = tx ?? target;
    // O cliente da transação não tem $transaction: executa em sequência nela mesma.
    if (tx && prop === '$transaction') {
      return async (arg: unknown) => {
        if (typeof arg === 'function') return (arg as (client: Prisma.TransactionClient) => unknown)(tx);
        const results: unknown[] = [];
        for (const operation of arg as Promise<unknown>[]) results.push(await operation);
        return results;
      };
    }
    const value = Reflect.get(source, prop);
    return typeof value === 'function' ? value.bind(source) : value;
  },
}) as PrismaClient;

// Grava de verdade mesmo durante a simulação (ex.: consumo e custo da IA, que foram pagos).
export const prismaBase = base;

class Rollback extends Error {}

export async function runSandboxed<T>(task: () => Promise<T>): Promise<T> {
  let result: T | undefined;
  try {
    await base.$transaction(async (tx) => {
      result = await sandbox.run(tx, task);
      throw new Rollback();
    }, { timeout: 60_000, maxWait: 10_000 });
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  }
  return result as T;
}
