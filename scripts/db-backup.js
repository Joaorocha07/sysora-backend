#!/usr/bin/env node
// Backup lógico do banco: lê todas as tabelas pelo Prisma (só leitura) e grava
// em backups/sysora-AAAA-MM-DD-HHMM.json.gz. Não precisa de pg_dump.
//   npm run db:backup
// Rode antes de qualquer mudança grande no banco. A pasta backups/ não vai
// para o git: tem dados pessoais (LGPD), guarde em lugar seguro.
// O backup diário automático fica em .github/workflows/db-backup.yml (pg_dump).
require('dotenv/config');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { PrismaClient, Prisma } = require('@prisma/client');

const prisma = new PrismaClient();

(async () => {
  const startedAt = new Date();
  const data = {};
  let rows = 0;
  for (const model of Prisma.dmmf.datamodel.models) {
    const key = model.name[0].toLowerCase() + model.name.slice(1);
    data[model.name] = await prisma[key].findMany();
    rows += data[model.name].length;
    console.log(`${model.name.padEnd(24)} ${data[model.name].length}`);
  }
  const dir = path.join(__dirname, '..', 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = startedAt.toISOString().slice(0, 16).replace('T', '-').replace(':', '');
  const file = path.join(dir, `sysora-${stamp}.json.gz`);
  const body = JSON.stringify({ createdAt: startedAt, models: data });
  fs.writeFileSync(file, zlib.gzipSync(body));
  console.log(`\nBackup salvo: ${file} (${rows} linhas, ${(fs.statSync(file).size / 1024).toFixed(0)} KB)`);
  await prisma.$disconnect();
})().catch(async (err) => {
  console.error('Falha no backup:', err);
  await prisma.$disconnect();
  process.exit(1);
});
