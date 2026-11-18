import { create } from 'zustand';
import { useStore } from '../store';
import { API_BASE } from './constants';
import { isViewerMode } from './viewer';
import { toast } from './ui-store';
import { t, fmt, type MessageKey } from '../i18n';
import { flushPendingWrites } from './persistence';
import { captureSource, hydrate, sourceIsCurrent } from './live-graph';
import { createWorkspace, editWorkspace, graphRevision } from './graph-workspace';
import { applyHostResult, createHandoff, getHandoffStatus, HostHandoffError, type GraphSnapshot, type HostResult } from './host-handoff';
import { canonicalStringify, sha256Hex } from './context-bundle';
import { autoLayout } from './layout';

// Live canvas bridge, page side. A local agent sends the same operations a
// workspace file accepts; they are validated and applied by the workspace
// core against the open canvas, then published to the store like any other
// edit (undoable, logged, persisted). Only the page applies: the relay in
// server.mjs routes requests and replies, nothing more.

type BridgeState = 'off' | 'connecting' | 'on' | 'error';
export interface BridgeActivity { at: string; kind: string; ok: boolean; summary: string }
export const useCanvasBridge = create<{ state: BridgeState; error: string; activity: BridgeActivity[] }>(() => ({
  state: 'off', error: '', activity: [],
}));

type Request = { id: string; kind: 'inspect' | 'edit' | 'compile' | 'apply-result'; payload: Record<string, unknown> };
type Reply = { ok: true; result: unknown } | { ok: false; error: { code: string; message: string } };

let stream: EventSource | null = null;
let queue: Promise<void> = Promise.resolve();
/** requestId → hash of its payload and the reply it got; a retry replays the reply. */
const done = new Map<string, { requestHash: string; reply: Reply }>();

function fail(code: string, message: string): never { throw new HostHandoffError(code, message); }

function note(kind: string, ok: boolean, summary: string) {
  const activity = [{ at: new Date().toISOString(), kind, ok, summary }, ...useCanvasBridge.getState().activity].slice(0, 20);
  useCanvasBridge.setState({ activity });
}

function assertWritable() {
  if (isViewerMode) fail('READ_ONLY', 'This canvas is open read-only');
  const { nodes } = useStore.getState();
  if (nodes.some((n) => n.data.isLoading)) fail('CANVAS_BUSY', 'The canvas is generating an answer; retry when it finishes');
}

function assertProject(payload: Record<string, unknown>, source: ReturnType<typeof captureSource>) {
  if (source.switching) fail('CANVAS_BUSY', 'The canvas is switching projects; retry shortly');
  if (!source.projectId) fail('NO_PROJECT', 'No project is open');
  if (payload.projectId !== undefined && payload.projectId !== source.projectId) {
    fail('PROJECT_MISMATCH', `The open canvas is project ${source.projectId}, not ${String(payload.projectId)}`);
  }
}

async function liveHash(): Promise<string> {
  return graphRevision(await hydrate(captureSource()));
}

async function liveGraph(payload: Record<string, unknown>) {
  const source = captureSource();
  assertProject(payload, source);
  const graph = await hydrate(source);
  const hash = await graphRevision(graph);
  if (typeof payload.expectedHash === 'string' && payload.expectedHash !== hash) {
    fail('REVISION_CONFLICT', `The canvas changed since ${payload.expectedHash}; inspect again (current ${hash})`);
  }
  return { source, graph, hash };
}

function edgeKind(e: GraphSnapshot['edges'][number]): string {
  if (e.data?.isWatch) return 'watch';
  if (e.data?.isCrossLink) return e.data.contextDepth === 'full' ? 'reference-full' : 'reference';
  if (e.data?.isBranchFromSelection) return 'branch';
  return 'solid';
}

function inspect(graph: GraphSnapshot, hash: string) {
  const excerpt = (s: string | undefined, n: number) => !s ? '' : s.length > n ? `${s.slice(0, n)}…` : s;
  return {
    projectId: graph.projectId, name: graph.name, hash,
    nodes: graph.nodes.map((n) => ({
      id: n.id, kind: n.data.stepKind ?? 'human', question: n.data.question,
      answer: excerpt(n.data.response, 400), versions: n.data.responses?.filter(Boolean).length ?? 0,
      archived: !!n.data.archived, position: n.position,
      ...(n.data.model ? { model: n.data.model } : {}),
      ...(n.data.branchContext ? { quote: excerpt(n.data.branchContext, 200) } : {}),
    })),
    edges: graph.edges.map((e) => ({ id: e.id, source: e.source, target: e.target, kind: edgeKind(e) })),
    status: getHandoffStatus(graph),
  };
}

function publish(source: ReturnType<typeof captureSource>, next: GraphSnapshot, withEdges: boolean) {
  if (!sourceIsCurrent(source)) fail('REVISION_CONFLICT', 'The canvas changed while the request was applied; inspect again');
  const st = useStore.getState();
  st.pushHistory();
  useStore.setState(withEdges ? { nodes: next.nodes, edges: next.edges } : { nodes: next.nodes });
  st.pushHistory();
  st.recomputeStaleness(false);
}

const OP_LABEL: Record<string, MessageKey> = {
  'add-node': 'bridge.opAddNode', branch: 'bridge.opBranch', reference: 'bridge.opReference', connect: 'bridge.opConnect',
  'set-question': 'bridge.opSetQuestion', 'add-attachment': 'bridge.opAttachment', 'remove-node': 'bridge.opRemoveNode',
  'remove-edge': 'bridge.opRemoveEdge', 'move-node': 'bridge.opMove', 'archive-node': 'bridge.opArchive',
};

const TOPOLOGY = ['add-node', 'branch', 'reference', 'connect', 'remove-node', 'remove-edge'];

async function edit(payload: Record<string, unknown>) {
  assertWritable();
  const { source, graph, hash } = await liveGraph(payload);
  const requestId = String(payload.requestId ?? '');
  const ws = await createWorkspace(graph);
  const out = await editWorkspace(ws, payload.operations, 0, requestId);
  const receipt = out.operations[out.operations.length - 1];
  const counts = receipt.operation.kind === 'edit' ? receipt.operation.counts : {};
  // Topology changes are laid out the way asking on the canvas lays them out:
  // by the arrows, chains aligned. Explicit moves in the same batch yield to it.
  const next = TOPOLOGY.some((op) => op in counts)
    ? { ...out.graph, nodes: autoLayout(out.graph.nodes, out.graph.edges) }
    : out.graph;
  publish(source, next, true);
  const st = useStore.getState();
  st.logEvent('agent-edit', undefined, { ...counts, request: requestId });
  const summary = Object.entries(counts).map(([op, n]) => `${OP_LABEL[op] ? t(OP_LABEL[op]) : op} ×${n}`).join(' · ');
  toast('info', fmt(t('bridge.edited'), { summary }), 8000, { label: t('bridge.undo'), run: () => useStore.getState().undo() });
  return { summary, result: { projectId: graph.projectId, requestId, beforeHash: hash, afterHash: await liveHash(), counts } };
}

async function applyResult(payload: Record<string, unknown>) {
  assertWritable();
  const { source, graph, hash } = await liveGraph(payload);
  const result = payload.result as HostResult;
  const next = await applyHostResult(graph, result);
  publish(source, next, false);
  await flushPendingWrites();
  const target = result.handoff.target;
  const node = next.nodes.find((n) => n.id === target)!;
  const receipts = (node.data as { hostReceipts?: { responseIndex: number }[] }).hostReceipts ?? [];
  const receipt = receipts[receipts.length - 1];
  useStore.getState().logEvent('agent-edit', target, { result: result.id, host: result.host });
  toast('info', fmt(t('bridge.answered'), { host: result.host }), 8000, { label: t('bridge.undo'), run: () => useStore.getState().undo() });
  return {
    summary: `${result.host} → ${target}`,
    result: { projectId: graph.projectId, target, beforeHash: hash, afterHash: await liveHash(), responseIndex: receipt?.responseIndex, receipt },
  };
}

async function handle(req: Request): Promise<{ reply: Reply; summary: string }> {
  const payload = req.payload ?? {};
  switch (req.kind) {
    case 'inspect': {
      const { graph, hash } = await liveGraph(payload);
      return { reply: { ok: true, result: inspect(graph, hash) }, summary: `${graph.nodes.length} nodes` };
    }
    case 'compile': {
      const { graph } = await liveGraph(payload);
      const handoff = await createHandoff(graph, String(payload.target ?? ''), {
        host: typeof payload.host === 'string' ? payload.host : undefined, allowStale: payload.allowStale === true,
      });
      return { reply: { ok: true, result: handoff }, summary: `→ ${handoff.target}` };
    }
    case 'edit': case 'apply-result': {
      const requestId = String(payload.requestId ?? '');
      const requestHash = await sha256Hex(canonicalStringify({ kind: req.kind, operations: payload.operations, result: payload.result }));
      const prior = requestId ? done.get(requestId) : undefined;
      if (prior) {
        if (prior.requestHash !== requestHash) fail('IDEMPOTENCY_CONFLICT', 'requestId was already used for a different payload');
        return { reply: prior.reply, summary: 'replay' };
      }
      const { result, summary } = req.kind === 'edit' ? await edit(payload) : await applyResult(payload);
      const reply: Reply = { ok: true, result };
      if (requestId) done.set(requestId, { requestHash, reply });
      return { reply, summary };
    }
  }
}

async function serve(req: Request) {
  let reply: Reply, summary: string;
  try {
    ({ reply, summary } = await handle(req));
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? String((err as { code: unknown }).code) : 'CANVAS_ERROR';
    reply = { ok: false, error: { code, message: err instanceof Error ? err.message : String(err) } };
    summary = `${code}`;
  }
  note(req.kind, reply.ok, summary);
  await fetch(`${API_BASE}/api/canvas/reply`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: req.id, ...reply }),
  }).catch(() => { /* the agent side times out on its own */ });
}

export function startCanvasBridge() {
  if (stream || isViewerMode) return;
  useCanvasBridge.setState({ state: 'connecting', error: '' });
  const projectId = captureSource().projectId ?? '';
  stream = new EventSource(`${API_BASE}/api/canvas/stream?projectId=${encodeURIComponent(projectId)}`);
  stream.onopen = () => useCanvasBridge.setState({ state: 'on', error: '' });
  stream.onerror = () => useCanvasBridge.setState({ state: 'error', error: t('bridge.disconnected') });
  stream.addEventListener('request', (event) => {
    const req = JSON.parse((event as MessageEvent).data) as Request;
    queue = queue.then(() => serve(req));
  });
}

export function stopCanvasBridge() {
  stream?.close();
  stream = null;
  useCanvasBridge.setState({ state: 'off', error: '' });
}
