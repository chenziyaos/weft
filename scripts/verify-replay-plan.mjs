#!/usr/bin/env node
// One-click replay follows the recompute plan: one confirmation also brings
// up to date the nodes quoting a stale node, runs them after the node they
// quote, skips nodes whose input did not change once their parents re-ran,
// never runs on top of a failed parent, and retries failed nodes. Real local server + Vite dev page; the model stream is
// answered by a deterministic stand-in inside the browser route, so no model
// is called.
import { chromium } from 'playwright-core';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'evidence', `replay-plan-${Date.now()}`);
const home = path.join(out, 'weft-home');
await fs.mkdir(home, { recursive: true });
const apiPort = Number(process.env.REPLAY_API_PORT ?? 3195), webPort = Number(process.env.REPLAY_WEB_PORT ?? 5195);
const checks = [], errors = [], requests = [];
let browser, server, vite, page;
const file = (name) => path.join(out, name);
const save = (name, data) => fs.writeFile(file(name), typeof data === 'string' ? data : JSON.stringify(data, null, 2));
async function check(name, ok, detail = {}) {
  checks.push({ name, ok: !!ok, ...detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok && page) await page.screenshot({ path: file(`failure-${checks.length}.png`) }).catch(() => {});
}
const env = { ...process.env, WEFT_HOME: home, OLLAMA_MODELS: 'stand-in', OLLAMA_BASE_URL: 'http://127.0.0.1:9' };
for (const k of Object.keys(env)) if (/_API_KEY$/.test(k)) delete env[k];
async function waitHttp(url) {
  for (let i = 0; i < 200; i++) { try { if ((await fetch(url)).ok) return true; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 150)); }
  return false;
}

// The stand-in model: the answer names the node and counts its versions.
// [STABLE] nodes always say the same thing; [FAILME] nodes fail while `failing`.
const versions = {};
let failing = false;
function standIn(body) {
  const msgs = body.messages ?? [];
  const last = [...msgs].reverse().find((m) => m.role === 'user');
  const text = typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content ?? '');
  const tag = [...text.matchAll(/\[([A-Z0-9]+)\]/g)].pop()?.[1] ?? '?';
  requests.push({ tag, context: msgs.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n---\n') });
  if (failing && tag === 'FAILME') return { status: 500, body: JSON.stringify({ error: 'synthetic failure' }) };
  versions[tag] = (versions[tag] ?? 0) + 1;
  const answer = tag === 'STABLE' ? 'Stable answer that never changes.' : `Answer for ${tag}, version ${versions[tag]}.`;
  return { status: 200, body: `data: ${JSON.stringify({ text: answer })}\n\ndata: [DONE]\n\n` };
}

const node = (id, question, x, y) => ({ id, type: 'thought', position: { x, y }, dragHandle: '.drag-handle', data: {
  question, response: '', responses: [], responseIndex: 0, isRoot: true, isBranch: false,
  isCollapsed: false, isEditing: false, isEditingResponse: false, isLoading: false, tokenCount: 0, highlights: [],
  highlightMode: 'off', attachments: [], excludedAttachmentIds: [], includedAttachmentIds: [], roleMode: 'inherit' } });
const solid = (source, target) => ({ id: `${source}-${target}`, source, target, type: 'smoothstep', sourceHandle: 'continue', targetHandle: 'top', style: { strokeWidth: 2 }, data: {} });
const ref = (source, target) => ({ id: `${source}~${target}`, source, target, type: 'smoothstep', sourceHandle: 'branch', targetHandle: 'left', style: { strokeDasharray: '8 4', strokeWidth: 2 }, data: { isCrossLink: true } });

// Z quotes into R (which continues to B), K and S. R is quoted by W (which
// continues to W2) and by K; S, which answers the same every time, is quoted
// by V. Y quotes into F, which continues to G; F fails on replay.
const nodes = [
  node('z', 'Source material [Z]', -500, 0), node('r', 'Main question [R]', 0, 0), node('b', 'Follow-up [B]', 0, 300),
  node('w', 'Quotes the main answer [W]', 450, 0), node('w2', 'After the quoting node [W2]', 450, 300),
  node('k', 'Quotes both [K]', 900, 0),
  node('s', 'Side question [STABLE]', -500, 600), node('v', 'Quotes the side answer [V]', 0, 600),
  node('y', 'Second source [Y]', -500, 900), node('f', 'Will fail on replay [FAILME]', 0, 900), node('g', 'After the failing node [G]', 0, 1200),
];
const edges = [ref('z', 'r'), solid('r', 'b'), ref('r', 'w'), solid('w', 'w2'), ref('z', 'k'), ref('r', 'k'), ref('z', 's'), ref('s', 'v'), ref('y', 'f'), solid('f', 'g')];
const order = ['z', 'y', 'r', 's', 'f', 'b', 'w', 'k', 'v', 'g', 'w2'];

try {
  server = spawn(process.execPath, ['server.mjs'], { cwd: root, env: { ...env, PORT: String(apiPort), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  vite = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'], { cwd: root, env: { ...env, VITE_API_BASE: `http://127.0.0.1:${apiPort}` }, stdio: ['ignore', 'pipe', 'pipe'] });
  if (!(await waitHttp(`http://127.0.0.1:${apiPort}/api/models`)) || !(await waitHttp(`http://127.0.0.1:${webPort}/`))) throw Error('servers did not start');

  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1500, height: 950 }, locale: 'zh-CN' });
  context.setDefaultTimeout(20000);
  await context.addInitScript(() => { localStorage.setItem('weft.tutorialDone', '1'); localStorage.setItem('weft.lang', 'zh'); });
  await context.route('**/api/stream', async (route) => {
    const r = standIn(JSON.parse(route.request().postData() ?? '{}'));
    await route.fulfill({ status: r.status, headers: { 'Content-Type': r.status === 200 ? 'text/event-stream' : 'application/json', 'Access-Control-Allow-Origin': '*' }, body: r.body });
  });
  page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.stack));
  page.on('dialog', (d) => d.accept());
  await page.goto(`http://127.0.0.1:${webPort}/`);
  await page.waitForFunction(() => window.__store?.persist?.hasHydrated?.());

  // Build the graph and answer every node once, in order.
  await page.evaluate(({ nodes, edges }) => { const s = window.__store.getState(); s.setNodes(nodes); s.setEdges(edges); }, { nodes, edges });
  for (const id of order) await page.evaluate((id) => window.__store.getState().rerunNode(id, {}), id);
  await page.evaluate(() => window.__store.getState().recomputeStaleness(false));
  const fresh = await page.evaluate(() => window.__store.getState().staleIds);
  await check('After answering every node once, nothing is stale', fresh.length === 0, { fresh });

  // Change both sources' answers: R and F go stale through their quotes.
  await page.evaluate(() => {
    const s = window.__store.getState();
    s.setNodes(s.nodes.map((n) => (n.id === 'z' || n.id === 'y')
      ? { ...n, data: { ...n.data, response: `${n.data.response} (revised)`, responses: [...n.data.responses.slice(0, -1), `${n.data.response} (revised)`] } } : n));
    s.recomputeStaleness(false);
  });
  const staleBefore = (await page.evaluate(() => window.__store.getState().staleIds)).sort();
  await check('Editing the sources makes their quoting nodes and continuations stale, but not the nodes quoting R or S', JSON.stringify(staleBefore) === JSON.stringify(['b', 'f', 'g', 'k', 'r', 's']), { staleBefore });
  const before = await page.evaluate(() => Object.fromEntries(window.__store.getState().nodes.map((n) => [n.id, n.data.responses.length])));

  // One click on the replay chip, read the dialog, confirm.
  failing = true;
  await page.locator('button[title^="按依赖顺序重跑"]').click();
  const dialog = page.getByText(/将按依赖顺序重放/);
  await dialog.waitFor();
  const dialogText = await dialog.textContent();
  await page.screenshot({ path: file('01-confirm.png') });
  await check('The confirmation counts the stale nodes and the nodes downstream of them', /重放 6 个陈旧或生成失败的节点，以及接在它们下面的 3 个节点/.test(dialogText ?? ''), { dialogText });
  await page.getByRole('button', { name: '开始重放' }).click();
  const summary = page.getByText(/重放完成：/).first();
  await summary.waitFor({ timeout: 30000 });
  const summaryText = await summary.textContent();
  await page.screenshot({ path: file('02-after-replay.png') });

  const after = await page.evaluate(() => Object.fromEntries(window.__store.getState().nodes.map((n) => [n.id, { versions: n.data.responses.length, failed: !!n.data.generationFailed, answer: n.data.response }])));
  const grew = (id) => after[id].versions === before[id] + 1;
  await check('One replay re-ran the stale nodes plus W and W2, which quote R and only change once R re-runs', ['r', 'b', 'k', 's', 'w', 'w2'].every(grew), { after });
  const kRequest = requests.filter((q) => q.tag === 'K').pop();
  await check("K was answered against R's new answer, not the old one", kRequest?.context.includes('Answer for R, version 2.') && !kRequest.context.includes('Answer for R, version 1.'), { kContext: kRequest?.context });
  const wRequest = requests.filter((q) => q.tag === 'W').pop();
  await check("W was answered against R's new answer", wRequest?.context.includes('Answer for R, version 2.'));
  await check("V was skipped: S answered the same, so V's input never changed", after.v.versions === before.v && versions.V === 1);
  await check('F failed and G did not run on top of the failed answer', after.f.failed && after.g.versions === before.g && versions.G === 1);
  const staleAfter = (await page.evaluate(() => { const s = window.__store.getState(); s.recomputeStaleness(false); return s.staleIds; })).sort();
  await check('Afterwards only the failed branch is left; the rest is up to date', staleAfter.every((id) => ['f', 'g'].includes(id)), { staleAfter });
  await check('The summary reports updated, unchanged, failed and not-run counts', /6 个节点已更新，1 个输入没变已跳过，1 个生成失败，1 个因上游失败未运行/.test(summaryText ?? ''), { summaryText });
  const chip = await page.locator('button[title^="按依赖顺序重跑"]').textContent().catch(() => '');
  await check('The replay chip stays available while a failed node is waiting for a retry', /\d/.test(chip ?? ''), { chip });

  // Retry once the failure is gone: the rest of that branch catches up.
  failing = false;
  await page.evaluate(() => window.__store.getState().replayStale());
  const retry = await page.evaluate(() => { const s = window.__store.getState(); s.recomputeStaleness(false); return { stale: s.staleIds, g: s.nodes.find((n) => n.id === 'g').data.responses.length, f: s.nodes.find((n) => n.id === 'f').data.generationFailed }; });
  await check('Replaying again after the failure clears it: F and then G are brought up to date', retry.stale.length === 0 && !retry.f && retry.g === before.g + 1, { retry });

  await check('No page errors', errors.length === 0, { errors });
} catch (err) {
  await check(`Unexpected failure: ${err.message}`, false, { stack: err.stack });
} finally {
  await browser?.close().catch(() => {});
  server?.kill('SIGTERM'); vite?.kill('SIGTERM');
  await fs.rm(path.join(home, 'canvas-bridge.json'), { force: true });
  const passed = checks.filter((c) => c.ok).length;
  await save('summary.json', { passed, failed: checks.length - passed, checks, requests: requests.map((r) => r.tag) });
  console.log(`\n${passed}/${checks.length} PASS · ${out}`);
  process.exitCode = passed === checks.length ? 0 : 1;
}
