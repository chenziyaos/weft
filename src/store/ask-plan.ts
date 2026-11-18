import type { ThoughtNode, ThoughtEdge } from '../types';
import { generateId } from '../utils';
import { walkUpAncestors } from '../lib/graph';
import { COLORS } from '../lib/constants';
import type { AddQuestionOptions, StoreState } from './types';

/** The per-ask switches a node is created with (search, recall). */
export interface AskFlags {
  webSearch: boolean;
  scholarSearch: boolean;
  recall: boolean;
  recallReach: 'light' | 'deep' | 'full';
  recallScale: 'lean' | 'standard' | 'generous';
}

export interface AskPlan {
  node: ThoughtNode;
  /** The whole edge list after the ask: parent edge, @-mention references, a split edge rewired. */
  edges: ThoughtEdge[];
  /** How many @-mentions became new reference edges. */
  wired: number;
}

/** The solid edge an ask may split: parent → child, not a branch-from-selection
    wire (that one belongs to the passage it was cut from). */
export function splittableEdge(edges: ThoughtEdge[], edgeId: string | undefined, parentId: string | undefined): ThoughtEdge | undefined {
  if (!edgeId || !parentId) return undefined;
  const e = edges.find((x) => x.id === edgeId);
  if (!e || e.source !== parentId || e.data?.isCrossLink || e.data?.isBranchFromSelection) return undefined;
  return e;
}

/**
 * The node and edges an ask creates, without touching the store: addQuestion
 * commits the plan, the follow-up preview compiles it, so both read the same
 * graph.
 */
export function planAsk(
  st: Pick<StoreState, 'nodes' | 'edges' | 'getInheritedAttachments'>,
  question: string,
  opts: AddQuestionOptions,
  flags: AskFlags,
  id: string = generateId(),
): AskPlan {
  const { parentId, branchContext, inheritRole, rolePrompt, initialAttachments, excludeAllInheritedAttachments, mentions } = opts;
  const isRoot = !parentId;
  // Model follows the LINE, not the toolbar: a child inherits its parent's
  // pinned model, so a deepseek thread stays deepseek even while the
  // global picker sits on something else. No pin on the parent = keep
  // following the global pick (undefined), as before.
  const inheritedModel = parentId ? st.nodes.find((n) => n.id === parentId)?.data.model : undefined;
  const now = new Date().toISOString();
  const node: ThoughtNode = {
    id,
    type: 'thought',
    position: { x: 0, y: 0 },
    dragHandle: '.drag-handle',
    data: {
      question,
      createdAt: now,
      askedAt: now,
      model: inheritedModel,
      response: '',
      responses: [],
      responseIndex: -1,
      isCollapsed: false,
      isEditing: false,
      isEditingResponse: false,
      isLoading: true,
      tokenCount: 0,
      branchContext,
      highlights: [], highlightMode: 'tag', attachments: initialAttachments || [],
      excludedAttachmentIds: excludeAllInheritedAttachments && parentId
        ? st.getInheritedAttachments(parentId).map(({ attachment }) => attachment.id).concat(
            (st.nodes.find((n) => n.id === parentId)?.data.attachments || []).map((a) => a.id)
          )
        : [],
      includedAttachmentIds: [],
      roleMode: inheritRole === false ? 'reset' : 'inherit',
      rolePrompt: rolePrompt || undefined,
      isRoot,
      isBranch: !!branchContext,
      // Search permissions are per-ask: snapshot the toggles shown next to
      // the input, so reruns of this node keep behaving the same way
      webSearch: flags.webSearch,
      scholarSearch: flags.scholarSearch,
      recall: flags.recall,
      recallReach: flags.recallReach,
      recallScale: flags.recallScale,
    },
  };

  const isBranch = !!branchContext;
  const parentEdge: ThoughtEdge | null = parentId ? {
    id: `edge-${parentId}-${id}`,
    source: parentId,
    target: id,
    sourceHandle: isBranch ? 'branch' : 'continue',
    targetHandle: isBranch ? 'left' : 'top',
    type: 'smoothstep',
    ...(isBranch ? {
      style: { stroke: COLORS.warm, strokeWidth: 2 },
      animated: false,
      markerEnd: { type: 'arrowclosed' as const, color: COLORS.warm, width: 18, height: 18 },
      data: { isBranchFromSelection: true, branchYRatio: opts.branchYRatio ?? 0.5 },
    } : {
      style: { stroke: COLORS.accent, strokeWidth: 2 },
      animated: false,
      markerEnd: { type: 'arrowclosed' as const, color: COLORS.accent, width: 18, height: 18 },
      data: {},
    }),
  } : null;

  // Inserting a step: the split edge's target now continues from the new
  // node, keeping everything the edge carried (its place in a merge order).
  // Both edges take the split edge's slot: the layout gives the parent's
  // column to its first child edge, so the chain keeps its column.
  const split = isBranch ? undefined : splittableEdge(st.edges, opts.splitEdgeId, parentId);
  let edges: ThoughtEdge[];
  if (split && parentEdge) {
    edges = st.edges.flatMap((e) => (e.id === split.id
      ? [parentEdge, { ...split, id: `edge-${id}-${split.target}`, source: id, sourceHandle: 'continue' }]
      : [e]));
  } else {
    edges = parentEdge ? [...st.edges, parentEdge] : st.edges;
  }
  // @-mentions: any mentioned node NOT already flowing into this one gets
  // a real dashed reference edge — @ is the keyboard's way of drawing a
  // wire, never an invisible injection. Ones already upstream stay pure
  // designators (their content is in the walk; nothing double-feeds).
  let wired = 0;
  const mentionIds = (mentions ?? []).filter((mid) => mid !== id && mid !== parentId && st.nodes.some((n) => n.id === mid));
  if (mentionIds.length > 0) {
    const structural = edges.filter((e) => !e.data?.isCrossLink);
    const upstream = parentId
      ? new Set(walkUpAncestors(parentId, st.nodes, structural).ordered.map((n) => n.id))
      : new Set<string>();
    const refSources = new Set(edges.filter((e) => e.data?.isCrossLink && e.target === id).map((e) => e.source));
    for (const mid of mentionIds) {
      if (upstream.has(mid) || refSources.has(mid)) continue;
      edges = [...edges, {
        id: `crosslink-${mid}-${id}`,
        source: mid, target: id,
        sourceHandle: 'branch', targetHandle: 'left',
        type: 'smoothstep',
        style: { stroke: COLORS.accent, strokeDasharray: '8 4', strokeWidth: 2 },
        animated: true,
        data: { isCrossLink: true, createdAt: now },
      }];
      refSources.add(mid);
      wired++;
    }
  }
  return { node, edges, wired };
}
