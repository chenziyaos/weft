#!/usr/bin/env node
// Runtime acceptance only: real UI, public CLI, readonly IndexedDB observations.
import { chromium } from 'playwright-core';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { isDeepStrictEqual as equal } from 'node:util';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'evidence', 'weft-workspace-ui-' + Date.now());
await fs.mkdir(out, { recursive: true });
const home = path.join(out, 'empty-home'); await fs.mkdir(home);
const origin = 'https://weft.workspace.invalid';
const checks = [], commands = [], network = [], errors = [];
let browser, context, page, stage = 'setup', reachedUI = false;
const file = name => path.join(out, name);
const save = (name, data) => fs.writeFile(file(name), typeof data === 'string' ? data : JSON.stringify(data, null, 2));
const load = async p => JSON.parse(await fs.readFile(p, 'utf8'));
const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, LANG: 'C.UTF-8', TZ: 'UTC', XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home, XDG_DATA_HOME: home, npm_config_update_notifier: 'false', npm_config_audit: 'false', npm_config_cache: path.join(home, 'npm-cache') };
async function manifest() {
  const result = {};
  async function walk(dir) { for (const e of await fs.readdir(path.join(root, dir), { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) await walk(p); else result[p] = createHash('sha256').update(await fs.readFile(path.join(root, p))).digest('hex'); } }
  for (const d of ['src', 'dist', 'host-dist', 'cli/dist']) await walk(d);
  return result;
}
const before = await manifest(); await save('source-manifest-before.json', before);
async function capture(name, p = page) { await p.screenshot({ path: file(name + '.png'), fullPage: true }); await save(name + '.aria.txt', await p.locator('body').ariaSnapshot()); }
async function check(name, ok, detail = {}) { if (!ok) await capture('failure-' + checks.length).catch(() => {}); checks.push({ name, ok: !!ok, stage, ...detail }); console.log((ok ? 'PASS ' : 'FAIL ') + name); }
async function run(label, args, expectedCode) {
  const executable = process.execPath;
  const argv = ['--require', file('offline-guard.cjs'), path.join(root, 'cli/dist/weft.mjs'), 'graph', ...args];
  const r = spawnSync(executable, argv, { cwd: out, env, encoding: 'utf8', timeout: 20000, maxBuffer: 8 * 1024 * 1024 });
  const entry = { label, executable, args: argv, status: r.status, stdout: r.stdout, stderr: r.stderr, error: r.error?.message };
  commands.push(entry); await save(label + '-command.json', entry);
  if (expectedCode) {
    await check(label, r.status > 0 && JSON.parse(r.stderr).error?.code === expectedCode, { status: r.status, stderr: r.stderr });
  } else if (r.status !== 0) throw Error(label + ': ' + r.stderr);
  return r;
}
await save('offline-guard.cjs', `const deny=n=>function(){throw Error('OFFLINE_GUARD '+n)};const net=require('node:net');net.Server.prototype.listen=deny('listen');net.Socket.prototype.connect=deny('connect');for(const n of ['node:http','node:https']){const m=require(n);m.request=deny(n);m.get=deny(n)}require('node:tls').connect=deny('tls');require('node:dgram').createSocket=deny('udp');globalThis.fetch=deny('fetch');globalThis.WebSocket=deny('WebSocket');const cp=require('node:child_process');for(const k of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])cp[k]=deny(k);require('node:module').syncBuiltinESMExports();`);
async function panel(open = true, p = page) { if (await p.getByTestId('host-handoff-panel').isVisible() !== open) { if (open) await p.getByTestId('host-handoff-open').click(); else await p.getByRole('button', { name: '关闭宿主交接', exact: true }).click(); } }
async function download(testid, name, p = page) { await panel(true, p); const pending = p.waitForEvent('download'); await p.getByTestId(testid).click(); const d = await pending; await d.saveAs(file(name)); await save(name + '.download.json', { suggestedFilename: d.suggestedFilename(), failure: await d.failure() }); return file(name); }
async function exportGraph(name, p = page) { await panel(true, p); const pending = p.waitForEvent('download'); await p.getByRole('button', { name: '导出当前项目 weft.json' }).click(); const d = await pending; const f = file(name + '.weft.json'); await d.saveAs(f); return load(f); }
async function importNative(name, p = page) { await panel(true, p); await p.getByTestId('host-handoff-import-graph').setInputFiles(file(name)); await p.getByRole('status').filter({ hasText: '已导入' }).waitFor(); }
async function preview(f, p = page) { await panel(true, p); await p.getByTestId('workspace-import').setInputFiles(f); await p.getByTestId('workspace-preview').waitFor(); }
async function editBundle(label, operations) { const base = await download('workspace-export', label + '-base.workspace.json'); const ops = file(label + '-operations.json'); await save(path.basename(ops), operations); const edited = file(label + '-edited.workspace.json'); await run(label + '-cli', ['workspace-edit', '--workspace', base, '--operations', ops, '--expected-revision', '0', '--request-id', 'synthetic-' + label, '--out', edited]); return { base: await load(base), edited, bundle: await load(edited) }; }
async function rows(p = page) {
  // Readonly observation; never initialize or modify application graph state here.
  return p.evaluate(async () => { const result = []; for (const info of await indexedDB.databases()) { const db = await new Promise((resolve, reject) => { const r = indexedDB.open(info.name); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); }); for (const name of db.objectStoreNames) { const read = await new Promise((resolve, reject) => { const tx = db.transaction(name, 'readonly'), s = tx.objectStore(name), k = s.getAllKeys(), v = s.getAll(); tx.oncomplete = () => resolve(k.result.map((key, i) => ({ key, value: typeof v.result[i] === 'string' ? JSON.parse(v.result[i]) : v.result[i] }))); tx.onerror = () => reject(tx.error); }); result.push(...read); } db.close(); } return result; });
}
const diskGraph = (r, id) => r.find(x => x.key === 'weft:project:' + id)?.value?.state;
const graphView = g => ({ projectId: g.projectId, name: g.name, nodes: g.nodes.map(n => ({ id: n.id, position: n.position, data: n.data })), edges: g.edges.map(e => ({ id: e.id, source: e.source, target: e.target, data: e.data })) });
async function waitDisk(id, predicate, label, p = page) { const deadline = Date.now() + 12000; let r; while (Date.now() < deadline) { r = await rows(p); if (predicate(diskGraph(r, id), r)) { await save(label + '-idb.json', r); return r; } await p.waitForTimeout(120); } await capture(label + '-disk-timeout', p); await save(label + '-idb.json', r); throw Error('Disk predicate timed out: ' + label); }
async function moveRoot(p = page) { await panel(false, p); await p.getByRole('button', { name: 'Fit View', exact: true }).click(); await p.waitForTimeout(500); const handle = p.locator('.react-flow__node[data-id="synthetic-root"] .drag-handle'); const b = await handle.boundingBox(); if (!b) throw Error('Root drag handle missing'); await p.mouse.move(b.x + Math.min(120, b.width / 2), b.y + 20); await p.mouse.down(); await p.mouse.move(b.x + Math.min(120, b.width / 2) + 95, b.y + 85, { steps: 18 }); await p.mouse.up(); }
async function editRootAnswer(text, p = page) { await panel(false, p); await p.getByRole('button', { name: 'Fit View', exact: true }).click(); await p.waitForTimeout(400); const n = p.locator('.react-flow__node[data-id="synthetic-root"]'); await n.locator('.drag-handle').click({ position: { x: 120, y: 20 } }); await n.getByRole('button', { name: 'Edit the answer', exact: true }).click(); await n.getByRole('textbox').fill(text); await n.getByRole('button', { name: 'Save', exact: true }).click(); }
async function switchProject(from, to) { await panel(false); await page.getByRole('button', { name: from, exact: true }).click(); await page.getByText(to, { exact: true }).click(); await page.waitForTimeout(500); }
function observe(p, label) { p.on('pageerror', e => errors.push({ stage, tab: label, message: e.stack })); p.on('dialog', async d => { await save('dialog-' + Date.now() + '.json', { message: d.message(), type: d.type() }); await d.accept(); }); }
try {
  // Use the already-built dist and unified CLI; acceptance must not rebuild them.
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, env: { ...env, LD_LIBRARY_PATH: '/home/mira/.local/chromium-libs/usr/lib/x86_64-linux-gnu:/home/mira/.local/chromium-libs/lib/x86_64-linux-gnu' }, args: ['--no-sandbox', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run', '--host-resolver-rules=MAP * ~NOTFOUND'] });
  context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: 'en-US', acceptDownloads: true, serviceWorkers: 'block' }); context.setDefaultTimeout(12000);
  await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
  await context.addInitScript(() => { localStorage.setItem('weft.tutorialDone', '1'); });
  await context.routeWebSocket('**/*', ws => { network.push({ stage, url: ws.url(), action: 'websocket-blocked' }); ws.close(); });
  await context.route('**/*', async route => { const r = route.request(), u = new URL(r.url()); const entry = { stage, url: u.href, method: r.method(), type: r.resourceType(), action: 'blocked' }; network.push(entry); if (u.origin !== origin || r.method() !== 'GET' || u.pathname.startsWith('/api/')) return route.abort('blockedbyclient'); const f = path.resolve(root, 'dist', u.pathname === '/' ? 'index.html' : decodeURIComponent(u.pathname).slice(1)); if (!f.startsWith(path.join(root, 'dist') + '/')) return route.abort('blockedbyclient'); try { const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json' }[path.extname(f)] || 'application/octet-stream'; const body = await fs.readFile(f); entry.action = 'fulfilled-from-dist'; await route.fulfill({ status: 200, contentType: mime, body }); } catch { await route.abort('blockedbyclient'); } });
  page = await context.newPage(); observe(page, 'primary'); await page.goto(origin); await page.getByTestId('host-handoff-open').waitFor(); reachedUI = true;
  stage = 'current-brand-observation';
  // The observed landing page renders the exact brand text after the shell is ready.
  // Wait for that visible text without assuming its element tag.
  await page.getByText('Weft', { exact: true }).waitFor({ state: 'visible' });
  const title = await page.title(), visibleBrand = [];
  for (const candidate of await page.getByText(/\bWeft\b/).all()) {
    if (await candidate.isVisible()) visibleBrand.push({ tag: await candidate.evaluate(el => el.tagName), text: await candidate.innerText(), bounds: await candidate.boundingBox() });
  }
  await save('00-current-brand.json', { title, visibleBrand, bodyText: await page.locator('body').innerText() });
  await capture('00-current-brand');
  await check('Real document title includes Weft', title.includes('Weft'), { title });
  await check('Rendered page visibly displays current Weft brand', visibleBrand.length > 0, { visibleBrand });
  const node = (id, question, response, x) => ({ id, type: 'thought', position: { x, y: 120 }, data: { question, response, responses: response ? [response] : [], responseIndex: 0, isRoot: id === 'synthetic-root', isBranch: false, isCollapsed: false, isEditing: false, isEditingResponse: false, isLoading: false, tokenCount: 0, highlights: [], highlightMode: 'off', attachments: [], excludedAttachmentIds: [], includedAttachmentIds: [], roleMode: 'inherit' } });
  const native = { version: 1, name: 'Workspace UI synthetic A', events: [{ t: '2026-01-01T00:00:00.000Z', op: 'node.add', id: 'synthetic-root', d: { synthetic: true } }], instantiatedFrom: { name: 'Synthetic provenance', at: '2026-01-01T00:00:00.000Z', futureField: 'preserve' }, nodes: [node('synthetic-root', 'Synthetic premise', 'SYNTHETIC BASE ANSWER; no inference.', 100), node('synthetic-target', 'Synthetic target original', '', 680)], edges: [{ id: 'synthetic-edge', source: 'synthetic-root', target: 'synthetic-target', type: 'default' }] };
  await save('synthetic-A.weft.json', native); await save('synthetic-B.weft.json', { ...native, name: 'Workspace UI synthetic B' });
  stage = 'native-import'; await importNative('synthetic-A.weft.json'); await panel(false); await page.getByRole('button', { name: 'Fit View', exact: true }).click(); await page.waitForTimeout(400); await page.locator('.react-flow__node[data-id="synthetic-root"] .drag-handle').click({ position: { x: 120, y: 20 } }); await capture('01-native-canvas-click');
  const original = await exportGraph('01-original'); const id = original.projectId;
  const initialRows = await waitDisk(id, s => s?.nodes?.length === 2, '01-original'); const initialIndex = initialRows.find(r => r.key === 'weft:projects')?.value;
  stage = 'workspace-edit-preview-apply';
  const happy = await editBundle('02-happy', [{ op: 'set-question', id: 'synthetic-target', text: 'SYNTHETIC CLI revised target' }, { op: 'move-node', id: 'synthetic-target', x: 700, y: 260 }, { op: 'add-node', id: 'synthetic-note', kind: 'note', text: 'SYNTHETIC CLI note; no model inference.' }, { op: 'connect', id: 'synthetic-note-edge', source: 'synthetic-root', target: 'synthetic-note' }]);
  await preview(happy.edited); const previewText = await page.getByTestId('workspace-preview').innerText(); await capture('02-difference-preview'); await check('Difference preview shows revision and node/edge changes before apply', previewText.includes('1 / 0 / 1') && previewText.includes('1 / 0 / 0'), { previewText });
  const previewOnly = await exportGraph('02-preview-only'); await check('Preview does not apply graph', equal(graphView(original), graphView(previewOnly)));
  await page.getByTestId('workspace-apply').click(); await page.locator('.react-flow__node[data-id="synthetic-note"]').waitFor(); await page.waitForTimeout(500); await capture('03-applied'); await check('Apply success status survives its own graph publication', (await page.getByTestId('workspace-status').innerText()).includes('已应用 revision'), { status: await page.getByTestId('workspace-status').innerText() });
  const applied = await exportGraph('03-applied'); await check('Apply preserves project ID and renders CLI edits', applied.projectId === id && applied.nodes.some(n => n.id === 'synthetic-note') && applied.nodes.find(n => n.id === 'synthetic-target').data.question === 'SYNTHETIC CLI revised target');
  const committed = await waitDisk(id, s => s?.nodes?.some(n => n.id === 'synthetic-note'), '03-applied');
  const backups = committed.filter(r => String(r.key).startsWith('weft:workspace-backup:' + id + ':')); await save('03-backups.json', backups);
  await check('Recoverable backup contains original graph/envelope and new graph', backups.length === 1 && backups[0].value.originalGraph.nodes.length === 2 && backups[0].value.originalEnvelope.state.nodes.length === 2 && backups[0].value.nextEnvelope.state.nodes.length === 3, { keys: backups.map(r => r.key) });
  // Same projects and active project; updatedAt legitimately moves when the edit is saved.
  const projectIds = (index) => ({ ids: index?.projects?.map(p => p.id), activeId: index?.activeId });
  await check('Apply does not create a new project entry', equal(projectIds(initialIndex), projectIds(committed.find(r => r.key === 'weft:projects')?.value)));
  stage = 'reload-replay'; await page.reload(); await page.locator('.react-flow__node[data-id="synthetic-note"]').waitFor(); const reloaded = await exportGraph('04-reloaded'); await check('Reload preserves applied graph and project', equal(graphView(applied), graphView(reloaded))); await capture('04-reloaded');
  await page.getByTestId('workspace-import').setInputFiles(happy.edited); await page.getByTestId('workspace-status').filter({ hasText: 'ALREADY_APPLIED' }).waitFor(); await capture('05-already-applied'); const replay = await exportGraph('05-replay'); await check('Second import is ALREADY_APPLIED with no graph mutation', equal(graphView(reloaded), graphView(replay)) && (await rows()).filter(r => String(r.key).startsWith('weft:workspace-backup:' + id + ':')).length === 1);
  stage = 'native-export-workspace-roundtrip';
  const nativeBase = await exportGraph('05-native-roundtrip-base');
  await run('05-native-init', ['workspace-init', '--graph', file('05-native-roundtrip-base.weft.json'), '--out', file('05-native-base.workspace.json')]);
  const nativeWorkspace = await load(file('05-native-base.workspace.json'));
  await check('Native export workspace-init preserves events and provenance', equal(nativeWorkspace.graph.events, nativeBase.events) && nativeBase.events.length > 0 && equal(nativeWorkspace.graph.instantiatedFrom, nativeBase.instantiatedFrom) && nativeBase.instantiatedFrom.futureField === 'preserve');
  await save('05-native-ops.json', [{ op: 'set-question', id: 'synthetic-target', text: 'SYNTHETIC native export CLI roundtrip' }]);
  await run('05-native-edit', ['workspace-edit', '--workspace', file('05-native-base.workspace.json'), '--operations', file('05-native-ops.json'), '--expected-revision', '0', '--request-id', 'synthetic-native-roundtrip', '--out', file('05-native-edited.workspace.json')]);
  await preview(file('05-native-edited.workspace.json')); await page.getByTestId('workspace-apply').click();
  await page.getByTestId('workspace-status').filter({ hasText: '已应用 revision' }).waitFor(); await page.waitForTimeout(700);
  const nativeApplied = await exportGraph('05-native-applied'); await capture('05-native-roundtrip-applied');
  await check('Native UI export to CLI init/edit applies back to original project', nativeApplied.projectId === id && nativeApplied.nodes.find(n => n.id === 'synthetic-target').data.question === 'SYNTHETIC native export CLI roundtrip' && equal(nativeApplied.events, nativeBase.events) && equal(nativeApplied.instantiatedFrom, nativeBase.instantiatedFrom) && (await page.getByTestId('workspace-status').innerText()).includes('已应用 revision'));
  await download('workspace-export', '05-status-export.workspace.json'); await moveRoot(); await panel();
  await check('Exported status survives later canvas changes without a pending preview', (await page.getByTestId('workspace-status').innerText()).includes('已导出 revision 0') && !(await page.getByTestId('workspace-preview').isVisible()));
  stage = 'snapshot-cli-probes';
  await save('05-share.weft.json', { ...nativeBase, sharedReadonly: true });
  await run('05-share-init', ['workspace-init', '--graph', file('05-share.weft.json'), '--out', file('05-share.workspace.json')]);
  const shareWorkspace = await load(file('05-share.workspace.json'));
  await check('Sharing courtesy flag neither changes sync hash nor persists in workspace graph', shareWorkspace.baseHash === nativeWorkspace.baseHash && !Object.hasOwn(shareWorkspace.graph, 'sharedReadonly'));
  for (const [label, patch] of [['events', { events: [...nativeBase.events, { t: '2026-01-02T00:00:00.000Z', op: 'node.add', id: 'synthetic-target' }] }], ['provenance', { instantiatedFrom: { ...nativeBase.instantiatedFrom, name: 'Different origin' } }], ['unknown', { futureGraphField: { keep: 'yes' } }]]) {
    await save('05-' + label + '.weft.json', { ...nativeBase, ...patch });
    await run('05-' + label + '-init', ['workspace-init', '--graph', file('05-' + label + '.weft.json'), '--out', file('05-' + label + '.workspace.json')]);
    const changed = await load(file('05-' + label + '.workspace.json'));
    await check('Snapshot binds and preserves ' + label, changed.baseHash !== nativeWorkspace.baseHash && Object.entries(patch).every(([key, value]) => equal(changed.graph[key], value)));
  }
  const noEvents = { ...nativeBase }; delete noEvents.events;
  await save('05-no-events.weft.json', noEvents); await save('05-empty-events.weft.json', { ...noEvents, events: [] });
  for (const label of ['no-events', 'empty-events']) await run('05-' + label + '-init', ['workspace-init', '--graph', file('05-' + label + '.weft.json'), '--out', file('05-' + label + '.workspace.json')]);
  await check('Missing events normalize to empty array', (await load(file('05-no-events.workspace.json'))).baseHash === (await load(file('05-empty-events.workspace.json'))).baseHash && equal((await load(file('05-no-events.workspace.json'))).graph.events, []));
  const vaulted = { id: 'synthetic-vault', name: 'synthetic.txt', type: 'text/plain', size: 22, content: 'SYNTHETIC INLINE BYTES', contentInVault: true };
  await save('05-vault-ops.json', [{ op: 'add-attachment', id: 'synthetic-root', attachment: vaulted }]);
  await run('05-vault-add-rejected', ['workspace-edit', '--workspace', file('05-native-base.workspace.json'), '--operations', file('05-vault-ops.json'), '--expected-revision', '0', '--request-id', 'synthetic-vault-rejected', '--out', file('05-vault-rejected.workspace.json')], 'UNHYDRATED_ATTACHMENT');
  const hydratedNative = structuredClone(nativeBase); hydratedNative.nodes[0].data.attachments.push(vaulted);
  await save('05-hydrated.weft.json', hydratedNative);
  await run('05-hydrated-init', ['workspace-init', '--graph', file('05-hydrated.weft.json'), '--out', file('05-hydrated.workspace.json')]);
  const hydrated = await load(file('05-hydrated.workspace.json')), normalizedAttachment = hydrated.graph.nodes[0].data.attachments.find(a => a.id === vaulted.id);
  await check('Hydrated native attachment keeps bytes and clears vault marker', normalizedAttachment.content === vaulted.content && !Object.hasOwn(normalizedAttachment, 'contentInVault'));
  normalizedAttachment.contentInVault = true;
  await save('05-forged-vault.workspace.json', hydrated);
  await run('05-vault-workspace-rejected', ['workspace-inspect', '--workspace', file('05-forged-vault.workspace.json')], 'UNHYDRATED_ATTACHMENT');
  hydratedNative.nodes[0].data.attachments[0].content = '';
  await save('05-unhydrated.weft.json', hydratedNative);
  await run('05-missing-vault-bytes-rejected', ['workspace-init', '--graph', file('05-unhydrated.weft.json'), '--out', file('05-unhydrated.workspace.json')], 'UNHYDRATED_ATTACHMENT');
  await check('Rejected vault commands create no output files', !(await fs.stat(file('05-vault-rejected.workspace.json')).catch(() => null)) && !(await fs.stat(file('05-unhydrated.workspace.json')).catch(() => null)));
  stage = 'move-preview-invalidation'; const stale = await editBundle('06-stale', [{ op: 'set-question', id: 'synthetic-target', text: 'SYNTHETIC stale candidate' }]); await preview(stale.edited); await moveRoot(); await panel(); await capture('06-preview-invalidated-by-move'); await check('Canvas movement invalidates preview and removes apply', !(await page.getByTestId('workspace-preview').isVisible()) && !(await page.getByTestId('workspace-apply').isVisible()) && (await page.getByTestId('workspace-status').innerText()).includes('失效'));
  const moved = await exportGraph('06-moved'); await check('Native canvas drag actually changes stored position', !equal(moved.nodes.find(n => n.id === 'synthetic-root').position, reloaded.nodes.find(n => n.id === 'synthetic-root').position));
  await page.getByTestId('workspace-import').setInputFiles(stale.edited); await page.getByTestId('workspace-status').filter({ hasText: 'SYNC_CONFLICT' }).waitFor(); await capture('07-old-workspace-conflict'); await check('Old workspace rejected after native movement', !(await page.getByTestId('workspace-preview').isVisible()));
  await moveRoot(); await panel(); await check('Failure status survives later canvas changes without a pending preview', (await page.getByTestId('workspace-status').innerText()).includes('SYNC_CONFLICT') && !(await page.getByTestId('workspace-preview').isVisible()));
  stage = 'answer-preview-invalidation'; const answerStale = await editBundle('08-answer-stale', [{ op: 'set-question', id: 'synthetic-target', text: 'SYNTHETIC before answer edit' }]); await preview(answerStale.edited); await editRootAnswer('SYNTHETIC manual root edit; no inference.'); await panel(); await check('Native answer edit invalidates preview', !(await page.getByTestId('workspace-preview').isVisible())); await page.getByTestId('workspace-import').setInputFiles(answerStale.edited); await page.getByTestId('workspace-status').filter({ hasText: 'SYNC_CONFLICT' }).waitFor(); await capture('08-answer-conflict');
  stage = 'project-invalidation'; await importNative('synthetic-B.weft.json'); const b = await exportGraph('09-project-B'); await switchProject('Workspace UI synthetic B', 'Workspace UI synthetic A'); const switchCandidate = await editBundle('09-project', [{ op: 'set-question', id: 'synthetic-target', text: 'SYNTHETIC project preview' }]); await preview(switchCandidate.edited); await switchProject('Workspace UI synthetic A', 'Workspace UI synthetic B'); await panel(); await check('Switching project invalidates pending preview', !(await page.getByTestId('workspace-preview').isVisible())); await capture('09-project-invalidated'); await page.getByTestId('workspace-import').setInputFiles(switchCandidate.edited); await page.getByTestId('workspace-status').filter({ hasText: 'SYNC_CONFLICT' }).waitFor(); await capture('09-wrong-project-conflict'); await switchProject('Workspace UI synthetic B', 'Workspace UI synthetic A'); await panel(); await check('Switching back does not resurrect preview', !(await page.getByTestId('workspace-preview').isVisible()) && (await exportGraph('09-back-A')).projectId === id && b.projectId !== id);
  stage = 'legacy-host-result'; await page.getByTestId('host-handoff-target').selectOption('synthetic-target'); await page.getByTestId('host-handoff-compile').click(); await page.getByTestId('host-handoff-preview').waitFor(); const handoff = await download('host-handoff-download', '10-legacy.handoff.json'); const answer = 'SYNTHETIC LEGACY ANSWER; manually authored; no inference; isolation unverified.'; await save('10-synthetic-answer.txt', answer); const result = file('10-legacy.host-result.json'); await run('10-legacy-result', ['result', '--handoff', handoff, '--answer', file('10-synthetic-answer.txt'), '--host', 'codex', '--run-id', 'synthetic-workspace-ui', '--mode', 'current-session', '--out', result]); await page.getByTestId('host-handoff-import-result').setInputFiles(result); await page.getByRole('status').filter({ hasText: '已回写' }).waitFor(); const legacy = await exportGraph('10-legacy'); const target = legacy.nodes.find(n => n.id === 'synthetic-target'); await check('Legacy host-result writeback preserves project and answer receipt', legacy.projectId === id && target.data.response === answer && target.data.hostReceipts?.length === 1); await capture('10-legacy-writeback'); await waitDisk(id, s => s?.nodes?.find(n => n.id === 'synthetic-target')?.data.response === answer, '10-legacy');
  // Let the first tab finish the answer-driven ReactFlow remeasurement and
  // delayed autosave before taking tab2's baseline. Otherwise tab1's legitimate
  // pending layout save can race tab2, reversing this conflict scenario.
  await page.waitForTimeout(1500);
  stage = 'same-origin-second-tab'; const race = await editBundle('11-two-tabs', [{ op: 'set-question', id: 'synthetic-target', text: 'SYNTHETIC primary workspace candidate must not overwrite tab2' }]); await preview(race.edited); const tab2 = await context.newPage(); observe(tab2, 'second'); await tab2.goto(origin); await tab2.locator('.react-flow__node[data-id="synthetic-root"]').waitFor(); const tab2Before = await exportGraph('11-tab2-before', tab2); await check('Second tab shares origin and same active project', tab2.url() === page.url() && tab2Before.projectId === id);
  const otherAnswer = 'SYNTHETIC SECOND TAB SAVED ANSWER; must survive stale primary tab.'; await editRootAnswer(otherAnswer, tab2); await waitDisk(id, s => s?.nodes?.find(n => n.id === 'synthetic-root')?.data.response === otherAnswer, '11-tab2-committed', tab2); await capture('11-tab2-edited', tab2);
  await page.bringToFront(); await page.getByTestId('workspace-apply').click(); await page.getByTestId('workspace-status').filter({ hasText: 'SYNC_CONFLICT' }).waitFor(); await capture('12-tab1-apply-conflict'); await check('Primary workspace apply refuses second-tab disk change', (await page.getByTestId('workspace-status').innerText()).includes('SYNC_CONFLICT'));
  const beforeAuto = await rows(); await moveRoot(); await page.getByText(/保存失败/).first().waitFor(); await page.waitForTimeout(1500); const afterAuto = await rows(); await save('12-after-autosave-idb.json', afterAuto); await capture('12-tab1-autosave-conflict'); await check('Ordinary primary-tab autosave cannot silently overwrite second tab', equal(diskGraph(beforeAuto, id), diskGraph(afterAuto, id)) && diskGraph(afterAuto, id).nodes.find(n => n.id === 'synthetic-root').data.response === otherAnswer);
  await tab2.reload(); await tab2.locator('.react-flow__node[data-id="synthetic-root"]').waitFor(); const winner = await exportGraph('13-tab2-reloaded', tab2); await check('Second-tab saved content survives reload after conflict', winner.nodes.find(n => n.id === 'synthetic-root').data.response === otherAnswer && winner.nodes.find(n => n.id === 'synthetic-target').data.question !== 'SYNTHETIC primary workspace candidate must not overwrite tab2'); await capture('13-tab2-reloaded', tab2);
  stage = 'complete';
} catch (e) { await capture('unexpected-' + stage).catch(() => {}); errors.push({ stage, kind: 'harness-or-runtime', message: e.stack }); console.error(e.stack); process.exitCode = 1; }
finally {
  const after = await manifest(); await save('source-manifest-after.json', after); const changes = Object.keys(before).filter(k => before[k] !== after[k]);
  await check('Product src and public CLI unchanged', changes.length === 0, { changes });
  const verdict = errors.length || checks.some(c => !c.ok) ? (reachedUI ? 'FAIL' : 'BLOCKED') : 'PASS';
  const summary = { verdict, stage, checksPassed: checks.filter(c => c.ok).length, checksTotal: checks.length, checks, errors, sourceChanges: changes, listenerStarted: false, transport: 'Playwright Chromium pipe; GET dist route.fulfill only; all other HTTP/WebSocket blocked', actualInference: false, fixture: 'Synthetic graphs and manually authored answers, never model-generated', unverified: ['File System Access API native integration', 'Real model/host execution and isolation', 'Vaulted/large attachments and commit-microtask races'], evidence: out, script: path.join(root, 'scripts/verify-workspace-ui.mjs') };
  await save('commands.json', commands); await save('network.json', network); await save('summary.json', summary);
  if (context) await context.tracing.stop({ path: file('trace.zip') }).catch(() => {}); if (browser) await browser.close();
  console.log(JSON.stringify({ verdict, stage, checksPassed: summary.checksPassed, checksTotal: checks.length, evidence: out })); if (verdict !== 'PASS') process.exitCode = 1;
}
