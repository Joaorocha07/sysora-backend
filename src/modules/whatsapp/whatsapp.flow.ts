import { CompanySettings } from '@prisma/client';
import { z } from 'zod';

// Fluxo do chatbot montado pela empresa (aba "Fluxo do bot"). É uma árvore:
// a raiz é o menu de boas-vindas e cada opção leva a um nó:
//   menu     -> envia as mensagens e um submenu com novas opções
//   message  -> envia as mensagens e volta ao menu principal ou ao anterior
//   action   -> função pronta do sistema (agendar, meus agendamentos...)
//   end      -> envia as mensagens e encerra o atendimento
// "together" junta as mensagens do nó (e o menu) num único balão; desligado,
// cada uma vai separada. Sem fluxo salvo, vale o padrão (o menu clássico).

// 'codigo' e 'trocar' (códigos por e-mail) só funciona nas empresas liberadas pelo admin master
// e fica fora do menu padrão.
export const FLOW_ACTIONS = ['agendar', 'meus', 'servicos', 'equipe', 'codigo', 'trocar'] as const;
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
