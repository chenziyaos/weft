import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRightLeft, Download, Upload, X } from 'lucide-react';
import { useStore } from '../store';
import { bootProjects, projectStorageKey, useProjects } from '../store/projects';
import { captureSource, hydrate, sourceIsCurrent, type LiveSource } from '../lib/live-graph';
import { startCanvasBridge, stopCanvasBridge, useCanvasBridge } from '../lib/canvas-bridge';
import { commitWorkspaceGraph, flushPendingWrites } from '../lib/persistence';
import { acceptWorkspace, createWorkspace, graphRevision, validateWorkspace, type WorkspaceBundle } from '../lib/graph-workspace';
import { canonicalStringify } from '../lib/context-bundle';
import { confirmIfSensitive } from '../lib/sensitive-scan';
import { downloadFile, exportActiveProjectJson, parseImportFile } from '../lib/export';
import { isViewerMode } from '../lib/viewer';
import { CANVAS_FILE_SUFFIX } from '../lib/legacy-names';
import { applyHostResult, createHandoff, getHandoffStatus, type HostHandoff, type HostResult } from '../lib/host-handoff';
import type { ThoughtNode } from '../types';
import './HostHandoffPanel.css';

type Source = LiveSource;
type Preview = { source: Source; bundle: HostHandoff; target: string; host: string };
type Status = { source: Source; value: ReturnType<typeof getHandoffStatus> };
type ChangeCounts = { added: number; removed: number; modified: number };
type WorkspacePreview = {
  source: Source; fileRevision: number; bundle: WorkspaceBundle; baseHash: string;
  nodes: ChangeCounts; edges: ChangeCounts;
};
function changeCounts(before: { id: string }[], after: { id: string }[]): ChangeCounts {
  const old = new Map(before.map(item => [item.id, canonicalStringify(item)]));
  const next = new Map(after.map(item => [item.id, canonicalStringify(item)]));
  return {
    added: [...next.keys()].filter(id => !old.has(id)).length,
    removed: [...old.keys()].filter(id => !next.has(id)).length,
    modified: [...next].filter(([id, value]) => old.has(id) && old.get(id) !== value).length,
  };
}

function isTarget(node: ThoughtNode): boolean {
  return !['note', 'file', 'link', 'frame'].includes(node.data.stepKind ?? '') && !node.data.archived;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function filename(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').trim() || 'canvas';
}

export default function HostHandoffPanel() {
  const nodes = useStore((s) => s.nodes);
  const edges = useStore((s) => s.edges);
  const events = useStore((s) => s.events);
  const selectedNodeId = useStore((s) => s.selectedNodeId);
  const activeId = useProjects((s) => s.activeId);
  const projects = useProjects((s) => s.projects);
  const switching = useProjects((s) => s.switching);
  const instantiatedFrom = projects.find((p) => p.id === activeId)?.instantiatedFrom;
  const projectName = projects.find((p) => p.id === activeId)?.name ?? 'canvas';
  const [open, setOpen] = useState(false);
  const bridge = useCanvasBridge();
  const [chosenTarget, setChosenTarget] = useState<{ projectId: string | null; id: string } | null>(null);
  const [host, setHost] = useState('codex');
  // A chain that passes through a stale answer is blocked by default: the
  // user must consciously re-allow it. The opt-in lives here (rather than
  // only in the CLI) so a stale mid-tree node never strands the canvas UI.
  const [staleConsent, setStaleConsent] = useState<{ projectId: string | null; target: string; host: string } | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [workspacePreview, updateWorkspacePreview] = useState<WorkspacePreview | null>(null);
  // Subscriptions run synchronously, before React renders. Keep their pending
  // preview view current on every creation/clear, not in a later effect.
  const workspacePreviewRef = useRef<WorkspacePreview | null>(null);
  function setWorkspacePreview(value: WorkspacePreview | null) {
    workspacePreviewRef.current = value;
    updateWorkspacePreview(value);
  }
  const [workspaceStatus, setWorkspaceStatus] = useState('显式导入/导出，不会实时同步。');
  const [workspaceBackupKey, setWorkspaceBackupKey] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const busyRef = useRef(false);
  const fileRevision = useRef(0);
  const launcherRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const targets = useMemo(() => nodes.filter(isTarget), [nodes]);
  const defaultTarget = targets.find((n) => n.id === selectedNodeId || n.selected)?.id ?? targets[0]?.id ?? '';
  const target = chosenTarget && chosenTarget.projectId === activeId && targets.some((n) => n.id === chosenTarget.id)
    ? chosenTarget.id : defaultTarget;
  const allowStale = staleConsent?.projectId === activeId && staleConsent?.target === target && staleConsent?.host === host;
  // consent covers one project, target and host; any change drops it (during render, not in an effect)
  const consentKey = `${activeId}\u0000${target}\u0000${host}`;
  const [consentFor, setConsentFor] = useState(consentKey);
  if (consentFor !== consentKey) { setConsentFor(consentKey); setStaleConsent(null); }
  const livePreview = preview && sourceIsCurrent(preview.source)
    && preview.target === target && preview.host === host && preview.bundle.allowStale === allowStale ? preview.bundle : null;
  const liveStatus = status && sourceIsCurrent(status.source) ? status.value : null;
  const liveWorkspacePreview = workspacePreview && sourceIsCurrent(workspacePreview.source)
    // eslint-disable-next-line react-hooks/refs -- store subscriptions bump the revision outside React; a stale preview must not render meanwhile
    && workspacePreview.fileRevision === fileRevision.current ? workspacePreview : null;
  const locked = busy !== null || switching;

  useEffect(() => {
    // Invalidate eagerly, including while the panel is closed. Undo must not
    // resurrect an old bundle merely by restoring an array reference.
    const invalidate = () => {
      fileRevision.current++; setStaleConsent(null); setPreview(null); setStatus(null); setError(null);
      if (workspacePreviewRef.current) {
        setWorkspacePreview(null);
        setWorkspaceStatus('图或项目已改变，工作副本预览已失效；请重新导入。');
      }
    };
    const offGraph = useStore.subscribe((next, previous) => {
      if (next.nodes !== previous.nodes || next.edges !== previous.edges || next.events !== previous.events) invalidate();
    });
    const offProjects = useProjects.subscribe((next, previous) => {
      const current = next.projects.find((p) => p.id === next.activeId);
      const old = previous.projects.find((p) => p.id === previous.activeId);
      if (next.activeId !== previous.activeId || next.switching !== previous.switching
        || current?.name !== old?.name || current?.instantiatedFrom !== old?.instantiatedFrom) invalidate();
    });
    return () => { offGraph(); offProjects(); };
  }, []);

  useEffect(() => {
    if (!open || switching) return;
    let cancelled = false;
    const source = captureSource();
    void hydrate(source).then((graph) => {
      if (!cancelled && sourceIsCurrent(source)) setStatus({ source, value: getHandoffStatus(graph) });
    }).catch((err: unknown) => {
      if (!cancelled && sourceIsCurrent(source)) setError(messageOf(err));
    });
    return () => { cancelled = true; };
  }, [open, nodes, edges, events, instantiatedFrom, activeId, projectName, switching]);

  useEffect(() => {
    if (open) closeRef.current?.focus();
  }, [open]);

  function close() {
    setOpen(false);
    launcherRef.current?.focus();
  }

  async function run(label: string, action: () => Promise<void>) {
    if (busyRef.current || useProjects.getState().switching) return;
    busyRef.current = true;
    setBusy(label);
    setError(null);
    setNotice('');
    try { await action(); }
    catch (err) { setError(messageOf(err)); }
    finally { busyRef.current = false; setBusy(null); }
  }

  function assertCurrent(source: Source, revision: number) {
    if (!sourceIsCurrent(source) || revision !== fileRevision.current) {
      throw new Error('图或文件已改变，本次操作已取消。请按当前图重新操作。');
    }
  }

  async function workspaceAction(label: string, action: () => Promise<void>) {
    await run(label, async () => {
      try {
        if (isViewerMode) throw new Error('只读查看模式不能导入、导出或应用工作副本。');
        await action();
      } catch (error) {
        setWorkspacePreview(null);
        const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
        setWorkspaceStatus(`${code ? `${code}: ` : ''}${messageOf(error)}`);
        throw error;
      }
    });
  }

  async function exportWorkspace() {
    await workspaceAction('正在导出 CLI 工作副本…', async () => {
      const source = captureSource();
      const revision = fileRevision.current;
      if (!source.projectId) throw new Error('请先打开项目。');
      const graph = await hydrate(source);
      assertCurrent(source, revision);
      // Scan the hydrated snapshot that actually leaves the device, including
      // vaulted attachment text. A cancelled confirmation never downloads.
      if (!await confirmIfSensitive(graph.nodes)) {
        setWorkspaceStatus('已取消导出，未下载工作副本。'); return;
      }
      assertCurrent(source, revision);
      const bundle = await createWorkspace(graph);
      assertCurrent(source, revision);
      downloadFile(`${filename(source.name)}.workspace.json`, JSON.stringify(bundle, null, 2), 'application/json');
      setWorkspaceStatus('已导出 revision 0 工作副本，包含完整图及附件。CLI 修改后请显式导入；本页继续编辑会使原基线失效。');
    });
  }

  async function importWorkspace(file: File) {
    if (busyRef.current) return;
    setWorkspacePreview(null);
    fileRevision.current++;
    await workspaceAction('正在校验 CLI 工作副本…', async () => {
      if (file.size > 32 * 1024 * 1024) throw new Error('TOO_LARGE: 工作副本不能超过 32 MiB。');
      if (!/\.workspace\.json$/i.test(file.name)) throw new Error('请选择 .workspace.json 文件。');
      const source = captureSource();
      const revision = fileRevision.current;
      if (!source.projectId) throw new Error('请先打开工作副本所属的项目；导入不会创建新项目。');
      const raw: unknown = JSON.parse(await file.text());
      await validateWorkspace(raw);
      const bundle = raw as WorkspaceBundle;
      const current = await hydrate(source);
      assertCurrent(source, revision);
      // Validate before accepting, and preview only a same-project exact base.
      // ALREADY_APPLIED returns here without flushing or writing any graph.
      const next = await acceptWorkspace(current, bundle);
      const normalizedCurrent = (await createWorkspace(current)).graph;
      const baseHash = await graphRevision(current);
      assertCurrent(source, revision);
      setWorkspacePreview({ source, fileRevision: revision, bundle, baseHash,
        nodes: changeCounts(normalizedCurrent.nodes, next.nodes), edges: changeCounts(normalizedCurrent.edges, next.edges) });
      setWorkspaceStatus(`已校验 revision ${bundle.revision}，尚未应用。核对增删改数量后，点击“应用到当前项目”。`);
    });
  }

  async function applyWorkspace() {
    await workspaceAction('正在备份并应用 CLI 工作副本…', async () => {
      const preview = workspacePreview;
      if (!preview || !sourceIsCurrent(preview.source) || preview.fileRevision !== fileRevision.current) {
        throw new Error('SYNC_CONFLICT: 预览已失效，请重新导入工作副本。');
      }
      const source = preview.source;
      const isCurrent = () => sourceIsCurrent(source) && preview.fileRevision === fileRevision.current;
      const current = await hydrate(source);
      if (await graphRevision(current) !== preview.baseHash || !isCurrent()) {
        throw new Error('SYNC_CONFLICT: 图或附件已改变，请重新导入工作副本。');
      }
      await validateWorkspace(preview.bundle);
      const next = await acceptWorkspace(current, preview.bundle);
      if (!isCurrent()) throw new Error('SYNC_CONFLICT: 图已改变，请重新导入工作副本。');
      const backupKey = await commitWorkspaceGraph({
        name: projectStorageKey(source.projectId!), graph: next, originalGraph: current, isCurrent,
        watch: (abort) => {
          // Ordinary zustand setState does not honor navigator.locks. Watch
          // graph edits and project changes throughout the short IDB commit.
          const offGraph = useStore.subscribe(() => { if (!isCurrent()) abort(); });
          const offProjects = useProjects.subscribe(() => { if (!isCurrent()) abort(); });
          return () => { offGraph(); offProjects(); };
        },
        publish: () => {
          // Consume the pending preview before publication; later ReactFlow
          // measurements still invalidate sources, never the completed status.
          setWorkspacePreview(null);
          useStore.getState().pushHistory();
          useStore.setState({ nodes: next.nodes, edges: next.edges, selectedNodeId: null, selectedNodeIds: [] });
          // The existing delayed watcher sees these same fingerprints and
          // returns without requesting a judge. No model is started here.
          useStore.getState().recomputeStaleness(false);
        },
      });
      setWorkspacePreview(null);
      fileRevision.current++;
      setWorkspaceBackupKey(backupKey);
      setWorkspaceStatus(`已应用 revision ${preview.bundle.revision}，项目 ID ${source.projectId} 不变，未新建项目。原图备份已保存。再次编辑 CLI 时请重新导出工作副本。`);
    });
  }

  async function importGraph(file: File) {
    setPreview(null);
    setStatus(null);
    fileRevision.current++;
    await run('正在导入图文件…', async () => {
      if (isViewerMode) throw new Error('只读查看模式不能导入或回写。请返回可编辑画布。');
      if (!CANVAS_FILE_SUFFIX.test(file.name)) throw new Error('请选择原生 .weft.json 图文件。');
      const raw: unknown = JSON.parse(await file.text());
      if (!raw || typeof raw !== 'object' || !('nodes' in raw) || !Array.isArray(raw.nodes)
        || !('edges' in raw) || !Array.isArray(raw.edges) || ('format' in raw) || ('kind' in raw)) {
        throw new Error('这不是原生 Weft 图文件，请勿使用交接包或宿主结果文件。');
      }
      // Wait for initial hydration so it cannot overwrite a first import.
      await bootProjects();
      if (useProjects.getState().switching) throw new Error('项目正在切换，请稍后重新导入。');
      const result = await parseImportFile(file);
      if (result.kind !== 'own' || !result.ok) throw new Error('图文件未导入：文件无效或导入已取消。');
      setChosenTarget(null);
      setNotice(`已导入 ${file.name}。请选择目标节点再编译交接。`);
    });
  }

  async function compile() {
    setPreview(null);
    await run('正在编译交接…', async () => {
      const source = captureSource();
      const revision = fileRevision.current;
      if (!target || !source.nodes.some((n) => n.id === target && isTarget(n))) throw new Error('请先选择一个非材料目标节点。');
      const graph = await hydrate(source);
      assertCurrent(source, revision);
      const bundle = await createHandoff(graph, target, { host, allowStale });
      assertCurrent(source, revision);
      setPreview({ source, bundle, target, host });
      setStatus({ source, value: getHandoffStatus(graph) });
      setNotice('交接已编译，尚未运行。下载文件后由宿主接收并验证隔离。');
    });
  }

  async function importResult(file: File) {
    setPreview(null);
    fileRevision.current++;
    await run('正在校验并回写结果…', async () => {
      if (isViewerMode) throw new Error('只读查看模式不能回写结果。');
      if (!/\.host-result\.json$/i.test(file.name)) throw new Error('请选择 .host-result.json 文件。');
      const source = captureSource();
      const revision = fileRevision.current;
      if (!source.projectId) throw new Error('请先导入图文件或打开项目，再回写结果。');
      const result = JSON.parse(await file.text()) as HostResult;
      const graph = await hydrate(source);
      assertCurrent(source, revision);
      const next = await applyHostResult(graph, result);
      assertCurrent(source, revision);
      useStore.getState().pushHistory();
      useStore.setState({ nodes: next.nodes });
      useStore.getState().recomputeStaleness(false);
      await flushPendingWrites();
      setNotice(`已回写 ${file.name}；保留项目 ID ${source.projectId}，未创建新图。`);
    });
  }

  return (
    <div className="host-handoff-root" onKeyDown={(event) => {
      // Keep canvas shortcuts from deleting/editing nodes while using the panel.
      event.stopPropagation();
      if (event.key === 'Escape' && open) { event.preventDefault(); close(); }
    }}>
      <button ref={launcherRef} type="button" className="host-handoff-launcher" aria-label="打开宿主交接"
        aria-expanded={open} aria-controls="host-handoff-panel" data-testid="host-handoff-open"
        onClick={() => open ? close() : setOpen(true)}>
        <ArrowRightLeft size={16} strokeWidth={1.75} aria-hidden="true" />宿主交接
        {bridge.state === 'on' && <span className="host-handoff-live-dot" data-testid="canvas-bridge-dot" title="本机 Agent 可实时编辑此画布" />}
      </button>
      {open && <aside id="host-handoff-panel" className="host-handoff-panel" aria-labelledby="host-handoff-title" data-testid="host-handoff-panel">
        <header className="host-handoff-header">
          <h2 id="host-handoff-title">宿主交接</h2>
          <button ref={closeRef} type="button" className="host-handoff-close" aria-label="关闭宿主交接" onClick={close}>
            <X size={18} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </header>
        <div className="host-handoff-body">
          <p className="host-handoff-boundary">文件交接：完整图编辑保留，自动运行及旧会话隔离须由宿主验证</p>
          <p className="host-handoff-muted">编译与状态查询不调用模型、不启动宿主。关闭后可继续编辑原画布。</p>
          {isViewerMode && <p className="host-handoff-muted">当前为只读查看模式，导入和回写已禁用。</p>}
          <section aria-label="本机 Agent 实时编辑" className="canvas-bridge-section">
            <h3>本机 Agent 实时编辑</h3>
            <label className="host-handoff-check">
              <input type="checkbox" data-testid="canvas-bridge-toggle" checked={bridge.state !== 'off'} disabled={isViewerMode}
                onChange={(event) => event.target.checked ? startCanvasBridge() : stopCanvasBridge()} />
              允许本机 Agent 编辑此画布
            </label>
            <p className="host-handoff-muted">开启后，本机 Agent 可以用 <code>canvas-*</code> 命令（<code>weft graph</code> 或已安装 Skill 的脚本）读取画布、开分支、连线、引用、编译上下文并回写回答。每次修改都经过与 CLI 工作副本相同的校验，按连线方向自动排版，可撤销，并记入事件日志。只接受本机请求，关闭页面或取消勾选即停止。</p>
            <p className="workspace-status" data-testid="canvas-bridge-status" role="status" aria-live="polite">
              {bridge.state === 'off' ? '未开启' : bridge.state === 'connecting' ? '正在连接本地服务…' : bridge.state === 'on' ? '已开启：等待本机 Agent 的请求' : bridge.error}
            </p>
            {bridge.activity.length > 0 && <ul className="canvas-bridge-activity" data-testid="canvas-bridge-activity">
              {bridge.activity.slice(0, 6).map((a, i) => <li key={i} className={a.ok ? '' : 'is-error'}>
                {new Date(a.at).toLocaleTimeString()} · {a.kind} · {a.summary}
              </li>)}
            </ul>}
          </section>
          <section aria-label="本地图文件">
            <h3>本地图文件</h3>
            <p>{activeId ? projectName : '尚无项目，可先导入本地图文件'}</p>
            {activeId && <p className="host-handoff-id">项目 ID：{activeId}</p>}
            <label className="host-handoff-file"><Upload size={14} aria-hidden="true" />导入 .weft.json
              <input type="file" accept=".weft.json,application/json" aria-label="导入本地 Weft 图文件"
                data-testid="host-handoff-import-graph" disabled={locked || isViewerMode}
                onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file) void importGraph(file); }} />
            </label>
            <button type="button" className="host-handoff-button" disabled={locked || !activeId || isViewerMode}
              aria-label="导出当前项目 weft.json" onClick={() => void run('正在导出图文件…', () => exportActiveProjectJson())}>
              <Download size={14} aria-hidden="true" />导出本地图（保留敏感扫描）
            </button>
          </section>
          <section aria-label="CLI 工作副本" className="workspace-section">
            <h3>CLI 工作副本</h3>
            <p className="host-handoff-muted">显式导出 → CLI 编辑 → 导入预览 → 应用到同一项目；不是实时同步。原生图文件导入仍用于创建副本。</p>
            <p className="host-handoff-muted">下载包含完整图、答案历史和全部附件，可能含敏感内容；导出保留敏感扫描确认。</p>
            <button type="button" className="host-handoff-button" data-testid="workspace-export"
              disabled={locked || !activeId || isViewerMode} onClick={() => void exportWorkspace()}>
              <Download size={14} aria-hidden="true" />导出CLI工作副本
            </button>
            <label className="host-handoff-file"><Upload size={14} aria-hidden="true" />导入CLI工作副本
              <input type="file" accept=".workspace.json,application/json" aria-label="导入CLI工作副本"
                data-testid="workspace-import" disabled={locked || !activeId || isViewerMode}
                onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file) void importWorkspace(file); }} />
            </label>
            {liveWorkspacePreview && <div className="workspace-preview" data-testid="workspace-preview">
              <dl>
                <dt>revision</dt><dd>{liveWorkspacePreview.bundle.revision}</dd>
                <dt>项目 ID</dt><dd>{liveWorkspacePreview.bundle.projectId}</dd>
                <dt>节点增 / 删 / 改</dt><dd>{liveWorkspacePreview.nodes.added} / {liveWorkspacePreview.nodes.removed} / {liveWorkspacePreview.nodes.modified}</dd>
                <dt>边增 / 删 / 改</dt><dd>{liveWorkspacePreview.edges.added} / {liveWorkspacePreview.edges.removed} / {liveWorkspacePreview.edges.modified}</dd>
              </dl>
              <p className="host-handoff-muted">仅接受与导出基线完全一致的当前图。应用前保存本地原图备份，不生成答案。</p>
              <button type="button" className="host-handoff-button host-handoff-primary" data-testid="workspace-apply"
                disabled={locked || isViewerMode} onClick={() => void applyWorkspace()}>应用到当前项目</button>
            </div>}
            <p className="workspace-status" data-testid="workspace-status" role="status" aria-live="polite">{workspaceStatus}</p>
            <p className="host-handoff-muted">本地恢复备份位于 IndexedDB → keyval-store → keyval，键前缀 weft:workspace-backup:。备份含原始保存封装及可恢复的完整原图。</p>
            {workspaceBackupKey && <p className="host-handoff-id">本次备份键：{workspaceBackupKey}</p>}
          </section>
          <section aria-label="编译文件交接">
            <h3>编译交接</h3>
            <label className="host-handoff-field">目标节点
              <select aria-label="交接目标节点" data-testid="host-handoff-target" value={target} disabled={locked || !targets.length}
                onChange={(event) => { setChosenTarget({ projectId: activeId, id: event.target.value }); setPreview(null); setError(null); setNotice(''); }}>
                {!targets.length && <option value="">请先添加或导入非材料节点</option>}
                {targets.map((node) => <option key={node.id} value={node.id}>{(node.data.question || node.data.instruction || '未命名节点').slice(0, 55)} · {node.id}</option>)}
              </select>
            </label>
            <label className="host-handoff-field">接收宿主
              <select aria-label="接收宿主" data-testid="host-handoff-host" value={host} disabled={locked}
                onChange={(event) => { setHost(event.target.value); setPreview(null); setError(null); setNotice(''); }}>
                <option value="codex">codex</option><option value="claude-code">claude-code</option><option value="dsh">dsh</option>
              </select>
            </label>
            <label className="host-handoff-check" data-testid="host-handoff-allow-stale">
              <input type="checkbox" checked={allowStale} disabled={locked}
                onChange={(event) => { setStaleConsent(event.target.checked ? { projectId: activeId, target, host } : null); setPreview(null); setError(null); setNotice(''); }} />
              允许携带过期答案（默认阻止；过期标记仍会保留在交接中）
            </label>
            <button type="button" className="host-handoff-button host-handoff-primary" disabled={locked || !target}
              data-testid="host-handoff-compile" onClick={() => void compile()}>编译交接</button>
            {livePreview && <div className="host-handoff-preview" data-testid="host-handoff-preview">
              <dl>
                <dt>交接 ID</dt><dd>{livePreview.id}</dd>
                <dt>目标节点</dt><dd>{livePreview.target}</dd>
                <dt>contextHash</dt><dd data-testid="host-handoff-context-hash">{livePreview.contextHash}</dd>
                <dt>图片数量</dt><dd>{livePreview.images.length}</dd>
                <dt>旧会话隔离</dt><dd>未验证（isolationVerified: false）</dd>
              </dl>
              <h4>warnings</h4>
              {livePreview.warnings.length ? <ul>{livePreview.warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul> : <p>无编译警告；不代表宿主隔离已验证。</p>}
              <h4>messages 原文</h4>
              {livePreview.messages.map((message, i) => <div key={i} className="host-handoff-message">
                <h5>{i + 1}. {message.role}</h5><pre>{message.content}</pre>
              </div>)}
              <p className="host-handoff-muted">交接包含完整图及材料，请仅交给可信宿主。</p>
              <button type="button" className="host-handoff-button" disabled={locked} data-testid="host-handoff-download"
                onClick={() => void run('正在下载交接文件…', async () => {
                  if (!preview || !sourceIsCurrent(preview.source)) throw new Error('图已改变，请重新编译交接。');
                  downloadFile(`${filename(projectName)}.handoff.json`, JSON.stringify(livePreview, null, 2), 'application/json');
                })}><Download size={14} aria-hidden="true" />下载 .handoff.json</button>
            </div>}
          </section>
          <section aria-label="回写宿主结果">
            <h3>回写宿主结果</h3>
            <p className="host-handoff-muted">只接受当前图对应的结果。重复或过期结果会被拒绝，不改动图。</p>
            <p className="host-handoff-muted">回写只更新过期标记并保存，不因本次回写启动模型评判。</p>
            <label className="host-handoff-file"><Upload size={14} aria-hidden="true" />导入 .host-result.json
              <input type="file" accept=".host-result.json,application/json" aria-label="导入宿主结果文件"
                data-testid="host-handoff-import-result" disabled={locked || !activeId || isViewerMode}
                onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file) void importResult(file); }} />
            </label>
          </section>
          <section aria-label="交接状态与重算计划" data-testid="host-handoff-status">
            <h3>状态与重算计划</h3>
            <p className="host-handoff-muted">仅列出当前图的真实节点 ID，不触发生成。plan 按依赖顺序排列重算候选，每步回写后须重新编译；blocked 表示重算互相依赖。</p>
            {liveStatus ? <dl>
              <dt>stale · 已过期 / 重算候选</dt><dd>{liveStatus.stale.length ? liveStatus.stale.join('\n') : '无'}</dd>
              <dt>unknown · 来源未知</dt><dd>{liveStatus.unknown.length ? liveStatus.unknown.join('\n') : '无'}</dd>
              <dt>plan · 按依赖排序的重算计划</dt><dd>{liveStatus.plan.length ? liveStatus.plan.join(' → ') : '无'}</dd>
              <dt>blocked · 需先拆解互依</dt><dd>{liveStatus.blocked.length ? liveStatus.blocked.join('\n') : '无'}</dd>
              <dt>replay · 已有交接回执</dt><dd>{liveStatus.replay.length ? liveStatus.replay.join('\n') : '无'}</dd>
            </dl> : <p>尚无当前图的状态结果。</p>}
          </section>
          <div aria-live="polite" role="status" className="host-handoff-notice">{busy || notice}</div>
          {error && <div role="alert" className="host-handoff-error" data-testid="host-handoff-error">{error}</div>}
        </div>
      </aside>}
    </div>
  );
}
