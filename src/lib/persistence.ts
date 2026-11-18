import { createStore, get as idbGet } from 'idb-keyval';
import type { PersistStorage, StorageValue } from 'zustand/middleware';
import type { GraphSnapshot } from './host-handoff';
import { canonicalStringify } from './context-bundle';
import { toast } from './ui-store';

const WRITE_DELAY_MS = 1000;
// The same database/store used by idb-keyval's default helpers and the vault.
const store = createStore('keyval-store', 'keyval');
const pending = new Map<string, unknown>();
const latest = new Map<string, unknown>();
const observed = new Map<string, string>();
const failures = new Map<string, Error>();
let timer: ReturnType<typeof setTimeout> | null = null;
let queue: Promise<void> = Promise.resolve();
let publishingKey: string | null = null;
let activeCommit: { name: string; abort: () => void } | null = null;
const writeGenerations = new Map<string, number>();
const generation = (name: string) => writeGenerations.get(name) ?? 0;

interface HydrationTransaction {
  source: string;
  target: string;
  sourceGeneration: number;
  targetGeneration: number;
  merged: boolean;
  completed: boolean;
  error?: unknown;
}
let hydration: HydrationTransaction | null = null;

/** Keep ordinary edits on the displayed graph's key until the synchronous merge. */
export function beginProjectHydration(source: string, target: string): HydrationTransaction {
  if (hydration) throw conflict('另一个项目仍在载入。');
  if (pending.has(source) || latest.has(source) || failures.has(source)) {
    throw failures.get(source) ?? conflict('原项目仍有未保存编辑，不能载入其他项目。');
  }
  hydration = { source, target, sourceGeneration: generation(source),
    targetGeneration: generation(target), merged: false, completed: false };
  return hydration;
}
function assertHydrationUnchanged(transaction: HydrationTransaction): void {
  if (hydration !== transaction || transaction.merged ||
      generation(transaction.source) !== transaction.sourceGeneration ||
      generation(transaction.target) !== transaction.targetGeneration) {
    throw conflict('载入期间发生了编辑，已取消切换；编辑和选区保留在原项目，请再次切换。');
  }
  for (const key of [transaction.source, transaction.target]) {
    if (failures.has(key)) throw failures.get(key);
    if (pending.has(key) || latest.has(key)) throw conflict('本页仍有未保存编辑，不能重新载入并丢弃。');
  }
}
/** Called LAST in merge, with no await before Zustand installs the new graph. */
export function acceptProjectHydration(): void {
  if (!hydration) throw conflict('未建立项目载入事务，拒绝覆盖当前画布。');
  assertHydrationUnchanged(hydration);
  hydration.merged = true;
}
export function recordProjectHydration(error?: unknown): void {
  if (!hydration) return;
  hydration.completed = true;
  hydration.error = error;
}
/** Zustand catches hydrate errors; make that outcome explicit to the project owner. */
export function finishProjectHydration(transaction: HydrationTransaction): void {
  if (hydration !== transaction) throw conflict('项目载入事务已改变。');
  hydration = null;
  if (transaction.error !== undefined) throw transaction.error;
  if (!transaction.completed || !transaction.merged) throw conflict('项目载入未完成，保留原画布。');
}

function normalize(value: unknown): unknown {
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { /* Preserve malformed legacy values in CAS. */ }
  }
  return value ?? null;
}
function fingerprint(value: unknown): string { return canonicalStringify(normalize(value)); }
function conflict(message: string): Error { return new Error(`SYNC_CONFLICT: ${message}`); }
function report(name: string, error: unknown): Error {
  const err = error instanceof Error ? error : new Error(String(error));
  if (!failures.has(name)) toast('error', `保存失败（${name}）：${err.message}。未保存的编辑仍在当前页面，请先导出备份，不要刷新。`, 15000);
  failures.set(name, err);
  return err;
}
// Every issued operation joins this queue, including timer-issued writes.
// The tail stays usable after a rejection; failures remain latched per key.
function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const result = queue.then(operation);
  queue = result.then(() => undefined, () => undefined);
  return result;
}
function assertBaseline(name: string, raw: unknown): void {
  if (!observed.has(name) || fingerprint(raw) !== observed.get(name)) {
    throw conflict('磁盘图已被其他标签页修改，或本页尚未读取保存基线；拒绝覆盖。请导出本页编辑后重新打开项目。');
  }
}

async function writeCas(name: string, value: unknown, remove = false): Promise<void> {
  const nextHash = fingerprint(remove ? null : value);
  await store('readwrite', (objectStore) => new Promise<void>((resolve, reject) => {
    const tx = objectStore.transaction;
    let failure: unknown;
    tx.onabort = () => reject(failure ?? tx.error ?? new Error('IndexedDB transaction aborted'));
    tx.onerror = () => { failure ??= tx.error; };
    tx.oncomplete = () => { observed.set(name, nextHash); resolve(); };
    const request = objectStore.get(name);
    request.onsuccess = () => {
      try {
        assertBaseline(name, request.result);
        if (remove) objectStore.delete(name);
        else objectStore.put(value, name);
      } catch (error) { failure = error; tx.abort(); }
    };
  }));
}
function dispatch(name?: string): void {
  if (timer) { clearTimeout(timer); timer = null; }
  for (const [key, value] of pending) {
    if ((name !== undefined && key !== name) || failures.has(key)) continue;
    pending.delete(key);
    void enqueue(async () => {
      try {
        if (failures.has(key)) throw failures.get(key);
        await writeCas(key, value);
        if (latest.get(key) === value) latest.delete(key);
      } catch (error) {
        // A newer snapshot may already be queued (not just debounced).
        pending.set(key, latest.get(key) ?? value);
        throw report(key, error);
      }
    }).catch(() => undefined);
  }
  if ([...pending.keys()].some(key => !failures.has(key))) timer = setTimeout(() => dispatch(), WRITE_DELAY_MS);
}

/** Wait for ALL issued writes, not just the remaining debounce slot.
 * A keyed flush isolates a project; failed keys retain their live/pending data.
 */
export async function flushPendingWrites(name?: string): Promise<void> {
  for (;;) {
    dispatch(name);
    const issued = queue;
    await issued;
    const failure = name === undefined ? failures.values().next().value : failures.get(name);
    if (failure) throw failure;
    const hasPending = [...pending.keys()].some(key => name === undefined || key === name);
    if (issued === queue && !hasPending) return;
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => dispatch());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') dispatch();
  });
}

/** Object envelopes stay objects; legacy JSON envelopes compare identically.
 * A read must not silently rebase a dirty/failed tab onto another tab's graph.
 */
export function createIdbObjectStorage<S>(): PersistStorage<S> {
  return {
    getItem: (name) => {
      const transaction = hydration;
      const readGeneration = generation(name);
      const check = () => {
        if (generation(name) !== readGeneration) throw conflict('读取期间发生了编辑，拒绝覆盖本页数据。');
        if (transaction) {
          if (transaction.target !== name) throw conflict('项目载入 key 不匹配。');
          assertHydrationUnchanged(transaction);
        }
        if (failures.has(name)) throw failures.get(name);
        if (pending.has(name) || latest.has(name)) throw conflict('本页仍有未保存编辑，不能重新载入并丢弃。');
      };
      return enqueue(async () => {
        check();
        const raw = await idbGet(name, store);
        check(); // A write may have been queued while IndexedDB was reading.
        const envelope = normalize(raw) as StorageValue<S> | null;
        if (envelope !== null && (typeof envelope !== 'object' || !envelope.state || envelope.version !== 1)) {
          throw conflict('项目数据不是受支持的 persist envelope，拒绝载入为空画布。');
        }
        observed.set(name, fingerprint(raw));
        return envelope;
      });
    },
    setItem: (name, value) => {
      // Before merge the displayed graph still belongs to the source project.
      if (hydration && !hydration.merged) name = hydration.source;
      // Publication follows a successful disk transaction, never precedes it.
      if (publishingKey === name) return;
      writeGenerations.set(name, generation(name) + 1);
      pending.set(name, value);
      latest.set(name, value);
      if (activeCommit?.name === name) activeCommit.abort();
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => dispatch(), WRITE_DELAY_MS);
    },
    removeItem: async (name) => {
      // Do not cancel unrelated projects or discard a failed project's edits.
      await flushPendingWrites(name);
      await enqueue(async () => {
        try { await writeCas(name, null, true); }
        catch (error) { throw report(name, error); }
      });
    },
  };
}

export interface WorkspaceCommitOptions {
  name: string;
  graph: GraphSnapshot;
  /** Hydrated original graph for recovery even after vault garbage collection. */
  originalGraph: GraphSnapshot;
  isCurrent: () => boolean;
  /** Abort on ordinary store edits/project changes, not just lock-aware callers. */
  watch: (abort: () => void) => () => void;
  /** Synchronous publication of nodes AND edges, called only after disk commit. */
  publish: () => void;
}

/** Atomic CAS + recoverable raw-envelope backup + replacement.
 * Backup keys: weft:workspace-backup:<projectId>:<timestamp>:<uuid>.
 * The record contains originalEnvelope (including vault references), nextEnvelope,
 * projectId and createdAt. Never garbage-collect attachment vault data here.
 */
export async function commitWorkspaceGraph(options: WorkspaceCommitOptions): Promise<string> {
  const { name, graph, isCurrent, watch, publish } = options;
  await flushPendingWrites(name);
  return enqueue(async () => {
    if (!isCurrent() || pending.has(name)) throw conflict('图已改变，请重新导入工作副本。');
    if (failures.has(name)) throw failures.get(name);
    const backupKey = `weft:workspace-backup:${graph.projectId}:${Date.now()}:${crypto.randomUUID()}`;
    let oldRaw: unknown;
    let nextEnvelope: unknown;
    let nextHash = '';
    let diskCommitted = false;
    let published = false;
    let invalid = false;
    let transaction: IDBTransaction | undefined;
    const abort = () => {
      if (published) return;
      invalid = true;
      try { transaction?.abort(); } catch { /* Completion may already be queued. */ }
    };
    const stop = watch(abort);
    activeCommit = { name, abort };
    try {
      await store('readwrite', objectStore => new Promise<void>((resolve, reject) => {
        const tx = transaction = objectStore.transaction;
        let failure: unknown;
        tx.onerror = () => { failure ??= tx.error; };
        tx.onabort = () => reject(invalid ? conflict('提交期间发生编辑或项目切换，已中止；本页编辑保留。') : failure ?? tx.error ?? new Error('IndexedDB transaction aborted'));
        tx.oncomplete = () => {
          diskCommitted = true;
          // No await between this final gate and publishing the graph.
          if (invalid || !isCurrent()) { reject(conflict('提交结束时图已改变，正在恢复原磁盘图。')); return; }
          observed.set(name, nextHash);
          publishingKey = name;
          published = true;
          try { publish(); resolve(); }
          catch (error) { reject(error); }
          finally { publishingKey = null; }
        };
        const request = objectStore.get(name);
        request.onsuccess = () => {
          try {
            if (invalid || !isCurrent() || pending.has(name)) throw conflict('图已改变，拒绝提交。');
            oldRaw = request.result;
            assertBaseline(name, oldRaw);
            const envelope = normalize(oldRaw) as StorageValue<Record<string, unknown>> | null;
            if (envelope !== null && (typeof envelope !== 'object' || !envelope.state || envelope.version !== 1)) {
              throw conflict('保存基线不是受支持的 persist envelope。');
            }
            const commit = () => {
              if (invalid || !isCurrent() || pending.has(name)) throw conflict('提交期间图已改变。');
              nextEnvelope = { ...envelope, version: 1, state: { ...envelope?.state, nodes: graph.nodes, edges: graph.edges } };
              nextHash = fingerprint(nextEnvelope);
              objectStore.put({ format: 'weft.workspace-backup', version: 1, projectId: graph.projectId,
                createdAt: new Date().toISOString(), originalEnvelope: oldRaw ?? null,
                originalGraph: options.originalGraph, nextEnvelope }, backupKey);
              objectStore.put(nextEnvelope, name);
            };
            // The envelope CAS must use vault references, never a hydrated
            // envelope. Also verify referenced bytes in this same transaction.
            const oldNodes = (envelope?.state.nodes ?? []) as GraphSnapshot['nodes'];
            const hydratedNodes = new Map(options.originalGraph.nodes.map(node => [node.id, node]));
            const vaulted = oldNodes.flatMap(node => (node.data.attachments ?? [])
              .filter(attachment => attachment.contentInVault)
              .map(attachment => ({ attachment, hydrated: hydratedNodes.get(node.id)?.data.attachments?.find(a => a.id === attachment.id) })));
            let remaining = vaulted.length;
            if (!remaining) commit();
            for (const { attachment, hydrated } of vaulted) {
              const vaultRequest = objectStore.get(`att-content:${attachment.id}`);
              vaultRequest.onsuccess = () => {
                try {
                  if (!hydrated?.content || vaultRequest.result !== hydrated.content) throw conflict('附件内容已改变或缺失，请重新导入工作副本。');
                  if (--remaining === 0) commit();
                } catch (error) { failure = error; tx.abort(); }
              };
            }
          } catch (error) { failure = error; tx.abort(); }
        };
      }));
      return backupKey;
    } catch (error) {
      if (diskCommitted && !published) {
        // An edit can arrive after IDB commits but before oncomplete runs.
        // Restore only if nobody else has changed our committed envelope.
        observed.set(name, nextHash);
        try { await writeCas(name, oldRaw, oldRaw === undefined); }
        catch (restoreError) {
          throw report(name, new Error(`${String(restoreError)}；原图备份仍在 ${backupKey}，请先恢复备份。`));
        }
      }
      // Conflicts from another tab latch ordinary saves too; a source edit
      // abort alone does not poison subsequent saves of those local edits.
      if (!invalid && !published) report(name, error);
      throw error;
    } finally {
      stop();
      activeCommit = null;
    }
  });
}
