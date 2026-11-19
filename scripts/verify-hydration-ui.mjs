#!/usr/bin/env node
// Real UI acceptance. Pipe transport, dist route.fulfill, no listening server.
// Only fault injection is at the browser's IDB get boundary; no app imports/store calls.
import { chromium } from 'playwright-core';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual as equal } from 'node:util';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'evidence', 'hydration-ui-' + Date.now());
await fs.mkdir(out, { recursive: true });
const file = n => path.join(out, n);
const save = (n, v) => fs.writeFile(file(n), typeof v === 'string' ? v : JSON.stringify(v, null, 2));
const origin = 'https://hydration.weft.invalid';
const checks = [], errors = [], network = [];
let browser, context, page, stage = 'setup';
async function manifest() {
  const result = {};
  for (const f of ['src/lib/persistence.ts', 'src/store/projects.ts', 'src/store/index.ts']) result[f] = createHash('sha256').update(await fs.readFile(path.join(root, f))).digest('hex');
  return result;
}
const before = await manifest(); await save('source-before.json', before);
async function capture(n, p = page) { await p.screenshot({ path: file(n + '.png'), fullPage: true }); await save(n + '.aria.txt', await p.locator('body').ariaSnapshot()); }
async function check(name, ok, detail = {}) { checks.push({ stage, name, ok: !!ok, ...detail }); console.log((ok ? 'PASS ' : 'FAIL ') + name); if (!ok) { await capture('failure-' + checks.length); throw Error(name); } }
async function panel(open = true, p = page) { if (await p.getByTestId('host-handoff-panel').isVisible() !== open) await (open ? p.getByTestId('host-handoff-open') : p.getByRole('button', { name: '关闭宿主交接', exact: true })).click(); }
async function exportGraph(n) { await panel(); const wait = page.waitForEvent('download'); await page.getByRole('button', { name: '导出当前项目 weft.json', exact: true }).click(); const d = await wait; await d.saveAs(file(n + '.json')); return JSON.parse(await fs.readFile(file(n + '.json'), 'utf8')); }
async function rows(p = page) { return p.evaluate(async () => { const result = []; for (const info of await indexedDB.databases()) { const db = await new Promise((resolve, reject) => { const r = indexedDB.open(info.name); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); }); for (const s of db.objectStoreNames) { const data = await new Promise((resolve, reject) => { const t = db.transaction(s, 'readonly'), o = t.objectStore(s), k = o.getAllKeys(), v = o.getAll(); t.oncomplete = () => resolve(k.result.map((key, i) => ({ key, value: typeof v.result[i] === 'string' ? JSON.parse(v.result[i]) : v.result[i] }))); t.onerror = () => reject(t.error); }); result.push(...data); } db.close(); } return result; }); }
const graph = (r, id) => r.find(x => x.key === 'weft:project:' + id)?.value?.state;
const active = r => r.find(x => x.key === 'weft:projects')?.value?.activeId;
async function waitDisk(id, predicate, n) { const end = Date.now() + 12000; let r; while (Date.now() < end) { r = await rows(); if (predicate(graph(r, id), r)) { await save(n + '-idb.json', r); return r; } await page.waitForTimeout(100); } await save(n + '-idb.json', r); throw Error('Disk wait expired: ' + n); }
async function switchTo(from, to) { await panel(false); await page.getByRole('button', { name: from, exact: true }).click(); await page.getByText(to, { exact: true }).click(); }
async function settled(name) { await page.getByRole('button', { name, exact: true }).waitFor(); await page.waitForFunction(n => [...document.querySelectorAll('button')].some(b => b.textContent.trim() === n && !b.disabled), name); }
async function arm(key, p = page) { await p.evaluate(key => { window.__idbGate.target = key; window.__idbGate.phase = 'armed'; }, key); }
async function held(p = page) { await p.waitForFunction(() => window.__idbGate.phase === 'held'); }
async function release(fail = false, p = page) { await p.evaluate(fail => window.__idbGate.release(fail), fail); }
async function answer(text) { await panel(false); await page.getByRole('button', { name: 'Fit View', exact: true }).click(); const n = page.locator('.react-flow__node[data-id="synthetic-root"]'); await n.locator('.drag-handle').click({ position: { x: 120, y: 20 } }); await n.getByRole('button', { name: 'Edit the answer', exact: true }).click(); await n.getByRole('textbox').fill(text); await n.getByRole('button', { name: 'Save', exact: true }).click(); }
try {
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--no-sandbox', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run', '--host-resolver-rules=MAP * ~NOTFOUND'] });
  context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: 'en-US', acceptDownloads: true, serviceWorkers: 'block' }); context.setDefaultTimeout(12000);
  await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
  await context.addInitScript(() => {
    localStorage.setItem('weft.tutorialDone', '1');
    const gate = window.__idbGate = { phase: 'idle', target: null, writes: [], events: [] };
    const get = IDBObjectStore.prototype.get, put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function(value, key) { gate.writes.push({ key, value: structuredClone(value), time: Date.now() }); return put.call(this, value, key); };
    IDBObjectStore.prototype.get = function(key) {
      const request = get.call(this, key);
      if (this.transaction.mode !== 'readonly' || key !== gate.target || gate.phase !== 'armed') return request;
      gate.phase = 'reading';
      // Delay only delivery of the completed readonly get; keep the native DB intact.
      const delayed = { onsuccess: null, onerror: null, onabort: null, oncomplete: null, result: undefined, error: null };
      request.addEventListener('success', () => {
        delayed.result = request.result; gate.phase = 'held'; gate.events.push({ key, kind: 'held', time: Date.now() });
        gate.release = fail => { gate.phase = 'released'; gate.target = null; gate.events.push({ key, kind: fail ? 'failed' : 'released', time: Date.now() }); if (fail) { delayed.error = new DOMException('SYNTHETIC_IDB_READ_FAILURE', 'UnknownError'); delayed.onerror?.(); } else delayed.onsuccess?.(); };
      });
      request.addEventListener('error', () => { delayed.error = request.error; delayed.onerror?.(); });
      return delayed;
    };
  });
  await context.routeWebSocket('**/*', ws => ws.close());
  await context.route('**/*', async route => {
    const r = route.request(), u = new URL(r.url()); const e = { stage, url: u.href, action: 'blocked' }; network.push(e);
    if (u.origin !== origin || r.method() !== 'GET' || u.pathname.startsWith('/api/')) return route.abort('blockedbyclient');
    const f = path.resolve(root, 'dist', u.pathname === '/' ? 'index.html' : decodeURIComponent(u.pathname).slice(1));
    if (!f.startsWith(path.join(root, 'dist') + '/')) return route.abort('blockedbyclient');
    try { const body = await fs.readFile(f); e.action = 'dist'; await route.fulfill({ status: 200, contentType: ({ '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' })[path.extname(f)] || 'application/octet-stream', body }); } catch { await route.abort('blockedbyclient'); }
  });
  page = await context.newPage(); page.on('pageerror', e => errors.push({ stage, message: e.message })); page.on('dialog', d => d.accept());
  await page.goto(origin); await page.getByRole('button', { name: 'My Canvas', exact: true }).waitFor(); const bootedAt = Date.now();
  stage = 'empty-boot'; await check('Fresh profile boots an empty project', (await exportGraph('00-empty')).nodes.length === 0); await capture('00-empty');
  const fixture = name => ({ version: 1, name, nodes: [{ id: 'synthetic-root', type: 'thought', position: { x: 100, y: 120 }, data: { question: name, response: name + ' original answer', responses: [name + ' original answer'], responseIndex: 0, isRoot: true, isBranch: false, isCollapsed: false, isEditing: false, isEditingResponse: false, isLoading: false, tokenCount: 0, highlights: [], highlightMode: 'off', attachments: [], excludedAttachmentIds: [], includedAttachmentIds: [], roleMode: 'inherit' } }], edges: [] });
  for (const name of ['Hydration A', 'Hydration B']) { await save(name + '.weft.json', fixture(name)); await panel(); await page.getByTestId('host-handoff-import-graph').setInputFiles(file(name + '.weft.json')); await settled(name); }
  const b = await exportGraph('01-B'); await switchTo('Hydration B', 'Hydration A'); await settled('Hydration A'); const a = await exportGraph('01-A'); await panel(false);
  const initial = await waitDisk(a.projectId, (g, r) => g?.nodes?.length === 1 && active(r) === a.projectId, '01-before');
  // The app sweeps the attachment vault 6 s after boot, reading every project's
  // graph; an armed gate must catch the switch's read, not that sweep's.
  await page.waitForTimeout(Math.max(0, 7000 - (Date.now() - bootedAt)));
  stage = 'delayed-read-real-edit';
  await arm('weft:project:' + b.projectId); await switchTo('Hydration A', 'Hydration B'); await held();
  await check('Switcher remains on A while B read is held', await page.getByRole('button', { name: 'Hydration A', exact: true }).isDisabled());
  const text = 'SYNTHETIC edit while B read is held; must stay in A'; await answer(text); await capture('02-edit-during-read');
  const selectionDuring = await page.locator('.react-flow__node.selected').count();
  await save('02-held-idb.json', await rows()); await release(); await settled('Hydration A');
  const selectionAfter = await page.locator('.react-flow__node.selected').count();
  await check('Cancelled hydration preserves selected node', selectionDuring > 0 && selectionAfter === selectionDuring, { selectionDuring, selectionAfter });
  const after = await exportGraph('03-after-cancel');
  await check('Hydrate did not overwrite local edit or publish B', after.projectId === a.projectId && after.nodes[0].data.response === text);
  const saved = await waitDisk(a.projectId, (g, r) => g?.nodes?.[0]?.data.response === text && active(r) === a.projectId, '03-edit-saved-A');
  await check('B disk envelope is unchanged after cancelled hydration', equal(graph(initial, b.projectId), graph(saved, b.projectId))); await capture('03-cancel-preserved');
  const raceWrites = await page.evaluate(() => window.__idbGate.writes);
  await save('03-idb-put-log.json', raceWrites); await save('03-idb-read-gate-events.json', await page.evaluate(() => window.__idbGate.events));
  await check('No intermediate put sends the A edit to B', raceWrites.filter(w => w.key === 'weft:project:' + b.projectId).every(w => (typeof w.value === 'string' ? JSON.parse(w.value) : w.value).state.nodes[0].data.question === 'Hydration B'));
  stage = 'successful-delayed-retry'; await arm('weft:project:' + b.projectId); await switchTo('Hydration A', 'Hydration B'); await held(); await release(); await settled('Hydration B');
  const b2 = await exportGraph('04-B-success'); await check('Retry without editing switches normally', b2.projectId === b.projectId && b2.nodes[0].data.response === 'Hydration B original answer');
  await answer('SYNTHETIC B edit after successful hydrate');
  const bSaved = await waitDisk(b.projectId, g => g?.nodes?.[0]?.data.response === 'SYNTHETIC B edit after successful hydrate', '04-B-save');
  await check('Successful hydration restores writes to B without changing A', graph(bSaved, a.projectId).nodes[0].data.response === text); await capture('04-B-writes');
  stage = 'idb-read-failure'; await arm('weft:project:' + a.projectId); await switchTo('Hydration B', 'Hydration A'); await held(); await release(true); await settled('Hydration B');
  const failed = await exportGraph('05-after-read-error'); await check('Read failure preserves B and explicitly fails the switch', failed.projectId === b.projectId && errors.some(e => e.message.includes('SYNTHETIC_IDB_READ_FAILURE')));
  await answer('SYNTHETIC B edit after failed A hydration'); await waitDisk(b.projectId, g => g?.nodes?.[0]?.data.response === 'SYNTHETIC B edit after failed A hydration', '05-source-key-restored');
  stage = 'switch-and-reload'; await switchTo('Hydration B', 'Hydration A'); await settled('Hydration A'); await panel(false); await page.reload(); await settled('Hydration A');
  const reloaded = await exportGraph('06-reloaded'); await check('A edit survives subsequent switch and reload', reloaded.projectId === a.projectId && reloaded.nodes[0].data.response === text); await capture('06-reloaded');
  stage = 'create-empty'; await panel(false); await page.getByRole('button', { name: 'Hydration A', exact: true }).click(); await page.getByRole('button', { name: 'New canvas', exact: true }).click(); await settled('Untitled');
  const empty = await exportGraph('07-created-empty'); await check('Create still hydrates a missing key as an empty project', empty.nodes.length === 0 && empty.projectId !== a.projectId); await capture('07-created-empty');
  stage = 'boot-read-error'; await switchTo('Untitled', 'Hydration A'); await settled('Hydration A');
  const boot = await context.newPage(); boot.on('pageerror', e => errors.push({ stage: 'boot-read-error', message: e.message }));
  await boot.addInitScript(key => { window.__idbGate.target = key; window.__idbGate.phase = 'armed'; }, 'weft:project:' + a.projectId);
  await boot.goto(origin); await held(boot); await release(true, boot); await boot.waitForFunction(() => document.body.textContent.includes('加载') || document.body.textContent.includes('load'));
  // Observe completion through the emitted runtime failure, rather than assuming a time delay.
  await boot.waitForFunction(() => window.__idbGate.phase === 'released');
  await capture('08-boot-error', boot); const bootRows = await rows(boot); await save('08-boot-error-idb.json', bootRows);
  await check('Boot read failure does not publish an empty replacement/recovery project', !await boot.getByRole('button', { name: 'Hydration A', exact: true }).isVisible() && !bootRows.some(r => r.key === 'weft:project:recovery') && active(bootRows) === a.projectId && graph(bootRows, a.projectId).nodes[0].data.response === text);
  await check('Boot caller receives the real hydration failure', errors.some(e => e.stage === 'boot-read-error' && e.message.includes('SYNTHETIC_IDB_READ_FAILURE')));
  await save('idb-injection-events.json', await page.evaluate(() => window.__idbGate.events));
  await save('idb-writes-final-page.json', await page.evaluate(() => window.__idbGate.writes));
  stage = 'complete';
} catch (e) { errors.push({ stage, kind: 'harness-or-runtime', message: e.stack }); console.error(e.stack); await capture('unexpected-' + stage).catch(() => {}); process.exitCode = 1; }
finally {
  const after = await manifest(); await save('source-after.json', after);
  const unexpected = errors.filter(e => e.kind || (!e.message.includes('SYNTHETIC_IDB_READ_FAILURE') && !e.message.includes('SYNC_CONFLICT: 载入期间发生了编辑')));
  const verdict = stage === 'complete' && checks.every(c => c.ok) && equal(before, after) && !unexpected.length ? 'PASS' : 'FAIL';
  await save('summary.json', { verdict, checks, errors, unexpected, stage, sourceUnchangedDuringRun: equal(before, after), transport: 'Chromium pipe + dist fulfill; no listener', evidence: out, boundaries: ['Only IDB read delivery fault injection, no internal app imports/state calls', 'Synthetic graphs imported through UI', 'Merge-microtask-only window, actual disk failure/quotas, attachment hydration, and multiple competing hydrate callers not exercised'] });
  await save('network.json', network);
  if (context) await context.tracing.stop({ path: file('trace.zip') }).catch(() => {}); if (browser) await browser.close();
  console.log(JSON.stringify({ verdict, stage, evidence: out, checks: checks.length })); if (verdict !== 'PASS') process.exitCode = 1;
}
