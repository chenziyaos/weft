import { baseDirective, TOOL_DIRECTIVE } from '../../runtime/directives.mjs';
import type { ContextMessage, ImageAttachment, ToolPrefs } from './api';
import { isAgentModel } from './agents/agent-runtime';
import { directProvider } from './direct-llm';
import { memoryContextBlock } from './memory';
import { useUiStore } from './ui-store';
import { countTokens } from '../utils';
import { askContext, applyRoleOverride, insertAfterLastAnswer, resolveExplicitRole } from '../store/context-builder';
import { planAsk, type AskFlags } from '../store/ask-plan';
import type { AddQuestionOptions, StoreState } from '../store/types';

// One reading of a request, for the follow-up preview (before sending) and
// the per-answer receipt (after): the same rows, the same labels, the same
// system additions the lane puts in front.

export type Lane = 'agent' | 'direct' | 'proxy';
export type RowKind = 'addition' | 'role' | 'material' | 'reference' | 'question' | 'answer' | 'passage' | 'memory' | 'recall' | 'ask';

export interface RequestRow {
  kind: RowKind;
  role: ContextMessage['role'];
  content: string;
  tokens: number;
  /** Known to come, content decided at send time (recall searches then). */
  pending?: boolean;
}

/** Stands in for the recall block in a preview: recall searches when the question is sent. */
export const RECALL_PENDING = '\u0000recall-pending';

/** Which lane a model's request leaves on — it decides the system additions. */
export function laneFor(model: string | undefined): Lane {
  if (model && isAgentModel(model) && typeof window !== 'undefined' && window.desktopAgents) return 'agent';
  if (directProvider(model)) return 'direct';
  return 'proxy';
}

/** The text a lane puts in front of the canvas context. The proxy adds the
    tool directive only when the model is handed search tools; an agent
    runtime brings its own system prompt, which Weft does not see. */
export function systemAdditions(lane: Lane, tools: ToolPrefs, date = new Date()): string[] {
  if (lane === 'agent') return [];
  const out = [baseDirective(date)];
  if (lane === 'proxy' && (tools.web || tools.scholar || tools.mcp)) out.push(TOOL_DIRECTIVE);
  return out;
}

function kindOf(m: ContextMessage, isLast: boolean): RowKind {
  if (m.role === 'system') return 'role';
  if (m.role === 'assistant') return 'answer';
  if (isLast) return 'ask';
  const c = m.content;
  if (c === RECALL_PENDING || c.startsWith('[Recall]')) return 'recall';
  if (c.startsWith('[Memory]')) return 'memory';
  if (c.startsWith('[Reference:')) return 'reference';
  if (c.startsWith('[Regarding this passage:')) return 'passage';
  if (/^\[(Note|Link snapshot|File|PDF|Image|Files this turn touched)\b/.test(c)) return 'material';
  return 'question';
}

/** Rows in the order the model reads them: the lane's base directive, the
    canvas role, the tool directive (together they form the system prompt),
    then the conversation with the question last. */
export function requestRows(additions: string[], messages: ContextMessage[]): RequestRow[] {
  const row = (kind: RowKind, role: ContextMessage['role'], content: string): RequestRow => (content === RECALL_PENDING
    ? { kind, role, content: '', tokens: 0, pending: true }
    : { kind, role, content, tokens: countTokens(content) });
  const [base, ...rest] = additions;
  const rows: RequestRow[] = [];
  if (base) rows.push(row('addition', 'system', base));
  messages.filter((m) => m.role === 'system').forEach((m) => rows.push(row('role', 'system', m.content)));
  rest.forEach((a) => rows.push(row('addition', 'system', a)));
  const convo = messages.filter((m) => m.role !== 'system');
  convo.forEach((m, i) => rows.push(row(kindOf(m, i === convo.length - 1), m.role, m.content)));
  return rows;
}

/** The whole request as plain text, for the clipboard. */
export function requestText(rows: RequestRow[], labels: Record<RowKind, string>, pendingText: string): string {
  return rows.map((r) => `### ${r.role} · ${labels[r.kind]}\n${r.pending ? pendingText : r.content}`).join('\n\n');
}

export interface AskPreview {
  rows: RequestRow[];
  images: ImageAttachment[];
  lane: Lane;
  /** @-mentions that sending will wire as new references. */
  wired: number;
}

const PREVIEW_ID = '__preview__';

/**
 * What sending this draft from `opts.parentId` will put on the wire: the node
 * addQuestion would create (planAsk), compiled the way addQuestion compiles
 * it (askContext), plus the generation-time blocks and the lane's additions.
 */
export function previewAsk(
  st: Pick<StoreState, 'nodes' | 'edges' | 'getInheritedAttachments'>,
  draft: string,
  opts: AddQuestionOptions,
  staleIds?: ReadonlySet<string> | string[],
): AskPreview {
  const ui = useUiStore.getState();
  // the recall menu's one-ask choice is read, not spent: only sending spends it
  const o = ui.recallOverride;
  const flags: AskFlags = {
    webSearch: ui.webSearchEnabled,
    scholarSearch: ui.scholarSearchEnabled,
    recall: o?.enabled ?? ui.recallEnabled,
    recallReach: o?.reach ?? ui.recallReach,
    recallScale: o?.scale ?? ui.recallScale,
  };
  const plan = planAsk(st, draft, opts, flags, PREVIEW_ID);
  const nodes = [...st.nodes, plan.node];
  const ctx = askContext(PREVIEW_ID, nodes, plan.edges, staleIds);
  const parent = opts.parentId ? st.nodes.find((n) => n.id === opts.parentId) : undefined;
  applyRoleOverride(ctx.messages, resolveExplicitRole(plan.node.data, parent?.data, !!opts.parentId));
  let messages: ContextMessage[] = [...ctx.messages, { role: 'user', content: draft }];
  const mem = memoryContextBlock();
  if (mem) messages = insertAfterLastAnswer(messages, mem);
  if (flags.recall) messages = insertAfterLastAnswer(messages, { role: 'user', content: RECALL_PENDING });
  const lane = laneFor(plan.node.data.model ?? ui.selectedModel ?? undefined);
  const additions = systemAdditions(lane, { web: flags.webSearch, scholar: flags.scholarSearch, mcp: ui.mcpEnabled });
  return { rows: requestRows(additions, messages), images: ctx.images, lane, wired: plan.wired };
}
