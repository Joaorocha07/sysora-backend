import fs from 'fs';
import path from 'path';
import { NextFunction, Request, Response } from 'express';
import { prisma } from './prisma';

// Trava do schema: compara as migrations da pasta prisma/migrations com as
// aplicadas no banco (_prisma_migrations). Se faltar alguma (ou o banco foi
// apagado), a API responde 503 "em manutenção" em vez de erros 500 confusos,
// e as tarefas em segundo plano (lembretes do WhatsApp) não rodam. Confere de
// novo a cada minuto: aplicou "npm run prisma:deploy", volta sozinho.

type SchemaState = { ok: boolean; checkedAt: Date | null; pending: string[]; error: string | null };
export const schemaState: SchemaState = { ok: true, checkedAt: null, pending: [], error: null };

const RECHECK_MS = 60_000;

function expectedMigrations(): string[] | null {
  const dir = path.join(process.cwd(), 'prisma', 'migrations');
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  } catch {
    // Sem a pasta (build sem o prisma/): não dá para comparar, não trava.
    return null;
  }
}

export async function checkSchema(): Promise<SchemaState> {
  const expected = expectedMigrations();
  try {
    const rows = await prisma.$queryRaw<{ migration_name: string }[]>`
      SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`;
    const applied = new Set(rows.map((r) => r.migration_name));
    schemaState.pending = expected ? expected.filter((name) => !applied.has(name)) : [];
    schemaState.error = null;
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    // Tabela de controle sumiu: banco vazio ou apagado.
    if (/_prisma_migrations/.test(message) && /does not exist|não existe/i.test(message)) {
      schemaState.pending = expected ?? ['(banco sem migrations)'];
      schemaState.error = 'A tabela _prisma_migrations não existe.';
    } else {
      // Banco fora do ar: não é problema de schema, os erros normais aparecem.
      schemaState.error = `Não foi possível consultar o banco: ${message.slice(0, 200)}`;
      schemaState.checkedAt = new Date();
      return schemaState;
    }
  }
  const wasOk = schemaState.ok;
  schemaState.ok = schemaState.pending.length === 0;
  schemaState.checkedAt = new Date();
  if (!schemaState.ok) {
    console.error(`\n[schema] Banco desatualizado: ${schemaState.pending.length} migration(s) pendente(s): ${schemaState.pending.join(', ')}`);
    console.error('[schema] A API responde 503 até rodar "npm run prisma:deploy" (não apaga dados).\n');
  } else if (!wasOk) {
    console.log('[schema] Banco em dia de novo. API liberada.');
  }
  return schemaState;
}

export function startSchemaWatch(): void {
  setInterval(() => { checkSchema().catch(() => {}); }, RECHECK_MS).unref();
}

export function requireSchema(_req: Request, res: Response, next: NextFunction) {
  if (schemaState.ok) return next();
  return res.status(503).json({
    error: {
      code: 'DATABASE_NOT_READY',
      message: 'O sistema está em manutenção. Tente novamente em alguns minutos.',
    },
  });
}
