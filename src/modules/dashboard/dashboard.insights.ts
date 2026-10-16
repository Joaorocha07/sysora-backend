import { prisma } from '../../lib/prisma';
import { stagesOf } from '../pipeline/pipeline.routes';

// Insights do atendimento pelo WhatsApp (aba "Atendimento" do painel), a partir
// da tabela messages. Horas e dias no fuso de Brasília. "Lead" = cliente que
// mandou mensagem.
const TZ = 'America/Sao_Paulo';
const DAY_MS = 86_400_000;

type Row = Record<string, unknown>;
const num = (value: unknown) => (value === null || value === undefined ? 0 : Number(value));

export async function attendanceInsights(companyId: string, days: number, now = new Date()) {
  const since = new Date(now.getTime() - days * DAY_MS);

  const [totals, daily, heat, response, engagement, firstContacts, retention, stageCounts, stages, settings] = await Promise.all([
    prisma.$queryRaw<Row[]>`
      SELECT
        COUNT(*) FILTER (WHERE sender = 'CLIENT') AS inbound,
        COUNT(*) FILTER (WHERE sender = 'BOT') AS bot,
        COUNT(*) FILTER (WHERE sender = 'STAFF') AS staff,
        COUNT(DISTINCT "clientId") FILTER (WHERE sender = 'CLIENT') AS leads
      FROM messages WHERE "companyId" = ${companyId} AND "createdAt" >= ${since}`,
    // Mensagens recebidas e enviadas por dia.
    prisma.$queryRaw<Row[]>`
      SELECT to_char(("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE ${TZ}, 'YYYY-MM-DD') AS day,
        COUNT(*) FILTER (WHERE sender = 'CLIENT') AS inbound,
        COUNT(*) FILTER (WHERE sender <> 'CLIENT') AS outbound
      FROM messages WHERE "companyId" = ${companyId} AND "createdAt" >= ${since}
      GROUP BY 1 ORDER BY 1`,
    // Mensagens recebidas por dia da semana (0 = domingo) e hora.
    prisma.$queryRaw<Row[]>`
      SELECT EXTRACT(DOW FROM ("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE ${TZ})::int AS dow,
        EXTRACT(HOUR FROM ("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE ${TZ})::int AS hour,
        COUNT(*) AS count
      FROM messages WHERE "companyId" = ${companyId} AND "createdAt" >= ${since} AND sender = 'CLIENT'
      GROUP BY 1, 2`,
    // Tempo até a primeira resposta depois de uma mensagem do cliente (bot e equipe separados).
    prisma.$queryRaw<Row[]>`
      WITH m AS (
        SELECT sender, "createdAt",
          LAG(sender) OVER w AS prev_sender, LAG("createdAt") OVER w AS prev_at
        FROM messages WHERE "companyId" = ${companyId} AND "createdAt" >= ${since}
        WINDOW w AS (PARTITION BY "clientId" ORDER BY "createdAt")
      )
      SELECT sender,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM ("createdAt" - prev_at))) AS median,
        AVG(EXTRACT(EPOCH FROM ("createdAt" - prev_at))) AS avg,
        COUNT(*) AS count
      FROM m WHERE prev_sender = 'CLIENT' AND sender <> 'CLIENT'
      GROUP BY sender`,
    // Quantas mensagens cada lead mandou no período.
    prisma.$queryRaw<Row[]>`
      SELECT CASE WHEN n = 1 THEN '1' WHEN n = 2 THEN '2' WHEN n <= 5 THEN '3-5' WHEN n <= 10 THEN '6-10' ELSE '11+' END AS bucket,
        COUNT(*) AS count
      FROM (SELECT "clientId", COUNT(*) AS n FROM messages
            WHERE "companyId" = ${companyId} AND "createdAt" >= ${since} AND sender = 'CLIENT' GROUP BY 1) t
      GROUP BY 1`,
    // Primeiro contato de cada lead (para novos leads e "ghosts": mandou 1 mensagem e sumiu).
    prisma.$queryRaw<Row[]>`
      SELECT c.id, c.name, c.phone, t.first_at, t.total
      FROM (SELECT "clientId", MIN("createdAt") AS first_at, COUNT(*) AS total FROM messages
            WHERE "companyId" = ${companyId} AND sender = 'CLIENT' GROUP BY 1) t
      JOIN clients c ON c.id = t."clientId"
      WHERE t.first_at >= ${since}
      ORDER BY t.first_at DESC`,
    // Tempo desde a última mensagem de cada lead (histórico todo).
    prisma.$queryRaw<Row[]>`
      SELECT
        COUNT(*) FILTER (WHERE "lastInboundAt" >= ${new Date(now.getTime() - 7 * DAY_MS)}) AS active,
        COUNT(*) FILTER (WHERE "lastInboundAt" < ${new Date(now.getTime() - 7 * DAY_MS)} AND "lastInboundAt" >= ${new Date(now.getTime() - 15 * DAY_MS)}) AS cold,
        COUNT(*) FILTER (WHERE "lastInboundAt" < ${new Date(now.getTime() - 15 * DAY_MS)} AND "lastInboundAt" >= ${new Date(now.getTime() - 30 * DAY_MS)}) AS inactive,
        COUNT(*) FILTER (WHERE "lastInboundAt" < ${new Date(now.getTime() - 30 * DAY_MS)}) AS lost
      FROM clients WHERE "companyId" = ${companyId} AND "lastInboundAt" IS NOT NULL`,
    prisma.client.groupBy({ by: ['stageId'], where: { companyId }, _count: true }),
    stagesOf(companyId),
    prisma.companySettings.findUnique({ where: { companyId }, select: { openingTime: true, closingTime: true, workDays: true } }),
  ]);

  const t = totals[0] ?? {};
  const grid = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
  for (const r of heat) grid[num(r.dow)][num(r.hour)] = num(r.count);

  const responseOf = (sender: 'BOT' | 'STAFF') => {
    const r = response.find((x) => x.sender === sender);
    return r ? { median: Math.round(num(r.median)), avg: Math.round(num(r.avg)), count: num(r.count) } : null;
  };

  // Dia (AAAA-MM-DD) em Brasília, qualquer que seja o fuso do servidor.
  const dayInBrazil = (date: Date) => date.toLocaleDateString('en-CA', { timeZone: TZ });
  const contacts = firstContacts.map((r) => ({ id: String(r.id), name: String(r.name), phone: String(r.phone), firstAt: new Date(r.first_at as Date), total: num(r.total) }));
  const ghosts = contacts.filter((c) => c.total === 1 && now.getTime() - c.firstAt.getTime() > DAY_MS);
  const today = contacts.filter((c) => dayInBrazil(c.firstAt) === dayInBrazil(now));

  // Cliente sem etapa conta na primeira.
  const byStage = new Map<string, number>();
  for (const s of stageCounts) {
    const key = s.stageId ?? stages[0]?.id;
    if (key) byStage.set(key, (byStage.get(key) ?? 0) + s._count);
  }

  const r = retention[0] ?? {};
  return {
    days,
    totals: { inbound: num(t.inbound), bot: num(t.bot), staff: num(t.staff), leads: num(t.leads), newLeads: contacts.length },
    daily: daily.map((d) => ({ date: String(d.day), inbound: num(d.inbound), outbound: num(d.outbound) })),
    heat: grid,
    hours: settings ?? { openingTime: '09:00', closingTime: '18:00', workDays: [1, 2, 3, 4, 5, 6] },
    response: { bot: responseOf('BOT'), staff: responseOf('STAFF') },
    engagement: ['1', '2', '3-5', '6-10', '11+'].map((bucket) => ({ bucket, count: num(engagement.find((e) => e.bucket === bucket)?.count) })),
    todayLeads: today.slice(0, 8).map(({ total: _total, ...c }) => c),
    todayCount: today.length,
    ghosts: ghosts.slice(0, 8).map(({ total: _total, ...c }) => c),
    ghostCount: ghosts.length,
    retention: { active: num(r.active), cold: num(r.cold), inactive: num(r.inactive), lost: num(r.lost) },
    funnel: stages.map((s) => ({ id: s.id, name: s.name, won: s.won, count: byStage.get(s.id) ?? 0 })),
  };
}
