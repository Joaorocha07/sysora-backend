#!/usr/bin/env node
// Confere, só lendo, se o banco está igual ao prisma/schema.prisma e se não há
// migration pendente. Não usa shadow database e não altera nada.
//   npm run db:check
// Diferença = alguém mudou o banco ou o schema fora das migrations: crie a
// migration que falta (à mão) e aplique com "npm run prisma:deploy".
require('dotenv/config');
const { spawnSync } = require('child_process');

const url = process.env.DIRECT_URL || process.env.DATABASE_URL;
if (!url) {
  console.error('Defina DIRECT_URL ou DATABASE_URL no .env.');
  process.exit(1);
}
const run = (args) => spawnSync('npx', ['prisma', ...args], { encoding: 'utf8', shell: process.platform === 'win32' });

const status = run(['migrate', 'status']);
const pending = status.status !== 0;
console.log(pending ? `Migrations: PENDENTES\n${status.stdout.trim()}` : 'Migrations: em dia');

const diff = run(['migrate', 'diff', '--from-url', url, '--to-schema-datamodel', 'prisma/schema.prisma', '--script', '--exit-code']);
if (diff.status === 0) {
  console.log('Schema x banco: iguais');
} else if (diff.status === 2) {
  console.log('Schema x banco: DIFERENTES. SQL que falta numa migration:\n');
  console.log(diff.stdout.trim());
} else {
  console.error('Não foi possível comparar:', (diff.stderr || diff.stdout).trim());
}
process.exit(pending || diff.status !== 0 ? 1 : 0);
