#!/usr/bin/env node
// Executa o Prisma CLI com trava: comandos que apagam ou recriam o banco
// (migrate dev/reset, db push, --force-reset, --accept-data-loss, shadow
// database) só rodam com banco LOCAL (localhost/127.0.0.1/docker). Em banco
// remoto (Supabase, produção) são recusados.
//   npm run prisma:deploy   -> prisma migrate deploy (só aplica o que falta; seguro)
//   npm run prisma:migrate  -> prisma migrate dev (somente banco local)
// Motivo: em 04/10/2026 um shadow database apontado para produção apagou tudo.
require('dotenv/config');
const { spawnSync } = require('child_process');

const args = process.argv.slice(2);
const joined = args.join(' ');
const DESTRUCTIVE = /^(migrate\s+(dev|reset)|db\s+(push|execute))\b|--force-reset|--accept-data-loss|shadow-database-url/i;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', 'postgres', 'db', 'host.docker.internal']);

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^\[|\]$/g, ''); } catch { return null; }
}

if (DESTRUCTIVE.test(joined)) {
  const urls = ['DATABASE_URL', 'DIRECT_URL', 'SHADOW_DATABASE_URL'].map((k) => [k, process.env[k]]).filter(([, v]) => v);
  const remote = urls.filter(([, v]) => !LOCAL_HOSTS.has(hostOf(v) ?? ''));
  const direct = hostOf(process.env.DIRECT_URL ?? '');
  const shadow = hostOf(process.env.SHADOW_DATABASE_URL ?? '');
  if (remote.length || (shadow && shadow === direct)) {
    console.error(`\nBloqueado: "prisma ${joined}" pode apagar dados e o banco configurado não é local:`);
    for (const [k, v] of remote) console.error(`   ${k} -> ${hostOf(v)}`);
    console.error('\nEm banco remoto use só "npm run prisma:deploy" (aplica migrations pendentes sem apagar nada).');
    console.error('Para desenvolver migrations, aponte DATABASE_URL/DIRECT_URL para um Postgres local.\n');
    process.exit(1);
  }
}

const result = spawnSync('npx', ['prisma', ...args], { stdio: 'inherit', shell: process.platform === 'win32' });
process.exit(result.status ?? 1);
