// Banco PostgreSQL local para desenvolvimento, sem instalar nada: o pacote
// embedded-postgres traz o executável do Postgres. Os dados ficam em
// sysora/.dados/postgres e sobrevivem entre execuções.
//
// Uso direto: node scripts/local-db.mjs  (Ctrl+C para parar)
// O script iniciar.mjs, na raiz, usa startLocalDb() daqui.
import EmbeddedPostgres from 'embedded-postgres';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export const LOCAL_DB = { port: 54329, user: 'postgres', password: 'postgres', database: 'sysora' };
export const LOCAL_DB_URL = `postgresql://${LOCAL_DB.user}:${LOCAL_DB.password}@localhost:${LOCAL_DB.port}/${LOCAL_DB.database}?schema=public`;

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(here, '..', '..', '.dados', 'postgres');

export async function startLocalDb() {
  const fresh = !fs.existsSync(path.join(dataDir, 'PG_VERSION'));
  if (fresh) fs.rmSync(dataDir, { recursive: true, force: true });
  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: LOCAL_DB.user,
    password: LOCAL_DB.password,
    port: LOCAL_DB.port,
    persistent: true,
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    onLog: () => {},
  });
  if (fresh) await pg.initialise();
  // Parada anterior interrompida deixa o arquivo de trava para trás.
  fs.rmSync(path.join(dataDir, 'postmaster.pid'), { force: true });
  await pg.start();
  if (fresh) await pg.createDatabase(LOCAL_DB.database);
  return { stop: () => pg.stop(), fresh, dataDir };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const db = await startLocalDb();
  console.log(`PostgreSQL local rodando: ${LOCAL_DB_URL}`);
  console.log(`Dados em ${db.dataDir}. Ctrl+C para parar.`);
  const stop = async () => { await db.stop(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  setInterval(() => {}, 1 << 30);
}
