import { CompanySettings } from '@prisma/client';
import { z } from 'zod';

// Fluxo do chatbot montado pela empresa (aba "Fluxo do bot"). É uma árvore:
// a raiz é o menu de boas-vindas e cada opção leva a um nó:
//   menu     -> envia as mensagens e um submenu com novas opções
//   message  -> envia as mensagens e volta ao menu principal ou ao anterior
//   action   -> função pronta do sistema (agendar, agendar pelo link, meus agendamentos...)
//   end      -> envia as mensagens e encerra o atendimento
// "together" junta as mensagens do nó (e o menu) num único balão; desligado,
// cada uma vai separada. Sem fluxo salvo, vale o padrão (o menu clássico).
// A empresa guarda até 5 fluxos (whatsapp.flows.ts); o bot usa o que está em uso.

// 'codigo' e 'trocar' (códigos por e-mail) só funciona nas empresas liberadas pelo admin master
// e fica fora do menu padrão.
// 'link' agenda pela página do link pessoal (booking.service.ts) em vez da conversa.
export const FLOW_ACTIONS = ['agendar', 'link', 'meus', 'servicos', 'equipe', 'codigo', 'trocar'] as const;
const DEFAULT_ACTIONS: FlowAction[] = ['agendar', 'meus', 'servicos', 'equipe'];
export type FlowAction = (typeof FLOW_ACTIONS)[number];
export type FlowNodeType = 'menu' | 'message' | 'action' | 'end';

export type FlowNode = {
  id: string;
  label: string;
  type: FlowNodeType;
  messages: string[];
  together: boolean;
  prompt?: string;
  options?: FlowNode[];
  action?: FlowAction;
  next?: 'menu' | 'parent';
};

export const ACTION_LABELS: Record<FlowAction, string> = {
  agendar: 'Agendar um horário',
  link: 'Agendar pelo link',
  meus: 'Meus agendamentos',
  servicos: 'Serviços e valores',
  equipe: 'Falar com a equipe',
  codigo: 'Receber código de acesso',
  trocar: 'Não consigo gerar imagem',
};

const MAX_OPTIONS = 9;
const MAX_DEPTH = 6;
const MAX_NODES = 120;
export const DEFAULT_PROMPT = 'Como posso te ajudar? Responda com o número:';

const nodeSchema: z.ZodType<FlowNode> = z.lazy(() => z.object({
  id: z.string().regex(/^[\w-]{1,40}$/, 'Identificador de etapa inválido.'),
  label: z.string().trim().max(60, 'O texto de cada opção pode ter até 60 caracteres.'),
  type: z.enum(['menu', 'message', 'action', 'end']),
  messages: z.array(z.string().trim().min(1, 'Mensagem vazia no fluxo.').max(1000)).max(5, 'Use no máximo 5 mensagens por etapa.'),
  together: z.boolean(),
  prompt: z.string().trim().max(300).optional(),
  options: z.array(nodeSchema).max(MAX_OPTIONS, `Cada menu pode ter até ${MAX_OPTIONS} opções.`).optional(),
  action: z.enum(FLOW_ACTIONS).optional(),
  next: z.enum(['menu', 'parent']).optional(),
}));

export const flowSchema = nodeSchema.superRefine((root, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  if (root.type !== 'menu') return fail('O início do fluxo precisa ser um menu.');
  const ids = new Set<string>();
  let count = 0;
  const walk = (node: FlowNode, depth: number, isRoot: boolean) => {
    count += 1;
    if (ids.has(node.id)) fail('Há etapas repetidas no fluxo.');
    ids.add(node.id);
    if (!isRoot && !node.label) fail('Toda opção precisa de um texto.');
    if (node.type === 'menu' && !node.options?.length) fail(isRoot ? 'O menu principal precisa de ao menos uma opção.' : `O submenu "${node.label}" precisa de ao menos uma opção.`);
    if (node.type === 'action' && !node.action) fail(`Escolha a função da opção "${node.label}".`);
    if (node.type === 'message' && !node.messages.length) fail(`A opção "${node.label}" precisa de ao menos uma mensagem.`);
    if (depth > MAX_DEPTH) fail(`O fluxo pode ter até ${MAX_DEPTH} níveis de submenus.`);
    if (node.type === 'menu') node.options?.forEach((child) => walk(child, depth + 1, false));
  };
  walk(root, 0, true);
  if (count > MAX_NODES) fail(`O fluxo pode ter até ${MAX_NODES} etapas.`);
});

// Mesmo comportamento do menu fixo que existia antes do editor.
export function defaultFlow(settings: Pick<CompanySettings, 'greetingMessage'>): FlowNode {
  return {
    id: 'inicio',
    label: 'Início',
    type: 'menu',
    messages: [settings.greetingMessage],
    together: false,
    prompt: DEFAULT_PROMPT,
    options: DEFAULT_ACTIONS.map((action) => ({ id: action, label: ACTION_LABELS[action], type: 'action', action, messages: [], together: true })),
  };
}

// Modelos para um fluxo novo (botão "+" e os dois que toda empresa já recebe).
export const FLOW_TEMPLATES = ['padrao', 'link', 'vazio'] as const;
export type FlowTemplate = (typeof FLOW_TEMPLATES)[number];
export const TEMPLATE_NAMES: Record<FlowTemplate, string> = { padrao: 'Padrão', link: 'Agendamento pelo link', vazio: 'Novo fluxo' };

export function templateFlow(template: FlowTemplate, settings: Pick<CompanySettings, 'greetingMessage'>): FlowNode {
  const base = defaultFlow(settings);
  if (template === 'link') {
    // Igual ao padrão, mas "Agendar um horário" manda o link da agenda.
    return { ...base, options: base.options?.map((o) => (o.action === 'agendar' ? { ...o, action: 'link' as const } : o)) };
  }
  if (template === 'vazio') {
    // Do zero: só as boas-vindas e uma opção (todo menu precisa de ao menos uma).
    return { ...base, messages: ['Olá, {nome}! Bem-vindo(a) à {empresa}.'], options: [{ id: 'equipe', label: ACTION_LABELS.equipe, type: 'action', action: 'equipe', messages: [], together: true }] };
  }
  return base;
}

export const isBookingAction = (action: FlowAction | undefined) => action === 'agendar' || action === 'link';

export function getFlow(settings: Pick<CompanySettings, 'greetingMessage' | 'botFlow'>): FlowNode {
  if (!settings.botFlow) return defaultFlow(settings);
  const parsed = flowSchema.safeParse(settings.botFlow);
  return parsed.success ? parsed.data : defaultFlow(settings);
}

// Nó pelo id e o menu de onde ele saiu.
export function findNode(root: FlowNode, id: string | undefined): { node: FlowNode; parent: FlowNode | null } | null {
  if (!id || root.id === id) return { node: root, parent: null };
  const search = (menu: FlowNode): { node: FlowNode; parent: FlowNode } | null => {
    for (const child of menu.options ?? []) {
      if (child.id === id) return { node: child, parent: menu };
      const found = search(child);
      if (found) return found;
    }
    return null;
  };
  return search(root);
}
