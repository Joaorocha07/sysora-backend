import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import * as z from 'zod/v4';
import { env } from '../../config/env';
import { companyHasAi, requireAiPlan } from '../../lib/aiAccess';
import { recordAiUsage } from '../../lib/aiUsage';
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

const soraOutput = z.object({
  // Resposta para o dono, em português, curta.
  reply: z.string(),
  // Fluxo completo quando a Sora criou ou mudou algo; null quando só respondeu ou perguntou.
  flow: z.array(soraNode).nullable(),
});

export type SoraMessage = { role: 'user' | 'assistant'; text: string };
export type SoraResult = { reply: string; flow: FlowNode | null; usage: { used: number; limit: number; allowed: boolean } };

let client: Anthropic | null = null;
function anthropic(): Anthropic {
  if (!env.ANTHROPIC_API_KEY) throw HttpError.badRequest('A Sora ainda não está configurada neste servidor. Monte o fluxo pelo editor manual.');
  client ??= new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  return client;
}

const monthKey = (d = new Date()) => d.toISOString().slice(0, 7);

export async function soraUsage(companyId: string) {
  const settings = await prisma.companySettings.findUnique({ where: { companyId }, select: { soraMonth: true, soraCount: true } });
  const used = settings?.soraMonth === monthKey() ? settings.soraCount : 0;
  return { used, limit: env.SORA_MONTHLY_LIMIT, enabled: Boolean(env.ANTHROPIC_API_KEY), allowed: await companyHasAi(companyId) };
}

async function countUse(companyId: string) {
  const month = monthKey();
  const settings = await prisma.companySettings.findUniqueOrThrow({ where: { companyId }, select: { soraMonth: true } });
  await prisma.companySettings.update({
    where: { companyId },
    data: settings.soraMonth === month ? { soraCount: { increment: 1 } } : { soraMonth: month, soraCount: 1 },
  });
}

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

async function companyContext(companyId: string): Promise<string> {
  const company = await prisma.company.findUniqueOrThrow({
    where: { id: companyId },
    include: { settings: true, services: { where: { active: true }, orderBy: [{ position: 'asc' }, { name: 'asc' }] } },
  });
  const s = company.settings;
  const services = company.services.length
    ? company.services.map((sv) => `- ${sv.name}: ${money(sv.priceCents)}, ${sv.durationMinutes} min${sv.description ? ` (${sv.description})` : ''}`).join('\n')
    : '- (nenhum serviço cadastrado ainda)';
  const hours = s
    ? `${s.workDays.map((d) => WEEKDAYS[d]).join(', ')}, das ${s.openingTime} às ${s.closingTime}${s.lunchEnabled ? `, com intervalo das ${s.lunchStart} às ${s.lunchEnd}` : ''}`
    : '(não configurado)';
  return [
    `Empresa: ${company.name}`,
    `Serviços ativos:\n${services}`,
    `Horário de atendimento: ${hours}`,
    s ? `Mensagem de boas-vindas atual: "${s.greetingMessage}"` : '',
  ].filter(Boolean).join('\n\n');
}

const INSTRUCTIONS = `Você é a Sora, assistente do Sysora (sistema de agendamento com bot de WhatsApp). Você ajuda o dono da empresa a montar o fluxo de menus do bot conversando com ele em português do Brasil, de forma simpática e direta.

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

Como responder:
- "reply": o que você fez ou a pergunta que precisa fazer, em 1 a 4 frases curtas. Não repita o fluxo inteiro em texto.
- "flow": quando criar ou alterar o fluxo, devolva o fluxo COMPLETO (todas as etapas, inclusive as que não mudaram). Quando só estiver tirando uma dúvida ou pedindo uma informação, use null.
- Use os dados reais da empresa (serviços, preços, horários) nas mensagens. Não invente endereço, telefone, preço ou política que o dono não informou: se precisar, pergunte, ou deixe um texto claro para ele completar, como "[seu endereço aqui]".
- Sempre que fizer sentido, ofereça a opção de agendar e a de falar com a equipe.
- O dono revisa o fluxo no editor antes de salvar; diga isso só na primeira vez que montar um fluxo.`;

export async function askSora(companyId: string, history: SoraMessage[], currentFlow: FlowNode): Promise<SoraResult> {
  await requireAiPlan(companyId);
  const api = anthropic();
  const usage = await soraUsage(companyId);
  if (usage.used >= usage.limit) {
    throw HttpError.forbidden(`Você usou os ${usage.limit} pedidos à Sora deste mês. O limite renova no dia 1º; até lá, use o editor manual.`);
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
      ? `Fluxo atual no editor (pode ter alterações ainda não salvas):\n${JSON.stringify(flatten(currentFlow))}\n\nPedido: ${t.text}`
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

    if (!output.flow) {
      await countUse(companyId);
      return { reply: output.reply, flow: null, usage: await soraUsage(companyId) };
    }

    let problem: string;
    try {
      const parsed = flowSchema.safeParse(buildTree(output.flow));
      if (parsed.success) {
        await countUse(companyId);
        return { reply: output.reply, flow: parsed.data, usage: await soraUsage(companyId) };
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
