#!/usr/bin/env node
// Trava do banco para o Claude Code (hook PreToolUse em .claude/settings.json).
// Bloqueia, antes de rodar, comandos que apagam ou recriam o banco: prisma
// migrate reset/dev, db push, shadow database, DROP, TRUNCATE, DELETE sem
// WHERE e deleteMany() vazio. Também lê os scripts que o comando executa
// (node x.js, ts-node y.ts, psql -f z.sql). Não há como o agente liberar:
// operações assim são feitas pela pessoa, no terminal, com backup em mãos.
// Motivo: em 04/10/2026 um "prisma migrate diff --shadow-database-url" com o
// banco de produção apagou todos os dados.
const fs = require('fs');
const path = require('path');

const RULES = [
  [/prisma\s+migrate\s+(reset|dev)\b/i, 'prisma migrate reset/dev (pode apagar o banco)'],
  [/prisma\s+db\s+(push|execute)\b/i, 'prisma db push/execute'],
  [/--force-reset|--accept-data-loss/i, '--force-reset / --accept-data-loss'],
  [/shadow-?database-?url|SHADOW_DATABASE_URL/i, 'shadow database (o Prisma apaga esse banco)'],
  [/migrate\s+diff\b[^\n]*--from-migrations/i, 'prisma migrate diff --from-migrations (precisa de shadow database)'],
  [/\bdrop\s+(table|schema|database|owned|view|index|type|column)\b/i, 'DROP'],
  [/\btruncate\s+(table\s+)?["'`\w]/i, 'TRUNCATE'],
  [/\bdelete\s+from\s+["'`]?[\w.]+["'`]?\s*(;|$|["'`)])/im, 'DELETE sem WHERE'],
  [/\.deleteMany\(\s*(\{\s*\}|\{\s*where\s*:\s*\{\s*\}\s*\})?\s*\)/i, 'deleteMany() sem filtro'],
  [/\bdropdb\b|pg_restore\b[^\n]*--clean/i, 'dropdb / pg_restore --clean'],
];

function findIssue(text) {
  for (const [pattern, label] of RULES) if (pattern.test(text)) return label;
  return null;
}

// Arquivos de script citados no comando (relativos ao diretório do comando).
function referencedScripts(command, cwd) {
  const files = [];
  for (const raw of command.match(/[^\s"'|;&<>()]+\.(?:c?js|mjs|ts|sql|py|sh)\b/gi) ?? []) {
    for (const base of [cwd, process.cwd()]) {
      const file = path.resolve(base || '.', raw);
      try {
        if (fs.statSync(file).isFile() && fs.statSync(file).size < 2_000_000) { files.push(file); break; }
      } catch { /* não existe */ }
    }
  }
  return files;
}

let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  let payload;
  try { payload = JSON.parse(input); } catch { process.exit(0); }
  const command = String(payload?.tool_input?.command ?? '');
  if (!command) process.exit(0);

  let issue = findIssue(command);
  let where = 'no comando';
  if (!issue) {
    // Os arquivos da própria trava citam os padrões e não mexem no banco.
    for (const file of referencedScripts(command, payload.cwd).filter((f) => !/db-guard/i.test(path.basename(f)))) {
      issue = findIssue(fs.readFileSync(file, 'utf8'));
      if (issue) { where = `no script ${file}`; break; }
    }
  }
  if (!issue) process.exit(0);

  process.stderr.write(
    `BLOQUEADO pela trava do banco (.claude/hooks/db-guard-hook.js): ${issue} ${where}.\n`
    + 'Comandos que podem apagar ou recriar dados não são executados pelo agente. '
    + 'Explique ao usuário o que precisa ser feito e por quê, e deixe que ele rode manualmente depois de conferir o backup. '
    + 'Para mudar o schema, crie a migration à mão e aplique com "prisma migrate deploy".\n',
  );
  process.exit(2);
});
