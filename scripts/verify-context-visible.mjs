#!/usr/bin/env node
// What you see is what is sent, and what was sent stays readable:
//  - the follow-up preview lists the request row by row (system additions,
//    @-mention references, staged files, memory, pending recall) and equals,
//    message for message, what the page sends and what the server forwards;
//  - every answer version keeps its request; the receipt marks rows that
//    changed since;
//  - a line can be moved to another node (cycles, materials and passage
//    branches refused), a step can be inserted into a solid line, and
//    deleting a middle step offers "archive just this step" instead.
// Real local server and Vite dev page; the model behind the server is a
// local stand-in that records each request, so no model is called.
import { chromium } from 'playwright-core';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'evidence', `context-visible-${Date.now()}`);
const home = path.join(out, 'weft-home');
await fs.mkdir(home, { recursive: true });
const apiPort = Number(process.env.CV_API_PORT ?? 3197), webPort = Number(process.env.CV_WEB_PORT ?? 5197), upPort = Number(process.env.CV_UP_PORT ?? 3198);
const checks = [], errors = [], upstream = [], sent = [];
let browser, server, vite, page, up;
const file = (name) => path.join(out, name);
const save = (name, data) => fs.writeFile(file(name), typeof data === 'string' ? data : JSON.stringify(data, null, 2));
async function check(name, ok, detail = {}) {
  checks.push({ name, ok: !!ok, ...detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok && page) await page.screenshot({ path: file(`failure-${checks.length}.png`) }).catch(() => {});
}
const env = { ...process.env, WEFT_HOME: home, OLLAMA_MODELS: 'stand-in', OLLAMA_BASE_URL: `http://127.0.0.1:${upPort}` };
for (const k of Object.keys(env)) if (/_API_KEY$/.test(k)) delete env[k];
async function waitHttp(url) {
  for (let i = 0; i < 200; i++) { try { if ((await fetch(url)).ok) return true; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 150)); }
  return false;
}
const text = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => p.text ?? '').join('') : JSON.stringify(c ?? ''));

// The stand-in model: an OpenAI-compatible endpoint answering "Answer for <TAG>."
// for the last [TAG] in the question, recording every request it receives.
up = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let j = {};
    try { j = JSON.parse(body || '{}'); } catch { /* not json */ }
    if (!req.url.includes('/chat/completions')) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"data":[]}'); return; }
    const msgs = j.messages ?? [];
    upstream.push(msgs);
    const last = [...msgs].reverse().find((m) => m.role === 'user');
    const tag = [...text(last?.content).matchAll(/\[([A-Z0-9]+)\]/g)].pop()?.[1] ?? '?';
    const chunk = (delta, finish = null) => `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 0, model: 'stand-in', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(chunk({ role: 'assistant', content: `Answer for ${tag}.` }) + chunk({}, 'stop') + 'data: [DONE]\n\n');
  });
});
await new Promise((r) => up.listen(upPort, '127.0.0.1', r));

const node = (id, question, x, y, extra = {}) => ({ id, type: 'thought', position: { x, y }, dragHandle: '.drag-handle', data: {
  question, response: '', responses: [], responseIndex: 0, isRoot: true, isBranch: false,
  isCollapsed: false, isEditing: false, isEditingResponse: false, isLoading: false, tokenCount: 0, highlights: [],
  highlightMode: 'off', attachments: [], excludedAttachmentIds: [], includedAttachmentIds: [], roleMode: 'inherit', webSearch: false, scholarSearch: false, recall: false, ...extra } });
const solid = (source, target, data = {}) => ({ id: `edge-${source}-${target}`, source, target, type: 'smoothstep', sourceHandle: 'continue', targetHandle: 'top', style: { strokeWidth: 2 }, data });

const st = (fn, arg) => page.evaluate(fn, arg);
const nodesNow = () => st(() => window.__store.getState().nodes.map((n) => ({ id: n.id, q: n.data.question, r: n.data.response, x: n.position.x, y: n.position.y, archived: !!n.data.archived, loading: !!n.data.isLoading })));
const edgesNow = () => st(() => window.__store.getState().edges.map((e) => ({ id: e.id, s: e.source, t: e.target, cross: !!e.data?.isCrossLink, data: e.data ?? {} })));
async function waitAnswered(match) {
  await page.waitForFunction((m) => window.__store.getState().nodes.some((n) => n.data.question.includes(m) && n.data.response.startsWith('Answer for') && !n.data.isLoading), match, { timeout: 20000 });
}
// expand every row and read its full text (pending rows read as their marker)
async function readRows(scope) {
  const rows = scope.locator('[data-request-row]');
  const n = await rows.count();
  const outRows = [];
  for (let i = 0; i < n; i++) {
    const row = rows.nth(i);
    const kind = await row.getAttribute('data-request-row');
    const pending = (await row.getAttribute('data-pending')) !== null;
    const changed = (await row.getAttribute('data-changed')) !== null;
    if (pending) { outRows.push({ kind, pending, changed, content: null }); continue; }
    if (await row.locator('[data-request-full]').count() === 0) await row.locator('button').first().click();
    const content = await row.locator('[data-request-full]').textContent();
    const tokens = Number(await row.locator('button span.font-mono').last().textContent());
    outRows.push({ kind, pending, changed, content, tokens });
  }
  return outRows;
}

try {
  server = spawn(process.execPath, ['server.mjs'], { cwd: root, env: { ...env, PORT: String(apiPort), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  vite = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'], { cwd: root, env: { ...env, VITE_API_BASE: `http://127.0.0.1:${apiPort}` }, stdio: ['ignore', 'pipe', 'pipe'] });
  if (!(await waitHttp(`http://127.0.0.1:${apiPort}/api/models`)) || !(await waitHttp(`http://127.0.0.1:${webPort}/`))) throw Error('servers did not start');

  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: 'zh-CN' });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: `http://127.0.0.1:${webPort}` });
  context.setDefaultTimeout(20000);
  await context.addInitScript(() => { localStorage.setItem('weft.tutorialDone', '1'); localStorage.setItem('weft.lang', 'zh'); });
  page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.stack));
  page.on('dialog', (d) => d.accept());
  page.on('request', (r) => { if (r.url().endsWith('/api/stream') && r.method() === 'POST') { try { sent.push(JSON.parse(r.postData() ?? '{}')); } catch { /* not json */ } } });
  await page.goto(`http://127.0.0.1:${webPort}/`);
  await page.waitForFunction(() => window.__store?.persist?.hasHydrated?.());

  // R continues to C; M is a separate thread the follow-up will @-mention.
  await st(({ nodes, edges }) => {
    const s = window.__store.getState(); s.setNodes(nodes); s.setEdges(edges);
    window.__ui.setState({ webSearchEnabled: false, scholarSearchEnabled: false, mcpEnabled: false, recallEnabled: false, memoryEnabled: true });
  }, { nodes: [node('r', 'Main question [R]', 0, 0), node('c', 'Follow-up [C]', 0, 320), node('m', 'Side fact about canvases [M]', 700, 0)], edges: [solid('r', 'c')] });
  for (const id of ['r', 'm', 'c']) await st((id) => window.__store.getState().rerunNode(id, {}), id);
  await page.waitForFunction(() => window.__store.getState().nodes.every((n) => n.data.response.startsWith('Answer for')));
  await check('The three seed turns answer through the real server and the stand-in model', upstream.length >= 3, { requests: upstream.length });

  // ── The preview is the request ───────────────────────────────────
  await st(() => {
    const ui = window.__ui.getState();
    window.__ui.setState({ profile: { ...ui.profile, identity: { ...ui.profile.identity, text: '- Prefers short answers MEMFACT' } } });
    window.__store.getState().setSelectedNodeId('r');
    window.__ui.getState().setPanelOpen(true);
  });
  const box = page.locator('textarea[placeholder="继续追问…"], textarea[placeholder*="追问"]').last();
  await box.waitFor();
  await box.click();
  await box.pressSequentially('Next step [N] @Side');
  await page.keyboard.press('Enter'); // the @-picker takes the first match
  const draftAfterMention = await box.inputValue();
  await check('Typing @ and picking a node stages a mention in the draft', /「/.test(draftAfterMention), { draftAfterMention });
  await page.locator('input[type=file]').last().setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Staged file FILEFACT content') });
  await page.getByText('notes.txt').first().waitFor();
  const summaryBtn = page.locator('button[title="预览将要发送的确切上下文"]');
  await summaryBtn.click();
  const pop = page.locator('[data-request-rows]').first();
  await pop.waitFor();
  await page.screenshot({ path: file('01-preview.png') });
  let rows = await readRows(pop);
  await save('preview-rows.json', rows);
  const kinds = rows.map((r) => r.kind);
  await check('The preview starts with the system addition the server puts in front (date, language, marker rules)', kinds[0] === 'addition' && /^Current date: \d{4}-\d{2}-\d{2}\. Respond in the language/.test(rows[0].content ?? ''), { first: rows[0] });
  await check('The @-mentioned thread shows as a reference row before sending', rows.some((r) => r.kind === 'reference' && /Side fact about canvases/.test(r.content ?? '') && /Answer for M/.test(r.content ?? '')));
  await check('The staged file shows with its content', rows.some((r) => r.kind === 'material' && /FILEFACT/.test(r.content ?? '')));
  await check('The memory block shows, placed after the last answer', rows.some((r) => r.kind === 'memory' && /MEMFACT/.test(r.content ?? '')) && kinds.lastIndexOf('answer') < kinds.indexOf('memory'));
  await check('The question being typed is the last row', rows.at(-1)?.kind === 'ask' && rows.at(-1)?.content === draftAfterMention.trim());
  const summaryText = await summaryBtn.textContent();
  const shownTotal = Number(/~(\d+)/.exec(summaryText ?? '')?.[1]);
  const rowTotal = rows.reduce((n, r) => n + (r.tokens ?? 0), 0);
  await check('The "will send" total is the sum of the rows, system additions included', shownTotal === rowTotal && rows[0].tokens > 0, { shownTotal, rowTotal });
  await st(() => window.__ui.setState({ recallEnabled: true }));
  await page.locator('[data-request-row="recall"][data-pending]').waitFor();
  await check('With recall on, a pending recall row says it is searched at send time', await page.locator('[data-request-row="recall"][data-pending]').count() === 1);
  await st(() => window.__ui.setState({ recallEnabled: false }));
  await page.locator('[data-request-row="recall"]').waitFor({ state: 'detached' });
  await pop.locator('[data-copy-request]').click();
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  await check('Copy puts the whole request on the clipboard, system addition and reference included', /Current date:/.test(clip) && /Answer for M/.test(clip) && /FILEFACT/.test(clip) && /MEMFACT/.test(clip), { length: clip.length });
  rows = await readRows(pop);

  const sentBefore = sent.length, upBefore = upstream.length;
  await box.click();
  await page.keyboard.press('Enter');
  await waitAnswered('[N]');
  const req = sent[sentBefore];
  const reqContents = (req?.messages ?? []).map((m) => text(m.content));
  const previewContents = rows.filter((r) => r.kind !== 'addition').map((r) => r.content);
  await save('sent-request.json', req);
  await check('The page sends exactly the previewed messages, in order', JSON.stringify(reqContents) === JSON.stringify(previewContents), { sent: reqContents.length, preview: previewContents.length });
  await check('The first answer reads the @-mentioned thread (it used to be left out)', reqContents.some((c) => c.startsWith('[Reference:') && /Answer for M/.test(c)));
  const upMsgs = upstream[upBefore] ?? [];
  const upSystem = upMsgs.filter((m) => m.role === 'system').map((m) => text(m.content)).join('\n\n');
  const previewSystem = [rows[0].content, ...rows.filter((r) => r.kind === 'role').map((r) => r.content), ...rows.filter((r, i) => r.kind === 'addition' && i > 0).map((r) => r.content)].join('\n\n');
  const upRest = upMsgs.filter((m) => m.role !== 'system').map((m) => text(m.content));
  await save('upstream-request.json', upMsgs);
  await check('The server forwards the system prompt the preview showed, word for word', upSystem === previewSystem, { upSystem: upSystem.slice(0, 120) });
  await check('The server forwards the previewed conversation unchanged', JSON.stringify(upRest) === JSON.stringify(previewContents.filter((_, i) => rows.filter((r) => r.kind !== 'addition')[i].kind !== 'role')));

  // ── Receipts ─────────────────────────────────────────────────────
  const nId = await st(() => window.__store.getState().nodes.find((n) => n.data.question.includes('[N]')).id);
  await st((id) => { window.__store.getState().setSelectedNodeId(id); window.__ui.getState().setPanelOpen(true); }, nId);
  await page.locator('[data-open-receipt]').first().click();
  const modal = page.locator('[data-receipt-modal]');
  await modal.locator('[data-request-rows]').waitFor();
  let rec = await readRows(modal);
  await page.screenshot({ path: file('02-receipt.png') });
  await save('receipt-rows.json', rec);
  await check('The answer keeps its request: the receipt equals what was sent, system addition first', rec[0]?.kind === 'addition' && JSON.stringify(rec.filter((r) => r.kind !== 'addition').map((r) => r.content)) === JSON.stringify(reqContents));
  await check('Right after answering, nothing in the receipt is marked as changed', rec.every((r) => !r.changed));
  await modal.locator('button').filter({ has: page.locator('svg.lucide-x') }).first().click();
  await st(() => window.__store.getState().editResponse('m', 'Revised side fact REVISED'));
  await page.locator('[data-open-receipt]').first().click();
  await modal.locator('[data-request-rows]').waitFor();
  rec = await readRows(modal);
  await page.screenshot({ path: file('03-receipt-changed.png') });
  await check('After the mentioned answer is edited, the receipt still shows the old text and marks that row as changed', rec.some((r) => r.kind === 'reference' && r.changed && /Answer for M/.test(r.content ?? '')) && rec.filter((r) => r.changed).length === 1, { changed: rec.filter((r) => r.changed).map((r) => r.kind) });
  await modal.locator('button').filter({ has: page.locator('svg.lucide-x') }).first().click();
  await st(() => {
    const s = window.__store.getState();
    s.setNodes(s.nodes.map((n) => (n.id === 'r' ? { ...n, data: { ...n.data, generatedAts: ['2020-01-01T00:00:00.000Z'] } } : n)));
    s.setSelectedNodeId('r');
  });
  await page.locator('[data-open-receipt]').first().click();
  await page.locator('[data-receipt-none]').waitFor();
  await check('A version with no kept request says so instead of showing something else', await page.locator('[data-receipt-none]').count() === 1);
  await modal.locator('button').filter({ has: page.locator('svg.lucide-x') }).first().click();
  const store = await page.evaluate(() => new Promise((resolve) => {
    const open = indexedDB.open('keyval-store');
    open.onsuccess = () => {
      const tx = open.result.transaction('keyval', 'readonly');
      const all = tx.objectStore('keyval').getAllKeys();
      all.onsuccess = async () => {
        const keys = all.result.map(String);
        const recKeys = keys.filter((k) => k.startsWith('gen-receipt:'));
        const get = (k) => new Promise((r) => { const q = open.result.transaction('keyval', 'readonly').objectStore('keyval').get(k); q.onsuccess = () => r(q.result); });
        let refs = 0;
        for (const k of recKeys) { const v = await get(k); refs += v.additions.length + v.messages.length; }
        resolve({ receipts: recKeys.length, refs, blobs: keys.filter((k) => k.startsWith('ctx-blob:')).length });
      };
    };
  }));
  await check('Receipts share their texts: fewer stored texts than references to them', store.receipts >= 4 && store.blobs < store.refs, store);

  // ── Insert a step into a solid line ──────────────────────────────
  await st(() => { window.__store.getState().setSelectedNodeId(null); window.__ui.getState().setPanelOpen(false); });
  await page.waitForTimeout(300);
  await page.evaluate(() => window.__rf.fitView({ padding: 0.2 }));
  await page.waitForTimeout(600);
  const rc = (await edgesNow()).find((e) => e.s === 'r' && e.t === 'c');
  const cBefore = (await nodesNow()).find((n) => n.id === 'c');
  await st((id) => { const s = window.__store.getState(); s.setEdges(s.edges.map((e) => (e.id === id ? { ...e, data: { ...e.data, contextOrder: 1 } } : e))); }, rc.id);
  const rcBox = await page.locator(`[data-testid="rf__edge-${rc.id}"] path`).last().boundingBox();
  await page.mouse.click(rcBox.x + rcBox.width / 2, rcBox.y + rcBox.height / 2, { button: 'right' });
  await page.locator('[data-insert-step]').click();
  await page.locator('[data-insert-input]').fill('Inserted step [I]');
  const sentBeforeI = sent.length;
  await page.locator('[data-insert-input]').press('Enter');
  await waitAnswered('[I]');
  const ns = await nodesNow(), es = await edgesNow();
  const I = ns.find((n) => n.q.includes('[I]')), R = ns.find((n) => n.id === 'r'), C = ns.find((n) => n.id === 'c');
  await page.screenshot({ path: file('04-inserted.png') });
  await check('The step sits in the line: R continues to the new step, the new step to C, R no longer straight to C',
    es.some((e) => e.s === 'r' && e.t === I.id && !e.cross) && es.some((e) => e.s === I.id && e.t === 'c' && !e.cross) && !es.some((e) => e.s === 'r' && e.t === 'c'));
  await check('The rewired line keeps what it carried (its place in a merge order)', es.find((e) => e.s === I.id && e.t === 'c')?.data.contextOrder === 1);
  const iReq = (sent[sentBeforeI]?.messages ?? []).map((m) => text(m.content)).join('\n');
  await check('The inserted step reads what comes before it, not what comes after', /Answer for R/.test(iReq) && !/Answer for C/.test(iReq));
  await check('The layout follows the arrows: the step sits between R and C, in the column C keeps', R.y < I.y && I.y < C.y && Math.abs(I.x - C.x) < 5 && Math.abs(C.x - cBefore.x) < 5, { R: [R.x, R.y], I: [I.x, I.y], C: [C.x, C.y], cBefore: [cBefore.x, cBefore.y] });
  await st(() => window.__store.getState().recomputeStaleness(false));
  await check('C, which now reads the inserted step, is marked as stale', (await st(() => window.__store.getState().staleIds)).includes('c'));

  // ── Move a line ──────────────────────────────────────────────────
  const ref = es.find((e) => e.cross && e.s === 'm');
  await st(() => { window.__store.getState().setSelectedNodeId(null); window.__ui.getState().setPanelOpen(false); });
  await page.waitForTimeout(300);
  await page.evaluate(() => window.__rf.fitView({ padding: 0.2 }));
  await page.waitForTimeout(600);
  const anchors = await page.locator(`[data-testid="rf__edge-${ref.id}"] .react-flow__edgeupdater`).count();
  await check('A line shows grab points at both ends', anchors === 2, { anchors });
  const grab = await page.locator(`[data-testid="rf__edge-${ref.id}"] .react-flow__edgeupdater-target`).boundingBox();
  const drop = await page.locator('.react-flow__node[data-id="c"] .react-flow__handle.target').first().boundingBox();
  await page.mouse.move(grab.x + grab.width / 2, grab.y + grab.height / 2);
  await page.mouse.down();
  await page.mouse.move(drop.x + drop.width / 2, drop.y + drop.height / 2, { steps: 20 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  const es2 = await edgesNow();
  await page.screenshot({ path: file('05-moved.png') });
  await check('Dragging the reference\'s end onto C moves it there, still a reference', es2.some((e) => e.s === 'm' && e.t === 'c' && e.cross) && !es2.some((e) => e.s === 'm' && e.t === nId), { refs: es2.filter((e) => e.cross).map((e) => `${e.s}->${e.t}`) });
  await st(() => window.__store.getState().recomputeStaleness(false));
  await check('The node that lost the reference is marked as stale', (await st(() => window.__store.getState().staleIds)).includes(nId));

  const refusals = await st(({ iId }) => {
    const s = window.__store.getState();
    const now = () => JSON.stringify(window.__store.getState().edges.map((e) => [e.id, e.source, e.target]));
    const toasts = () => window.__ui.getState().toasts.map((x) => x.message);
    const res = {};
    const ri = s.edges.find((e) => e.source === 'r' && e.target === iId);
    let before = now(); s.reconnectEdge(ri.id, { source: 'c', target: iId }); res.cycle = now() === before && toasts().some((m) => m.includes('循环'));
    s.setNodes([...window.__store.getState().nodes, { id: 'mat', type: 'content', position: { x: 900, y: 600 }, data: { ...window.__store.getState().nodes[0].data, question: 'A note', response: '', stepKind: 'note' } }]);
    before = now(); window.__store.getState().reconnectEdge(ri.id, { source: 'r', target: 'mat' }); res.material = now() === before && toasts().some((m) => m.includes('材料和框架'));
    window.__store.getState().setEdges([...window.__store.getState().edges, { id: 'edge-r-m-branch', source: 'r', target: 'm', sourceHandle: 'branch', targetHandle: 'left', type: 'smoothstep', data: { isBranchFromSelection: true } }]);
    before = now(); window.__store.getState().reconnectEdge('edge-r-m-branch', { source: 'r', target: 'c' }); res.branch = now() === before && toasts().some((m) => m.includes('选中文字'));
    const ic = window.__store.getState().edges.find((e) => e.source === iId && e.target === 'c');
    before = now(); window.__store.getState().reconnectEdge(ic.id, { source: 'm', target: 'c' }); res.duplicate = now() === before && toasts().some((m) => m.includes('已经有一条线'));
    window.__store.getState().setEdges(window.__store.getState().edges.filter((e) => e.id !== 'edge-r-m-branch'));
    window.__store.getState().reconnectEdge(ic.id, { source: 'r', target: 'c' });
    const moved = window.__store.getState().edges.find((e) => e.source === 'r' && e.target === 'c');
    res.solidMoved = !!moved && !moved.data?.isCrossLink && moved.data?.contextOrder === 1 && !window.__store.getState().edges.some((e) => e.source === iId && e.target === 'c');
    return res;
  }, { iId: I.id });
  await check('Moving a solid line so it would close a cycle is refused', refusals.cycle);
  await check('Moving a line onto a material is refused', refusals.material);
  await check('A line branched from selected text cannot be moved', refusals.branch);
  await check('Moving a line onto a pair that is already connected is refused', refusals.duplicate);
  await check('Moving only the source of a solid line keeps it solid and keeps its merge order', refusals.solidMoved);

  // ── Deleting a middle step ───────────────────────────────────────
  await st(({ iId }) => {
    const s = window.__store.getState();
    s.setEdges([...s.edges.filter((e) => !(e.source === 'r' && e.target === 'c')), { id: `edge-${iId}-c`, source: iId, target: 'c', type: 'smoothstep', sourceHandle: 'continue', targetHandle: 'top', data: {} }]);
    s.pushHistory();
    s.deleteNode(iId);
  }, { iId: I.id });
  const action = page.getByRole('button', { name: '撤销，改为只归档这一步' });
  await action.waitFor();
  const afterDelete = (await nodesNow()).map((n) => n.id);
  await check('Deleting a middle step says its downstream went too and offers to archive just the step', !afterDelete.includes(I.id) && !afterDelete.includes('c'));
  await action.click();
  const restored = await nodesNow();
  await page.screenshot({ path: file('06-archived.png') });
  await check('"Archive just this step" brings everything back with only that step archived', restored.find((n) => n.id === I.id)?.archived === true && restored.some((n) => n.id === 'c' && !n.archived));
  await check('No page errors', errors.length === 0, { errors });
} catch (e) {
  errors.push(e.stack ?? String(e));
  await check('Run completed without an exception', false, { error: String(e.stack ?? e) });
} finally {
  await browser?.close().catch(() => {});
  server?.kill(); vite?.kill(); up?.close();
  const passed = checks.filter((c) => c.ok).length;
  await save('summary.json', { verdict: passed === checks.length ? 'PASS' : 'FAIL', passed, total: checks.length, checks, errors });
  await fs.rm(home, { recursive: true, force: true });
  console.log(`\n${passed}/${checks.length} ${passed === checks.length ? 'PASS' : 'FAIL'} · ${out}`);
  process.exit(passed === checks.length ? 0 : 1);
}
