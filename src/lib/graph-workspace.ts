import type { Attachment, ThoughtNode, ThoughtEdge } from '../types';
import {
  validateGraph, createHandoff, applyHostResult, getHandoffStatus, HostHandoffError,
  HOST_MAX_BYTES, type GraphSnapshot, type HostResult, type HostHandoff,
} from './host-handoff';
import { canonicalStringify, sha256Hex } from './context-bundle';

export interface WorkspaceBundle {
  format: 'weft.workspace';
  version: 1;
  id: string;
  projectId: string;
  baseHash: string;
  graph: GraphSnapshot;
  revision: number;
  operations: WorkspaceReceipt[];
}

type EditName = 'add-node' | 'branch' | 'reference' | 'connect' | 'set-question'
  | 'add-attachment' | 'remove-node' | 'remove-edge' | 'move-node' | 'archive-node';
type OperationSummary =
  | { kind: 'edit'; counts: Partial<Record<EditName, number>> }
  | { kind: 'host-result'; target: string; resultId: string; handoffId: string };
export interface WorkspaceReceipt {
  requestId: string;
  requestHash: string;
  baseRevision: number;
  revision: number;
  beforeHash: string;
  afterHash: string;
  operation: OperationSummary;
}

type Edit =
  | { op: 'add-node'; id: string; kind?: 'prompt' | 'note' | 'file'; question?: string; text?: string; position?: { x: number; y: number } }
  | { op: 'branch'; source: string; id: string; question: string; quote?: string }
  | { op: 'reference' | 'connect'; source: string; target: string; id: string }
  | { op: 'set-question'; id: string; text: string }
  | { op: 'add-attachment'; id: string; attachment: Attachment }
  | { op: 'remove-node' | 'remove-edge'; id: string }
  | { op: 'move-node'; id: string; x: number; y: number }
  | { op: 'archive-node'; id: string; archived: boolean };

const MAX_RECEIPTS = 500;
const MAX_OPERATIONS = 500;
const HASH = /^sha256:[0-9a-f]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;
const UNSAFE = new Set(['__proto__', 'prototype', 'constructor']);
const OP_FIELDS: Record<EditName, readonly string[]> = {
  'add-node': ['op', 'id', 'kind', 'question', 'text', 'position'],
  branch: ['op', 'source', 'id', 'question', 'quote'],
  reference: ['op', 'source', 'target', 'id'],
  connect: ['op', 'source', 'target', 'id'],
  'set-question': ['op', 'id', 'text'],
  'add-attachment': ['op', 'id', 'attachment'],
  'remove-node': ['op', 'id'], 'remove-edge': ['op', 'id'],
  'move-node': ['op', 'id', 'x', 'y'], 'archive-node': ['op', 'id', 'archived'],
};
function fail(code: string, message: string): never { throw new HostHandoffError(code, message); }
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function fields(value: unknown, allowed: readonly string[], name: string): asserts value is Record<string, unknown> {
  if (!record(value)) fail('INVALID_SHAPE', `${name} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail('UNKNOWN_FIELD', `${name}.${key} is not supported`);
}
function id(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || !ID.test(value) || UNSAFE.has(value)) fail('INVALID_ID', `${name} must be 1..200 ASCII letters/digits/_.:-, starting with a letter/digit`);
}
function text(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string') fail('INVALID_SHAPE', `${name} must be text`);
}
function finite(value: unknown, name: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail('INVALID_POSITION', `${name} must be finite`);
}
function revision(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) fail('INVALID_REVISION', 'Revision must be a nonnegative safe integer');
}
function hash(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !HASH.test(value)) fail('INVALID_HASH', 'Expected sha256:<64 lowercase hex digits>');
}

// Bound traversal BEFORE stringify/clone/validation. Native optional undefined
// values are accepted; JSON round trips omit object fields and null array holes.
// Accessors, symbols and exotic objects are rejected rather than executed.
function jsonBudget(value: unknown): void {
  const ancestors = new Set<object>();
  let bytes = 0, entries = 0;
  const encoder = new TextEncoder();
  function add(n: number) {
    bytes += n;
    if (bytes > HOST_MAX_BYTES) fail('TOO_LARGE', `Workspace payload exceeds ${HOST_MAX_BYTES} bytes`);
  }
  function stringSize(s: string) {
    if (s.length > HOST_MAX_BYTES) fail('TOO_LARGE', 'String exceeds workspace budget');
    add(encoder.encode(JSON.stringify(s)).byteLength);
  }
  function walk(v: unknown, depth: number): void {
    if (++entries > 250_000) fail('TOO_LARGE', 'JSON entry count exceeds 250000');
    if (depth > 64) fail('TOO_DEEP', 'JSON nesting exceeds 64');
    if (v === undefined || v === null || typeof v === 'boolean') { add(5); return; }
    if (typeof v === 'string') { stringSize(v); return; }
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) fail('INVALID_SHAPE', 'JSON numbers must be finite');
      add(24); return;
    }
    if (typeof v !== 'object') fail('INVALID_SHAPE', 'Only JSON values are accepted');
    const array = Array.isArray(v);
    if (Object.getPrototypeOf(v) !== (array ? Array.prototype : Object.prototype)
      && !(Object.getPrototypeOf(v) === null && !array)) fail('INVALID_SHAPE', 'Only plain JSON objects/arrays are accepted');
    if (ancestors.has(v)) fail('JSON_CYCLE', 'Cyclic JSON value');
    if (array && v.length > 250_000) fail('TOO_LARGE', 'Array exceeds entry budget');
    ancestors.add(v); add(2);
    for (const key of Reflect.ownKeys(v)) {
      if (typeof key !== 'string' || UNSAFE.has(key)) fail('INVALID_KEY', 'Unsafe JSON key');
      if (array && key === 'length') continue;
      if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= v.length)) fail('INVALID_KEY', 'Non-index array property');
      const d = Object.getOwnPropertyDescriptor(v, key)!;
      if (!('value' in d) || !d.enumerable) fail('INVALID_SHAPE', 'Accessors/non-enumerable properties are not JSON');
      stringSize(key); add(2); walk(d.value, depth + 1);
    }
    ancestors.delete(v);
  }
  walk(value, 0);
}
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function snapshot<T>(value: T): T { jsonBudget(value); return structuredClone(value); }
async function digest(value: unknown): Promise<string> {
  return `sha256:${await sha256Hex(canonicalStringify(value))}`;
}

// NOT host-handoff's semanticGraph: workspace concurrency also binds layout,
// collapse, summaries, answer versions, provenance and complete attachment bytes.
// Keep unknown persisted fields, and array ordering (context tie-breaker).
// Sources: types.ts, store/index.ts stripTransient, store/slices/nodes.ts stale
// state, App.tsx displayNodes/displayEdges, and lib/export.ts exportedAt.
const GRAPH_TRANSIENT = new Set([
  'exportedAt', 'viewport', 'selectedNodeId', 'selectedNodeIds', 'sharedReadonly',
  'staleIds', 'staleFps', 'staleVerdicts',
]);
const FLOW_TRANSIENT = new Set([
  'selected', 'measured', 'dragging', 'resizing', 'positionAbsolute',
  'internals', '__rf', 'computedPosition', 'handleBounds',
]);
const DATA_TRANSIENT = new Set([
  'isEditing', 'isEditingResponse', 'isLoading', 'restreaming',
  'pendingApprovals', 'agentTrace', 'recallProgress', 'focusRole', 'tokenCount',
  'stale', 'isStale', 'staleIds', 'staleFps', 'staleVerdicts',
]);
function omit<T extends object>(value: T, keys: Set<string>): T {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.has(key))) as T;
}
function stripRenderClasses<T extends { className?: string }>(value: T): T {
  if (typeof value.className !== 'string') return value;
  const tokens = value.className.split(/\s+/);
  const kept = tokens.filter(c => c && !/^(search-hit|focus-(target|ctx|down|dim)|focus-e-(path|ref|down|dim))$/.test(c));
  if (kept.length !== tokens.length) {
    if (kept.length) value.className = kept.join(' ');
    else delete value.className;
  }
  return value;
}
function normalized(graph: GraphSnapshot): GraphSnapshot {
  // Native export and the live panel share this snapshot contract. Event
  // history and paradigm provenance bind the baseline; the sharing courtesy
  // flag above does not belong to the live graph. Preserve all other fields.
  const out = omit(graph, GRAPH_TRANSIENT);
  out.events = graph.events === undefined ? [] : graph.events;
  out.nodes = graph.nodes.map(n => {
    const node = stripRenderClasses(omit(n, FLOW_TRANSIENT));
    node.data = omit(n.data, DATA_TRANSIENT);
    // validateGraph rejects unresolved vault references before normalization.
    // Hydrated native exports may retain the marker, but portable workspaces
    // must always read their inline bytes rather than the device-local vault.
    if (n.data.attachments) node.data.attachments = n.data.attachments.map(a => omit(a, new Set(['isExtracting', 'contentInVault'])));
    return node;
  });
  out.edges = graph.edges.map(e => {
    const edge = stripRenderClasses(omit(e, FLOW_TRANSIENT));
    if (e.data) edge.data = omit(e.data, new Set(['focusRole']));
    return edge;
  });
  return out;
}
// Persist no live UI activity, but keep required ThoughtData booleans usable by
// the canvas. tokenCount is retained in storage, only excluded from the hash.
function idleGraph(graph: GraphSnapshot): GraphSnapshot {
  const out = normalized(graph);
  out.nodes = out.nodes.map((n, i) => ({ ...n, data: {
    ...n.data, isEditing: false, isEditingResponse: false, isLoading: false,
    tokenCount: graph.nodes[i].data.tokenCount ?? 0,
  } }));
  return out;
}
export async function graphRevision(graph: GraphSnapshot): Promise<string> {
  const g = snapshot(graph);
  validateGraph(g);
  return digest(normalized(g));
}
async function workspaceId(projectId: string, baseHash: string): Promise<string> {
  return `ws_${(await digest({ format: 'weft.workspace', version: 1, projectId, baseHash })).slice(7)}`;
}
export async function createWorkspace(graph: GraphSnapshot): Promise<WorkspaceBundle> {
  const g = snapshot(graph);
  validateGraph(g); id(g.projectId, 'graph.projectId');
  const baseHash = await graphRevision(g);
  const w: WorkspaceBundle = {
    format: 'weft.workspace', version: 1,
    id: await workspaceId(g.projectId, baseHash), projectId: g.projectId, baseHash,
    graph: idleGraph(g), revision: 0, operations: [],
  };
  await validateWorkspace(w);
  return w;
}

function validateSummary(value: unknown): void {
  if (!record(value)) fail('INVALID_RECEIPT', 'Missing operation summary');
  if (value.kind === 'edit') {
    fields(value, ['kind', 'counts'], 'operation');
    fields(value.counts, Object.keys(OP_FIELDS), 'operation.counts');
    let count = 0;
    for (const v of Object.values(value.counts)) {
      if (!Number.isSafeInteger(v) || Number(v) < 1) fail('INVALID_RECEIPT', 'Operation counts must be positive integers');
      count += Number(v);
    }
    if (count < 1 || count > MAX_OPERATIONS) fail('INVALID_RECEIPT', 'Invalid batch count');
  } else if (value.kind === 'host-result') {
    fields(value, ['kind', 'target', 'resultId', 'handoffId'], 'operation');
    for (const key of ['target', 'resultId', 'handoffId']) id(value[key], key);
  } else fail('INVALID_RECEIPT', 'Unknown receipt operation kind');
}
export async function validateWorkspace(value: unknown): Promise<void> {
  const v = snapshot(value);
  fields(v, ['format', 'version', 'id', 'projectId', 'baseHash', 'graph', 'revision', 'operations'], 'workspace');
  if (v.format !== 'weft.workspace' || v.version !== 1) fail('INVALID_WORKSPACE', 'Unsupported workspace format/version');
  id(v.id, 'workspace.id'); id(v.projectId, 'workspace.projectId'); hash(v.baseHash); revision(v.revision);
  validateGraph(v.graph);
  for (const node of v.graph.nodes) for (const attachment of node.data.attachments ?? []) {
    if (attachment.contentInVault === true) fail('UNHYDRATED_ATTACHMENT', `Workspace attachment ${attachment.id} must be inline; contentInVault:true is not allowed`);
  }
  if (v.graph.projectId !== v.projectId) fail('INVALID_WORKSPACE', 'Workspace graph projectId mismatch');
  if (!Array.isArray(v.operations) || v.operations.length > MAX_RECEIPTS || v.revision !== v.operations.length) fail('INVALID_RECEIPT', 'Revision must equal the complete receipt count (maximum 500)');
  const seen = new Set<string>();
  let previous = v.baseHash;
  for (let i = 0; i < v.operations.length; i++) {
    const r = v.operations[i];
    fields(r, ['requestId', 'requestHash', 'baseRevision', 'revision', 'beforeHash', 'afterHash', 'operation'], 'receipt');
    id(r.requestId, 'requestId'); hash(r.requestHash); hash(r.beforeHash); hash(r.afterHash);
    revision(r.baseRevision); revision(r.revision);
    if (seen.has(r.requestId) || r.baseRevision !== i || r.revision !== i + 1 || r.beforeHash !== previous) fail('INVALID_RECEIPT', 'Receipt IDs/revisions/hash chain are inconsistent');
    validateSummary(r.operation);
    seen.add(r.requestId); previous = r.afterHash;
  }
  if (v.id !== await workspaceId(v.projectId, v.baseHash)) fail('HASH_MISMATCH', 'Workspace ID does not bind its project/base');
  if (previous !== await graphRevision(v.graph)) fail('HASH_MISMATCH', 'Workspace graph differs from the final receipt (or revision-zero base)');
}

export async function inspectWorkspace(w: WorkspaceBundle): Promise<object> {
  const copy = snapshot(w);
  await validateWorkspace(copy);
  const currentHash = await graphRevision(copy.graph);
  const counts: Partial<Record<EditName, number>> = {};
  let hostResults = 0;
  for (const r of copy.operations) {
    if (r.operation.kind === 'host-result') hostResults++;
    else for (const [op, count] of Object.entries(r.operation.counts)) counts[op as EditName] = (counts[op as EditName] ?? 0) + count;
  }
  return {
    id: copy.id, projectId: copy.projectId, revision: copy.revision,
    baseHash: copy.baseHash, currentHash, currentGraphHash: currentHash,
    nodes: copy.graph.nodes.map(n => ({ id: n.id, question: n.data.question, kind: n.data.stepKind ?? 'human', archived: !!n.data.archived })),
    edges: copy.graph.edges.length,
    status: getHandoffStatus(copy.graph),
    // No old graph is stored: this is an operation summary, not a fabricated
    // before/after node diff or a claim that an operation changed content.
    changes: { changedFromBase: currentHash !== copy.baseHash, transactions: copy.revision, operationCounts: counts, hostResults },
  };
}

function validateAttachment(value: unknown): void {
  fields(value, ['id', 'name', 'type', 'size', 'addedAt', 'content', 'contentInVault', 'thumbnailUrl', 'extractedText', 'extractedBy', 'pageImages', 'numPages', 'renderMode', 'isExtracting', 'digest', 'digestBy', 'paths', 'op'], 'attachment');
  id(value.id, 'attachment.id');
  if (value.contentInVault === true) fail('UNHYDRATED_ATTACHMENT', 'Workspace attachments must be inline; contentInVault:true is not allowed');
  for (const key of ['name', 'type', 'content']) text(value[key], `attachment.${key}`);
  if (!String(value.type).trim() || !Number.isSafeInteger(value.size) || Number(value.size) < 0) fail('INVALID_ATTACHMENT', 'Invalid attachment type/size');
  for (const key of ['addedAt', 'thumbnailUrl', 'extractedText', 'extractedBy', 'digest', 'digestBy']) if (value[key] !== undefined) text(value[key], key);
  for (const key of ['paths', 'pageImages']) if (value[key] !== undefined && (!Array.isArray(value[key]) || (value[key] as unknown[]).some(v => typeof v !== 'string'))) fail('INVALID_ATTACHMENT', `${key} must be a string array`);
  for (const key of ['contentInVault', 'isExtracting']) if (value[key] !== undefined && typeof value[key] !== 'boolean') fail('INVALID_ATTACHMENT', `${key} must be boolean`);
  if (value.numPages !== undefined && (!Number.isSafeInteger(value.numPages) || Number(value.numPages) < 0)) fail('INVALID_ATTACHMENT', 'Invalid numPages');
  if (value.renderMode !== undefined && (typeof value.renderMode !== 'string' || !['full', 'text-only'].includes(value.renderMode))) fail('INVALID_ATTACHMENT', 'Invalid renderMode');
  if (value.op !== undefined && (typeof value.op !== 'string' || !['read', 'write', 'edit', 'run', 'search', 'fetch', 'agent', 'other'].includes(value.op))) fail('INVALID_ATTACHMENT', 'Invalid attachment op');
}
function parseOperations(value: unknown): Edit[] {
  if (!Array.isArray(value) || !value.length || value.length > MAX_OPERATIONS) fail('INVALID_OPERATIONS', 'Expected 1..500 operations');
  for (const op of value) {
    if (!record(op) || typeof op.op !== 'string' || !Object.hasOwn(OP_FIELDS, op.op)) fail('INVALID_OPERATION', 'Unknown operation; answers may only be written by host results');
    fields(op, OP_FIELDS[op.op as EditName], 'operation'); id(op.id, 'operation.id');
    switch (op.op) {
      case 'add-node':
        if (op.kind !== undefined && (typeof op.kind !== 'string' || !['prompt', 'note', 'file'].includes(op.kind))) fail('INVALID_OPERATION', 'Invalid node kind');
        if (op.question !== undefined) text(op.question, 'question');
        if (op.text !== undefined) text(op.text, 'text');
        if (op.question !== undefined && op.text !== undefined && op.question !== op.text) fail('INVALID_OPERATION', 'question and text aliases disagree');
        if (op.position !== undefined) {
          fields(op.position, ['x', 'y'], 'position'); finite(op.position.x, 'x'); finite(op.position.y, 'y');
        }
        break;
      case 'branch':
        id(op.source, 'source'); text(op.question, 'question');
        if (op.quote !== undefined) text(op.quote, 'quote');
        break;
      case 'reference': case 'connect': id(op.source, 'source'); id(op.target, 'target'); break;
      case 'set-question': text(op.text, 'text'); break;
      case 'add-attachment': validateAttachment(op.attachment); break;
      case 'move-node': finite(op.x, 'x'); finite(op.y, 'y'); break;
      case 'archive-node': if (typeof op.archived !== 'boolean') fail('INVALID_OPERATION', 'archived must be boolean'); break;
    }
  }
  return value as Edit[];
}
function newNode(nodeId: string, question: string, kind: 'prompt' | 'note' | 'file', position = { x: 0, y: 0 }): ThoughtNode {
  return {
    id: nodeId, type: 'thought', position, dragHandle: '.drag-handle',
    data: {
      stepKind: kind, question, response: '', responses: [], responseIndex: -1,
      isCollapsed: false, isEditing: false, isEditingResponse: false, isLoading: false,
      tokenCount: 0, highlights: [], highlightMode: 'tag', attachments: [],
      excludedAttachmentIds: [], includedAttachmentIds: [], roleMode: 'inherit',
      isRoot: true, isBranch: false,
    },
  };
}
function applyEdits(g: GraphSnapshot, operations: Edit[]): void {
  const node = (nodeId: string) => {
    const n = g.nodes.find(n => n.id === nodeId);
    if (!n) fail('NODE_NOT_FOUND', `Node ${nodeId} does not exist`);
    return n;
  };
  const addNode = (n: ThoughtNode) => {
    if (g.nodes.some(old => old.id === n.id)) fail('DUPLICATE_ID', `Duplicate node ${n.id}`);
    g.nodes.push(n);
  };
  const addEdge = (e: ThoughtEdge) => {
    node(e.source); node(e.target);
    if (g.edges.some(old => old.id === e.id)) fail('DUPLICATE_ID', `Duplicate edge ${e.id}`);
    g.edges.push(e);
  };
  let topologyChanged = false;
  for (const op of operations) {
    switch (op.op) {
      case 'add-node': addNode(newNode(op.id, op.question ?? op.text ?? '', op.kind ?? 'prompt', op.position)); break;
      case 'branch': {
        const parent = node(op.source);
        const child = newNode(op.id, op.question, 'prompt', { x: parent.position.x + 360, y: parent.position.y + 240 });
        child.data.branchContext = op.quote ?? '';
        child.data.model = parent.data.model;
        addNode(child);
        // The ID is unambiguous and bounded even when both node IDs are long.
        // A collision fails; there is no random retry or silently replaced edge.
        addEdge({ id: `branch:${op.id}`, source: op.source, target: op.id,
          type: 'smoothstep', sourceHandle: 'branch', targetHandle: 'left',
          data: { isBranchFromSelection: true, branchYRatio: 0.5 } });
        topologyChanged = true; break;
      }
      case 'reference': case 'connect': {
        const cross = op.op === 'reference';
        addEdge({ id: op.id, source: op.source, target: op.target,
          type: 'smoothstep', sourceHandle: cross ? 'branch' : 'continue', targetHandle: cross ? 'left' : 'top',
          style: cross ? { strokeDasharray: '8 4', strokeWidth: 2 } : { strokeWidth: 2 },
          // Native ThoughtEdge represents quote depth by ABSENCE of 'full'.
          data: cross ? { isCrossLink: true } : {},
        });
        topologyChanged = true; break;
      }
      case 'set-question': {
        const d = node(op.id).data;
        if (d.question !== op.text) {
          // Preserve the old question paired with every historical answer.
          d.questions = d.responses.map((_, i) => d.questions?.[i] ?? d.question);
          d.question = op.text;
        }
        break;
      }
      case 'add-attachment': {
        const d = node(op.id).data;
        if (d.attachments?.some(a => a.id === op.attachment.id)) fail('DUPLICATE_ID', `Duplicate attachment ${op.attachment.id}`);
        d.attachments = [...(d.attachments ?? []), op.attachment]; break;
      }
      case 'remove-node':
        node(op.id);
        g.nodes = g.nodes.filter(n => n.id !== op.id);
        g.edges = g.edges.filter(e => e.source !== op.id && e.target !== op.id);
        // validateGraph checks remaining roleSourceNodeId AFTER the full batch,
        // allowing the same batch to remove all nodes that reference this role.
        topologyChanged = true; break;
      case 'remove-edge':
        if (!g.edges.some(e => e.id === op.id)) fail('EDGE_NOT_FOUND', `Edge ${op.id} does not exist`);
        g.edges = g.edges.filter(e => e.id !== op.id); topologyChanged = true; break;
      case 'move-node': node(op.id).position = { x: op.x, y: op.y }; break;
      case 'archive-node': node(op.id).data.archived = op.archived; break;
    }
  }
  if (topologyChanged) for (const n of g.nodes) {
    const incoming = g.edges.filter(e => e.target === n.id && !e.data?.isCrossLink);
    n.data.isRoot = incoming.length === 0;
    n.data.isBranch = incoming.some(e => e.data?.isBranchFromSelection === true);
  }
  validateGraph(g);
}

async function requestGate(w: WorkspaceBundle, payload: unknown, expectedRevision: number, requestId: string): Promise<{ requestHash: string; replay: boolean }> {
  revision(expectedRevision); id(requestId, 'requestId');
  await validateWorkspace(w);
  const requestHash = await digest(payload);
  const old = w.operations.find(r => r.requestId === requestId);
  if (old) {
    if (old.requestHash !== requestHash) fail('IDEMPOTENCY_CONFLICT', 'requestId was already used for a different payload');
    if (old.baseRevision !== expectedRevision) fail('REVISION_CONFLICT', 'A retry must use the original receipt baseRevision');
    return { requestHash, replay: true };
  }
  if (w.revision !== expectedRevision) fail('REVISION_CONFLICT', `Expected revision ${expectedRevision}, current revision ${w.revision}`);
  if (w.operations.length >= MAX_RECEIPTS) fail('RECEIPT_LIMIT', 'Workspace has 500 receipts; accept it and explicitly create a new workspace');
  return { requestHash, replay: false };
}
async function commit(w: WorkspaceBundle, graph: GraphSnapshot, requestId: string, requestHash: string, operation: OperationSummary): Promise<WorkspaceBundle> {
  validateGraph(graph);
  const beforeHash = await graphRevision(w.graph);
  const afterHash = await graphRevision(graph);
  const out: WorkspaceBundle = { ...w, graph: idleGraph(graph), revision: w.revision + 1, operations: [
    ...w.operations, { requestId, requestHash, baseRevision: w.revision, revision: w.revision + 1, beforeHash, afterHash, operation },
  ] };
  await validateWorkspace(out);
  return out;
}
export async function editWorkspace(w: WorkspaceBundle, operations: unknown, expectedRevision: number, requestId: string): Promise<WorkspaceBundle> {
  // Capture EVERY mutable input synchronously before the first await.
  const copy = snapshot(w), ops = parseOperations(snapshot(operations));
  const gate = await requestGate(copy, { kind: 'edit', operations: ops }, expectedRevision, requestId);
  if (gate.replay) return w;
  const graph = clone(copy.graph);
  applyEdits(graph, ops);
  const counts: Partial<Record<EditName, number>> = {};
  for (const op of ops) counts[op.op] = (counts[op.op] ?? 0) + 1;
  return commit(copy, graph, requestId, gate.requestHash, { kind: 'edit', counts });
}
export async function applyWorkspaceResult(w: WorkspaceBundle, result: HostResult, expectedRevision: number, requestId: string): Promise<WorkspaceBundle> {
  const copy = snapshot(w), r = snapshot(result);
  const gate = await requestGate(copy, { kind: 'host-result', result: r }, expectedRevision, requestId);
  if (gate.replay) return w;
  const graph = await applyHostResult(copy.graph, r);
  return commit(copy, graph, requestId, gate.requestHash, {
    kind: 'host-result', target: r.handoff.target, resultId: r.id, handoffId: r.handoff.id,
  });
}

/** Optional shared compile helper; compilation is read-only, not a transaction.
 * The reused host protocol timestamps the handoff; no generation is performed. */
export async function createWorkspaceHandoff(w: WorkspaceBundle, target: string, options: Parameters<typeof createHandoff>[2] = {}): Promise<HostHandoff> {
  const copy = snapshot(w), opts = snapshot(options);
  await validateWorkspace(copy);
  return createHandoff(copy.graph, target, opts);
}
export async function acceptWorkspace(current: GraphSnapshot, w: WorkspaceBundle): Promise<GraphSnapshot> {
  const graph = snapshot(current), copy = snapshot(w);
  validateGraph(graph);
  await validateWorkspace(copy);
  if (graph.projectId !== copy.projectId) fail('SYNC_CONFLICT', 'Cannot sync a workspace into another project');
  const currentHash = await graphRevision(graph), workHash = await graphRevision(copy.graph);
  if (currentHash === workHash) fail('ALREADY_APPLIED', 'The current graph already matches this workspace; no change');
  if (currentHash !== copy.baseHash) fail('SYNC_CONFLICT', 'Current graph changed since workspace creation; export/rebase explicitly');
  return idleGraph(copy.graph);
}
