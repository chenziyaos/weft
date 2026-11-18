#!/usr/bin/env node
// Bring your own endpoints: a machine with no key and no model configured,
// where the person connects their own endpoints through the settings dialog.
//  1. the server starts empty; the dialog says how to connect;
//  2. an OpenAI-compatible endpoint added by URL and key answers turns;
//  3. a self-hosted /v1/systemone endpoint becomes the decision model;
//  4. a two-model fan-out on that endpoint gets verdicts from that judge;
//  5. the re-answer menu offers that endpoint's models.
// Both endpoints are local stand-ins: the point is the wiring, not the answers.
import { chromium } from 'playwright-core';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'evidence', `byo-${Date.now()}`);
// an empty home: nothing configured on this machine
const home = path.join(out, 'home');
await fs.mkdir(home, { recursive: true });
const apiPort = Number(process.env.BYO_API_PORT ?? 3195), webPort = Number(process.env.BYO_WEB_PORT ?? 5195);
const chatPort = Number(process.env.BYO_CHAT_PORT ?? 3194), judgePort = Number(process.env.BYO_JUDGE_PORT ?? 3193);
const api = `http://127.0.0.1:${apiPort}`;
const KEY = 'sk-byo-standin';
const checks = [], errors = [], chatCalls = [], judgeCalls = [];
let browser, server, vite, page, chat, judge;
const file = (name) => path.join(out, name);
const save = (name, data) => fs.writeFile(file(name), typeof data === 'string' ? data : JSON.stringify(data, null, 2));
async function check(name, ok, detail = {}) {
  checks.push({ name, ok: !!ok, ...detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok && page) await page.screenshot({ path: file(`failure-${checks.length}.png`) }).catch(() => {});
}
const env = { ...process.env, HOME: home, USERPROFILE: home, WEFT_HOME: path.join(home, '.weft') };
for (const k of Object.keys(env)) if (/_API_KEY$/.test(k)) delete env[k];
async function waitHttp(url) {
  for (let i = 0; i < 200; i++) { try { if ((await fetch(url)).ok) return true; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 150)); }
  return false;
}
const readBody = (req) => new Promise((r) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch { r({}); } }); });

// The person's own chat endpoint: two models, a key it insists on.
chat = http.createServer(async (req, res) => {
  const auth = req.headers.authorization ?? '';
  if (auth !== `Bearer ${KEY}`) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end('{"error":"bad key"}'); return; }
  if (req.url.endsWith('/models')) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ data: [{ id: 'alpha-small' }, { id: 'beta-large' }] })); return; }
  const j = await readBody(req);
  chatCalls.push({ model: j.model, messages: (j.messages ?? []).length });
  const text = j.model === 'beta-large' ? 'GOOD: owners and deadlines are missing, and nobody checks back.' : 'Weak: documents are long.';
  const chunk = (delta, finish = null) => `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 0, model: j.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.end(chunk({ role: 'assistant', content: text }) + chunk({}, 'stop') + 'data: [DONE]\n\n');
});
// The person's own decision model: the System One contract, answers rated by a marker.
judge = http.createServer(async (req, res) => {
  const j = await readBody(req);
  judgeCalls.push({ url: req.url, questions: Object.keys(j.questions ?? {}) });
  const answers = {};
  const texts = j.state?.answers ?? {};
  for (const [k, q] of Object.entries(j.questions ?? {})) {
    const good = (id) => /GOOD/.test(String(texts[id] ?? ''));
    if (k === 'best') {
      const ids = Object.keys(q.criteria ?? {}); const w = ids.map((id) => (good(id) ? 8 : 1)); const sum = w.reduce((a, b) => a + b, 0);
      const probabilities = Object.fromEntries(ids.map((id, i) => [id, w[i] / sum]));
      answers[k] = { type: 'choice', choice: ids[w.indexOf(Math.max(...w))], probabilities };
    } else if (k.startsWith('ok_')) answers[k] = { type: 'noul', noul: good(k.slice(3)) ? 0.92 : 0.21 };
    else if (k.startsWith('q_')) answers[k] = { type: 'score', probabilities: good(k.slice(2)) ? { 0: 0.02, 1: 0.08, 2: 0.5, 3: 0.4 } : { 0: 0.3, 1: 0.5, 2: 0.15, 3: 0.05 } };
    else if (q.type === 'noul') answers[k] = { type: 'noul', noul: 0.5 };
    else if (q.type === 'choice') { const ids = Object.keys(q.criteria ?? {}); answers[k] = { type: 'choice', choice: ids[0], probabilities: Object.fromEntries(ids.map((id) => [id, 1 / ids.length])) }; }
    else { const n = (q.criteria ?? []).length || 1; answers[k] = { type: 'score', probabilities: Object.fromEntries(Array.from({ length: n }, (_, i) => [String(i), 1 / n])) }; }
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ model: 'standin-judge', answers }));
});
await new Promise((r) => chat.listen(chatPort, '127.0.0.1', r));
await new Promise((r) => judge.listen(judgePort, '127.0.0.1', r));

try {
  server = spawn(process.execPath, ['server.mjs'], { cwd: root, env: { ...env, PORT: String(apiPort), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let serverLog = '';
  server.stdout.on('data', (d) => { serverLog += d; });
  server.stderr.on('data', (d) => { serverLog += d; });
  vite = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'], { cwd: root, env: { ...env, VITE_API_BASE: api }, stdio: ['ignore', 'pipe', 'pipe'] });
  if (!(await waitHttp(`${api}/api/models`)) || !(await waitHttp(`http://127.0.0.1:${webPort}/`))) throw Error('servers did not start');

  // ── 1. nothing configured ───────────────────────────────────────
  const models0 = await (await fetch(`${api}/api/models`)).json();
  await check('The server starts with no key and no model', (models0.models ?? []).length === 0, { models: (models0.models ?? []).length });

  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: 'zh-CN' });
  context.setDefaultTimeout(20000);
  await context.addInitScript(() => { localStorage.setItem('weft.tutorialDone', '1'); localStorage.setItem('weft.lang', 'zh'); });
  page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.stack));
  page.on('dialog', (d) => d.accept());
  await page.goto(`http://127.0.0.1:${webPort}/`);
  await page.waitForFunction(() => window.__store?.persist?.hasHydrated?.());
  await page.evaluate(() => window.__ui.getState().setApiKeyModalOpen(true));
  await page.locator('[data-provider-add]').waitFor();
  await page.screenshot({ path: file('01-settings-empty.png') });

  // ── 2. the person's own chat endpoint ───────────────────────────
  await page.locator('[data-provider-add]').click();
  await page.locator('[data-preset="custom"]').click();
  await page.locator('[data-provider-url]').fill(`http://127.0.0.1:${chatPort}/v1`);
  await page.locator('[data-provider-key]').fill(KEY);
  await page.locator('[data-provider-probe]').click();
  await page.locator('[data-provider-models] label').first().waitFor();
  const boxes = page.locator('[data-provider-models] input[type="checkbox"]');
  for (let i = 0; i < await boxes.count(); i++) if (!(await boxes.nth(i).isChecked())) await boxes.nth(i).check();
  await page.screenshot({ path: file('02-own-endpoint-probed.png') });
  await page.locator('[data-provider-save]').click();
  await page.locator('[data-provider-add]').waitFor();
  const ids = await page.evaluate(async () => (await (await import('/src/lib/use-models.ts')).getModelsOnce())?.models.map((m) => m.id) ?? []);
  const alpha = ids.find((id) => /alpha-small/.test(id)), beta = ids.find((id) => /beta-large/.test(id));
  await check('The endpoint is added by URL and key, its two models listed', !!alpha && !!beta, { ids });

  // ── 3. the person's own decision model ──────────────────────────
  await page.locator('[data-apikey-tab="fast"]').click();
  await page.locator('[data-judge-settings]').waitFor();
  if (await page.locator('[data-judge-provider]').count() === 0) await page.locator('[data-judge-other]').click();
  await page.locator('[data-judge-provider]').selectOption('custom');
  await page.locator('input[placeholder="http://127.0.0.1:8000/v1/systemone"]').fill(`http://127.0.0.1:${judgePort}/v1/systemone`);
  await page.locator('[data-judge-test]').click();
  await page.locator('[data-judge-test-result]').waitFor();
  const testText = await page.locator('[data-judge-test-result]').textContent();
  await page.screenshot({ path: file('03-own-judge.png') });
  await check('A self-hosted System One endpoint answers the decision model test', /standin-judge/.test(testText ?? ''), { testText });
  const eff = await page.evaluate(async () => { const j = await import('/src/lib/judge.ts'); return j.effectiveProvider(window.__ui.getState().judge); });
  await check('That endpoint is the decision model in effect', eff === 'custom', { eff });
  await page.evaluate(() => window.__ui.getState().setApiKeyModalOpen(false));

  // ── 4. a fan-out on the person's models, judged by the person's judge ──
  await page.evaluate(() => window.__ui.setState({ webSearchEnabled: false, scholarSearchEnabled: false, recallEnabled: false, memoryEnabled: false }));
  await page.evaluate(() => {
    const n = { id: 'root', type: 'thought', position: { x: 0, y: 0 }, dragHandle: '.drag-handle', data: { question: 'Why do postmortem action items stall?', response: 'Seed answer.', responses: ['Seed answer.'], responseIndex: 0, isRoot: true, isBranch: false, isCollapsed: false, isEditing: false, isEditingResponse: false, isLoading: false, tokenCount: 0, highlights: [], highlightMode: 'off', attachments: [], excludedAttachmentIds: [], includedAttachmentIds: [], roleMode: 'inherit' } };
    const s = window.__store.getState(); s.setNodes([n]); s.setEdges([]);
  });
  const judgeBefore = judgeCalls.length;
  await page.evaluate(({ a, b }) => window.__store.getState().fanOut('root', 'In one line: why do postmortem action items stall?', [{ name: 'a', prompt: '', model: a }, { name: 'b', prompt: '', model: b }]), { a: alpha, b: beta });
  const branches = await page.evaluate(() => window.__store.getState().edges.filter((e) => e.source === 'root').map((e) => e.target));
  await page.waitForFunction((ids) => ids.every((id) => window.__store.getState().nodes.find((n) => n.id === id)?.data.judgeScore), branches, { timeout: 30000 }).catch(() => {});
  const scored = await page.evaluate((ids) => ids.map((id) => { const n = window.__store.getState().nodes.find((x) => x.id === id); return { by: n.data.generatedBy?.[0], response: n.data.response, score: n.data.judgeScore ?? null }; }), branches);
  await save('fanout.json', scored);
  await check('Both branches are answered by the person\'s endpoint', scored.length === 2 && scored.every((s) => s.response) && chatCalls.some((c) => c.model === 'alpha-small') && chatCalls.some((c) => c.model === 'beta-large'), { chatCalls });
  const best = scored.find((s) => s.score?.rank === 1);
  await check('The person\'s judge scores them: the better answer ranks first', judgeCalls.length > judgeBefore && scored.every((s) => s.score?.model === 'standin-judge') && /beta-large/.test(best?.by ?? ''), { ranks: scored.map((s) => ({ by: s.by, rank: s.score?.rank, adequate: s.score?.adequate })) });
  await page.evaluate((ids) => window.__rf?.fitView({ nodes: ids.map((id) => ({ id })), padding: 0.1 }), branches);
  await page.waitForTimeout(600);
  const chips = await page.locator('.react-flow__node [data-answer-score]').count();
  await check('The cards show the verdicts', chips === 2, { chips });
  await page.screenshot({ path: file('04-fanout-own-judge.png') });

  // ── 5. re-answer offers the person's models ─────────────────────
  const weak = branches.find((_, i) => scored[i].score?.rank === 2) ?? branches[0];
  await page.locator(`.react-flow__node[data-id="${weak}"] [data-reanswer]`).click();
  await page.locator('[data-reanswer-menu]').waitFor();
  const offered = await page.locator('[data-reanswer-menu] [data-reanswer-model]').evaluateAll((els) => els.map((e) => e.getAttribute('data-reanswer-model')));
  await check('The re-answer menu offers the person\'s other model', offered.includes(beta), { offered });

  await check('No page errors', errors.length === 0, { errors });
} catch (err) {
  await check(`Unexpected failure: ${err instanceof Error ? err.message : String(err)}`, false);
} finally {
  await browser?.close().catch(() => {});
  server?.kill(); vite?.kill(); chat?.close(); judge?.close();
  await fs.rm(home, { recursive: true, force: true }).catch(() => {});
  const passed = checks.filter((c) => c.ok).length;
  const summary = { verdict: passed === checks.length ? 'PASS' : 'FAIL', passed, total: checks.length, checks, errors, judgeCalls: judgeCalls.length, chatCalls: chatCalls.length };
  await save('summary.json', summary);
  console.log(`\n${passed}/${checks.length} ${summary.verdict} · ${out}`);
  process.exitCode = summary.verdict === 'PASS' ? 0 : 1;
}
