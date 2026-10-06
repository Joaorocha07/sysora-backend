import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import * as z from 'zod/v4';
import { env } from '../../config/env';
import { companyHasSora, requireSoraPlan } from '../../lib/aiAccess';
import { countQuota, soraSpend } from '../../lib/aiQuota';
import { recordAiUsage } from '../../lib/aiUsage';
import { salesSummary, type SalesSummary } from '../../lib/sales';
import { addDays, toIsoDate } from '../../lib/time';
import { HttpError } from '../../lib/httpError';
import { prisma } from '../../lib/prisma';
import { ACTION_LABELS, FLOW_ACTIONS, FlowNode, flowSchema } from './whatsapp.flow';

// Sora: assistente de IA (Claude) que monta e ajusta o fluxo do bot a partir
// de uma conversa com o dono da empresa. Ela não fala com o cliente final: só
// devolve um fluxo, que abre no editor como rascunho para o dono revisar e
// salvar. O fluxo é validado pelas mesmas regras do editor (flowSchema).
//
// A saída estruturada não aceita esquemas recursivos, então a Sora devolve as
// etapas numa lista plana (cada uma aponta o parentId) e aqui vira a árvore.

const WEEKDAYS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
const MAX_HISTORY = 20;
// Modelos que aceitam a troca automática de modelo quando um pedido é recusado.
const FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);

const soraNode = z.object({
  id: z.string(),
  parentId: z.string().nullable(),
  label: z.string(),
  type: z.enum(['menu', 'message', 'action', 'end']),
  messages: z.array(z.string()),
  together: z.boolean(),
  prompt: z.string().nullable(),
  action: z.enum(FLOW_ACTIONS).nullable(),
  next: z.enum(['menu', 'parent']).nullable(),
});
type SoraNode = z.infer<typeof soraNode>;

// Mudança proposta no catálogo (serviços e produtos). Só vale depois que o
// dono confirma no chat (sora.service.ts aplica); excluir pede confirmação extra.
const catalogChange = z.object({
  op: z.enum(['create', 'update', 'delete']),
  // update/delete: id do serviço/produto existente (dos dados da empresa); create: null.
  id: z.string().nullable(),
  kind: z.enum(['SERVICE', 'PRODUCT']),
  name: z.string(),
  description: z.string().nullable(),
  priceCents: z.number().int().nullable(),
  durationMinutes: z.number().int().nullable(),
  active: z.boolean().nullable(),
});
export type CatalogChange = z.infer<typeof catalogChange>;

// Mudança proposta nos clientes (cadastrar, editar, excluir). Também só vale
// depois que o dono confirma.
const clientChange = z.object({
  op: z.enum(['create', 'update', 'delete']),
  // update/delete: id do cliente (dos dados da empresa); create: null.
  id: z.string().nullable(),
  name: z.string(),
  // Telefone com DDD (create: obrigatório; update: null mantém o atual).
  phone: z.string().nullable(),
  email: z.string().nullable(),
  notes: z.string().nullable(),
});
export type ClientChange = z.infer<typeof clientChange>;

// Exportado para testes.
export const soraOutput = z.object({
  // Resposta para o dono, em português, curta.
  reply: z.string(),
  // Fluxo completo quando a Sora criou ou mudou algo; null quando só respondeu ou perguntou.
  flow: z.array(soraNode).nullable(),
  // Serviços/produtos a cadastrar, alterar ou excluir; null quando não mexe no catálogo.
  catalog: z.array(catalogChange).nullable(),
  // Clientes a cadastrar, alterar ou excluir; null quando não mexe nos clientes.
  clients: z.array(clientChange).nullable(),
});

export type SoraMessage = { role: 'user' | 'assistant'; text: string };
export type SoraResult = { reply: string; flow: FlowNode | null; catalog: CatalogChange[] | null; clients: ClientChange[] | null; usage: { used: number; limit: number; allowed: boolean } };
// chat: menu Sora (conversa livre, catálogo e fluxo). fluxo: painel do editor do fluxo.
export type SoraMode = 'chat' | 'fluxo';

let client: Anthropic | null = null;
function anthropic(): Anthropic {
  if (!env.ANTHROPIC_API_KEY) throw HttpError.badRequest('A Sora ainda não está configurada neste servidor. Monte o fluxo pelo editor manual.');
  client ??= new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  return client;
}

// Limite mensal em dólares por conta (as empresas da conta dividem), conforme o
// plano: lib/aiQuota.ts -> soraSpend. used/limit em milionésimos de dólar.
export async function soraUsage(companyId: string) {
  return { ...(await soraSpend(companyId)), enabled: Boolean(env.ANTHROPIC_API_KEY), allowed: await companyHasSora(companyId) };
}

const countUse = (companyId: string) => countQuota(companyId, 'sora');

// Árvore -> lista plana (o que a Sora lê e devolve).
export function flatten(root: FlowNode): SoraNode[] {
  const out: SoraNode[] = [];
  const walk = (node: FlowNode, parentId: string | null) => {
    out.push({
      id: node.id, parentId, label: node.label, type: node.type, messages: node.messages, together: node.together,
      prompt: node.prompt ?? null, action: node.action ?? null, next: node.next ?? null,
    });
    if (node.type === 'menu') node.options?.forEach((child) => walk(child, node.id));
  };
  walk(root, null);
  return out;
}

// Lista plana -> árvore, só com os campos que valem para cada tipo (igual ao clean() do editor).
export function buildTree(nodes: SoraNode[]): FlowNode {
  const roots = nodes.filter((n) => !n.parentId);
  if (roots.length !== 1) throw new Error('o fluxo precisa ter exatamente uma etapa inicial (sem parentId)');
  // Ids no formato aceito pelo editor, sem repetição.
  const ids = new Map<string, string>();
  const used = new Set<string>();
  for (const n of nodes) {
    let id = n.id.replace(/[^\w-]/g, '-').slice(0, 36) || 'etapa';
    while (used.has(id)) id = `${id.slice(0, 33)}-${used.size}`;
    used.add(id);
    ids.set(n.id, id);
  }
  const build = (n: SoraNode, seen: Set<string>): FlowNode => {
    if (seen.has(n.id)) throw new Error('o fluxo tem um ciclo');
    seen.add(n.id);
    const base = { id: ids.get(n.id)!, label: n.label.trim(), type: n.type, messages: n.messages.map((m) => m.trim()).filter(Boolean), together: n.together };
    if (n.type === 'menu') {
      const children = nodes.filter((c) => c.parentId === n.id);
      return { ...base, prompt: n.prompt?.trim() || 'Responda com o número:', options: children.map((c) => build(c, seen)) };
    }
    if (n.type === 'action') return { ...base, action: n.action ?? 'agendar' };
    if (n.type === 'message') return { ...base, next: n.next ?? 'menu' };
    return base;
  };
  const tree = build(roots[0], new Set());
  const orphan = nodes.find((n) => n.parentId && !nodes.some((p) => p.id === n.parentId && p.type === 'menu'));
  if (orphan) throw new Error(`a etapa "${orphan.label}" aponta para um parentId que não é um submenu`);
  return tree;
}

function money(cents: number) {
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

const CONTEXT_CLIENTS = 80;

// Vendas = atendimentos concluídos + assinaturas de clientes vendidas, com
// serviços e produtos separados (lib/sales.ts; o painel mostra o mesmo total).
// Datas como no painel e na agenda (toIsoDate).
async function salesContext(companyId: string): Promise<string> {
  const now = new Date();
  const today = toIsoDate(now);
  const monthStart = `${today.slice(0, 8)}01`;
  const monthEnd = toIsoDate(new Date(now.getFullYear(), now.getMonth() + 1, 0));
  const prevStart = toIsoDate(new Date(now.getFullYear(), now.getMonth() - 1, 1));
  const prevEnd = toIsoDate(new Date(now.getFullYear(), now.getMonth(), 0));
  const [day, week, month, lastMonth, upcoming, canceled, noShow, clientsTotal, clientsNew] = await Promise.all([
    salesSummary(companyId, today, today),
    salesSummary(companyId, toIsoDate(addDays(now, -6)), today),
    salesSummary(companyId, monthStart, monthEnd, 8),
    salesSummary(companyId, prevStart, prevEnd),
    prisma.appointment.count({ where: { companyId, status: { in: ['SCHEDULED', 'CONFIRMED'] }, date: { gte: today } } }),
    prisma.appointment.count({ where: { companyId, status: 'CANCELED', date: { gte: monthStart, lte: today } } }),
    prisma.appointment.count({ where: { companyId, status: 'NO_SHOW', date: { gte: monthStart, lte: today } } }),
    prisma.client.count({ where: { companyId } }),
    prisma.client.count({ where: { companyId, createdAt: { gte: new Date(`${monthStart}T00:00:00`) } } }),
  ]);
  const line = (label: string, r: SalesSummary) => `- ${label}: total ${money(r.totalCents)} em ${r.sales} venda(s) | serviços: ${r.services.count} vendido(s), ${money(r.services.cents)} | produtos: ${r.products.count} vendido(s), ${money(r.products.cents)}`;
  const kind = (k: string) => (k === 'PRODUCT' ? 'produto' : 'serviço');
  return [
    `Vendas (atendimentos concluídos e assinaturas/produtos vendidos; hoje é ${today}):`,
    line('Hoje', day),
    line('Últimos 7 dias', week),
    line(`Este mês (${monthStart} a ${monthEnd})`, month),
    line('Mês passado', lastMonth),
    month.top.length
      ? `- Mais vendidos este mês: ${month.top.map((t) => `${t.name} (${kind(t.kind)}, ${t.count}x, ${money(t.cents)})`).join('; ')}`
      : '- Mais vendidos este mês: nenhum ainda.',
    `- Agenda este mês: ${canceled} cancelado(s), ${noShow} falta(s). Agendados daqui para frente: ${upcoming}.`,
    `- Clientes: ${clientsTotal} no total, ${clientsNew} novo(s) este mês.`,
  ].join('\n');
}

async function clientsContext(companyId: string): Promise<string> {
  const clients = await prisma.client.findMany({
    where: { companyId }, orderBy: { updatedAt: 'desc' }, take: CONTEXT_CLIENTS,
    select: { id: true, name: true, phone: true, email: true },
  });
  if (!clients.length) return 'Clientes: nenhum cadastrado ainda.';
  return `Clientes (os ${clients.length} mais recentes; para outros, peça nome ou telefone):\n${clients.map((c) => `- [id ${c.id}] ${c.name}, ${c.phone}${c.email ? `, ${c.email}` : ''}`).join('\n')}`;
}

// Exportado para testes.
export async function companyContext(companyId: string): Promise<string> {
  const company = await prisma.company.findUniqueOrThrow({
    where: { id: companyId },
    include: { settings: true, services: { orderBy: [{ position: 'asc' }, { name: 'asc' }] } },
  });
  const s = company.settings;
  const services = company.services.length
    ? company.services.map((sv) => `- [id ${sv.id}] ${sv.kind === 'PRODUCT' ? 'PRODUTO' : 'SERVIÇO'} ${sv.name}: ${sv.priceCents ? money(sv.priceCents) : 'sem preço'}, ${sv.kind === 'PRODUCT' ? 'pronta entrega (não é agendado)' : `${sv.durationMinutes} min`}${sv.active ? '' : ', INATIVO'}${sv.description ? ` (${sv.description})` : ''}`).join('\n')
    : '- (nenhum serviço cadastrado ainda)';
  const hours = s
    ? `${s.workDays.map((d) => WEEKDAYS[d]).join(', ')}, das ${s.openingTime} às ${s.closingTime}${s.lunchEnabled ? `, com intervalo das ${s.lunchStart} às ${s.lunchEnd}` : ''}`
    : '(não configurado)';
  return [
    `Empresa: ${company.name}`,
    `Catálogo (serviços e produtos):\n${services}`,
    `Horário de atendimento: ${hours}`,
    s ? `Mensagem de boas-vindas atual: "${s.greetingMessage}"` : '',
    await salesContext(companyId),
    await clientsContext(companyId),
  ].filter(Boolean).join('\n\n');
}

// Exportado para testes.
export const INSTRUCTIONS = `Você é a Sora, assistente da Sysora (sistema de agendamento com bot de WhatsApp). Você ajuda o dono da empresa conversando com ele em português do Brasil, de forma simpática e direta: monta e edita o fluxo do bot do WhatsApp, cadastra, altera e exclui serviços, produtos e clientes, responde sobre as vendas da empresa e tira dúvidas sobre o uso do sistema.

Como o fluxo funciona:
- É uma árvore. A etapa inicial (parentId null) é sempre do tipo "menu": envia as mensagens de boas-vindas e mostra as opções numeradas.
- Tipos de etapa:
  - "menu": submenu com novas opções (só etapas do tipo menu têm filhas). Campo "prompt": a pergunta do menu, ex.: "Como posso te ajudar? Responda com o número:".
  - "message": envia mensagens (ex.: endereço, horário, formas de pagamento) e depois volta ao menu principal (next "menu") ou ao menu anterior (next "parent", só faz sentido dentro de um submenu).
  - "action": função pronta do sistema. Valores de "action":
${FLOW_ACTIONS.map((a) => `    - "${a}": ${ACTION_LABELS[a]}`).join('\n')}
    "agendar" conduz sozinho: escolha do serviço -> dia -> horário livre -> confirmação (usa os serviços e horários cadastrados). "meus" deixa o cliente confirmar, remarcar ou cancelar. "servicos" lista serviços e preços cadastrados. "equipe" pausa o bot e passa para um atendente.
  - "end": envia uma despedida e encerra o atendimento.
- "label" é o texto da opção no menu do pai (até 60 caracteres; na etapa inicial use "Início"). O número da opção é colocado sozinho, não escreva "1)".
- "messages": até 5 mensagens por etapa, cada uma até 1000 caracteres. Em "action" são opcionais (vão antes da função). Em "message" e "end", pelo menos uma.
- "together": true junta as mensagens (e o menu) num único balão; false envia separadas.
- Placeholders aceitos nos textos: {nome} (nome do cliente) e {empresa} (nome da empresa).
- Limites: até 9 opções por menu, até 6 níveis de submenus, até 120 etapas no total.
- Ids curtos, só letras minúsculas, números e hífen, únicos. Mantenha os ids das etapas que já existem quando só ajustar algo.
- Use os campos que não se aplicam ao tipo como null (prompt fora de menu, action fora de action, next fora de message).

Antes de criar, entenda o que o dono quer:
- Pedido genérico para criar ou refazer o fluxo inteiro (ex.: "crie um bot para mim", "monta meu fluxo", "faz um bot bom") e você ainda não sabe o essencial: NÃO crie ainda. Devolva flow null e faça, numa única mensagem, de 3 a 5 perguntas curtas e numeradas, só sobre o que você não sabe e que muda o fluxo:
  1. O que o bot precisa resolver para o cliente (agendar, mostrar preços, vender produtos, tirar dúvidas, passar para um atendente...).
  2. O tom das mensagens (mais formal ou descontraído, com ou sem emojis) e como chamar o cliente.
  3. Informações que o cliente costuma perguntar e que não estão nos dados da empresa (endereço, formas de pagamento, estacionamento, políticas de atraso ou cancelamento...).
  4. Se quer alguma opção especial no menu (ex.: promoções, orçamento, pós-atendimento).
  Não pergunte o que os dados da empresa já mostram (serviços, preços, horários): use-os. Termine dizendo que, se preferir, ele pode responder só "pode criar" que você monta com um padrão.
- Depois das respostas (ou se ele disser "pode criar", "tanto faz", "cria do seu jeito"), crie o fluxo completo. O que ele não informou vira um texto claro para completar, como "[seu endereço aqui]".
- Pedido específico (ex.: "adicione uma opção de endereço", "deixe mais simpático", "tire a opção de produtos") ou com detalhes suficientes: faça direto, sem perguntar.
- Se a dúvida for pequena, prefira fazer e dizer o que assumiu a perguntar.

Catálogo (serviços e produtos):
- Quando o dono pedir para cadastrar, alterar, ativar, desativar ou excluir serviços ou produtos, devolva as mudanças em "catalog" (senão, null). Nada entra no sistema sem ele confirmar no botão que aparece abaixo da sua resposta.
- "create": item novo (id null). "update": item existente, com o id que aparece nos dados da empresa, devolvendo todos os campos (os que não mudam, iguais aos atuais).
- "delete": exclui de vez o item (id obrigatório; repita name, kind e os demais campos atuais). Só use quando ele pedir para excluir, apagar, deletar ou remover. Agendamentos antigos continuam com o nome e o preço do item. Na resposta, pergunte se ele tem certeza e lembre que não dá para desfazer; se ele só quiser tirar o item da vista dos clientes, sugira desativar (update com active false).
- kind "SERVICE": tem duração (durationMinutes, mínimo 5) e ocupa horário na agenda. kind "PRODUCT": pronta entrega, durationMinutes null.
- priceCents em centavos (R$ 49,90 = 4990); null se o dono não informou o preço. Nunca invente preço nem duração: se faltar e for importante, pergunte; se ele pedir para cadastrar mesmo assim, deixe null (duração de serviço sem informação: 60).
- name até 60 caracteres; description até 300 (opcional, curta e vendedora, em português).
- Não duplique: se já existe um item com o mesmo nome, use "update".
- Você pode mexer no catálogo, nos clientes e no fluxo no mesmo pedido.

Clientes:
- Quando o dono pedir para cadastrar, alterar ou excluir clientes, devolva as mudanças em "clients" (senão, null). Ele confirma no botão antes de valer.
- "create": id null, name e phone obrigatórios (telefone com DDD, como o dono informou). Nunca invente telefone: se faltar, pergunte. email e notes opcionais (null).
- "update": id do cliente que aparece nos dados da empresa; devolva name, e em phone, email e notes o valor novo ou null para manter o atual.
- "delete": id obrigatório e name. Excluir um cliente apaga também os agendamentos e as conversas dele: diga isso na resposta e pergunte se ele tem certeza.
- Se o cliente não estiver na lista dos mais recentes, peça o nome completo ou o telefone; não invente id.
- Não duplique: se já existe cliente com o mesmo telefone, use "update".

Vendas e números:
- Para perguntas sobre vendas, faturamento, atendimentos e clientes, use só o resumo de vendas dos dados da empresa. Não invente números; se a pergunta for de um período que não está no resumo, diga o que você tem e indique o Painel ou a Agenda para ver mais.
- Venda = atendimento concluído ou assinatura/produto vendido. Ao falar de vendas, explique separado: quanto foi em serviços (quantidade e valor), quanto em produtos (quantidade e valor) e o total somado; cite os mais vendidos quando ajudar. Se um dos dois for zero, diga isso em poucas palavras.

Como responder:
- "reply": o que você fez ou as perguntas que precisa fazer. Ao fazer, 1 a 4 frases curtas; ao perguntar, as perguntas numeradas, uma por linha. Não repita o fluxo inteiro em texto.
- "flow": quando criar ou alterar o fluxo, devolva o fluxo COMPLETO (todas as etapas, inclusive as que não mudaram). Quando só estiver tirando uma dúvida ou pedindo uma informação, use null.
- Use os dados reais da empresa (serviços, preços, horários) nas mensagens. Não invente endereço, telefone, preço ou política que o dono não informou: se precisar, pergunte, ou deixe um texto claro para ele completar, como "[seu endereço aqui]".
- Sempre que fizer sentido, ofereça a opção de agendar e a de falar com a equipe.
- O dono revisa o fluxo no editor antes de salvar; diga isso só na primeira vez que montar um fluxo.
- Você também pode tirar dúvidas sobre como usar a Sysora (agenda, clientes, catálogo, WhatsApp, lembretes, equipe, assinatura) e dar ideias para o atendimento, sem mudar nada (flow, catalog e clients null).`;

export async function askSora(companyId: string, history: SoraMessage[], currentFlow: FlowNode, mode: SoraMode = 'fluxo'): Promise<SoraResult> {
  await requireSoraPlan(companyId);
  const api = anthropic();
  const usage = await soraUsage(companyId);
  if (usage.used >= usage.limit) {
    throw HttpError.forbidden('Você usou todo o limite da Sora deste mês. Ele renova no dia 1º; até lá, use o editor manual. No plano Avançado o limite é maior.');
  }

  const turns = history.slice(-MAX_HISTORY);
  const last = turns[turns.length - 1];
  if (!last || last.role !== 'user') throw HttpError.badRequest('Escreva o que você quer que a Sora faça.');

  const system = [
    { type: 'text' as const, text: INSTRUCTIONS },
    { type: 'text' as const, text: `Dados da empresa (atualizados a cada pedido):\n\n${await companyContext(companyId)}` },
  ];
  const messages: Anthropic.Beta.BetaMessageParam[] = turns.map((t, i) => ({
    role: t.role,
    content: i === turns.length - 1
      ? `${mode === 'fluxo' ? 'Fluxo atual no editor (pode ter alterações ainda não salvas)' : 'Fluxo do bot salvo hoje (o dono está no menu Sora, fora do editor)'}:\n${JSON.stringify(flatten(currentFlow))}\n\nPedido: ${t.text}`
      : t.text,
  }));

  // Uma nova tentativa se o fluxo devolvido não passar nas regras do editor.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await api.beta.messages.parse({
      model: env.SORA_MODEL,
      max_tokens: 16000,
      system,
      messages,
      cache_control: { type: 'ephemeral' },
      output_config: { effort: 'medium', format: betaZodOutputFormat(soraOutput) },
      ...(FALLBACK_MODELS.has(env.SORA_MODEL) ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
    });

    // response.model é o modelo que respondeu (pode ser o substituto, se o principal recusou).
    await recordAiUsage(companyId, 'sora', response.model, response.usage);

    if (response.stop_reason === 'refusal') throw HttpError.badRequest('A Sora não conseguiu atender esse pedido. Tente descrever de outro jeito.');
    if (response.stop_reason === 'max_tokens') throw HttpError.badRequest('O fluxo ficou grande demais para a Sora montar de uma vez. Peça por partes.');
    const output = response.parsed_output;
    if (!output) throw HttpError.badRequest('A Sora não conseguiu responder agora. Tente de novo.');

    const catalog = output.catalog?.length ? output.catalog : null;
    const clients = output.clients?.length ? output.clients : null;
    if (!output.flow) {
      await countUse(companyId);
      return { reply: output.reply, flow: null, catalog, clients, usage: await soraUsage(companyId) };
    }

    let problem: string;
    try {
      const parsed = flowSchema.safeParse(buildTree(output.flow));
      if (parsed.success) {
        await countUse(companyId);
        return { reply: output.reply, flow: parsed.data, catalog, clients, usage: await soraUsage(companyId) };
      }
      problem = parsed.error.issues.map((i) => i.message).join(' ');
    } catch (err) {
      problem = (err as Error).message;
    }
    messages.push(
      { role: 'assistant', content: JSON.stringify(output) },
      { role: 'user', content: `Esse fluxo não passou nas regras do editor: ${problem} Corrija e devolva o fluxo completo.` },
    );
  }

  throw HttpError.badRequest('A Sora não conseguiu montar um fluxo válido. Tente simplificar o pedido ou monte essa parte no editor manual.');
}
