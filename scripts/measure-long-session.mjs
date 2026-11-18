#!/usr/bin/env node
// Condense a real long local agent session and measure what the next turn
// would send, before and after, through the app's own pre-send preview.
//   node scripts/measure-long-session.mjs <session-id> [--model <id>]
// Reads sessions from the real ~/.claude and ~/.codex (read-only); the canvas
// lives in a throwaway WEFT_HOME and browser profile. The evidence holds
// numbers only: no question or answer text leaves the machine's sessions.
import { chromium } from 'playwright-core';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sessionId = process.argv[2];
if (!sessionId) { console.error('usage: measure-long-session.mjs <session-id> [--model <id>]'); process.exit(2); }
const modelArg = process.argv.includes('--model') ? process.argv[process.argv.indexOf('--model') + 1] : null;
const out = path.join(root, 'evidence', `long-session-${Date.now()}`);
const weftHome = path.join(out, 'weft-home');
await fs.mkdir(weftHome, { recursive: true });
const apiPort = 3198, webPort = 5198, api = `http://127.0.0.1:${apiPort}`;
const result = { session: sessionId, startedAt: new Date().toISOString() };
let browser, server, vite, page;
const save = () => fs.writeFile(path.join(out, 'summary.json'), JSON.stringify(result, null, 2));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
async function waitHttp(url) {
  for (let i = 0; i < 200; i++) { try { if ((await fetch(url)).ok) return true; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 150)); }
  return false;
}
const env = { ...process.env, WEFT_HOME: weftHome };

try {
  server = spawn(process.execPath, ['server.mjs'], { cwd: root, env: { ...env, PORT: String(apiPort), HOST: '127.0.0.1' }, stdio: 'ignore' });
  vite = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'], { cwd: root, env: { ...env, VITE_API_BASE: api }, stdio: 'ignore' });
  if (!(await waitHttp(`${api}/api/models`)) || !(await waitHttp(`http://127.0.0.1:${webPort}/`))) throw Error('servers did not start');
  for (let i = 0; i < 60; i++) { if (((await (await fetch(`${api}/api/models`)).json()).models ?? []).length) break; await new Promise((r) => setTimeout(r, 500)); }

  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: 'zh-CN' });
  context.setDefaultTimeout(30000);
  await context.addInitScript(() => { localStorage.setItem('weft.tutorialDone', '1'); localStorage.setItem('weft.lang', 'zh'); });
  page = await context.newPage();
  await page.goto(`http://127.0.0.1:${webPort}/#open=${encodeURIComponent(`weft://open?session=${sessionId}`)}`);
  await page.waitForFunction(() => window.__store?.persist?.hasHydrated?.());
  // the mirror grows as the file is read; settle when the count stops moving
  let last = -1;
  for (let i = 0; i < 240; i++) {
    const n = await page.evaluate(() => window.__store.getState().nodes.length);
    if (n > 0 && n === last) break;
    last = n; await page.waitForTimeout(1000);
  }
  await page.waitForTimeout(2000);

  const shape = () => page.evaluate(async () => {
    const { isQaTurn } = await import('/src/lib/condense.ts');
    const { countTokens } = await import('/src/utils.ts');
    const s = window.__store.getState();
    const qa = s.nodes.filter((n) => isQaTurn(n));
    const qaTok = qa.reduce((sum, n) => sum + countTokens(`${n.data.question}\n${n.data.response}`), 0);
    return { nodes: s.nodes.length, qaTurns: qa.length, qaTokens: qaTok };
  });
  result.original = await shape();
  log('opened', result.original);

  // the frontier: the newest Q&A turn with nothing hanging below it
  const frontier = await page.evaluate(async () => {
    const { isQaTurn } = await import('/src/lib/condense.ts');
    const s = window.__store.getState();
    const hasOut = new Set(s.edges.map((e) => e.source));
    const leaves = s.nodes.filter((n) => isQaTurn(n) && !hasOut.has(n.id));
    leaves.sort((a, b) => (Date.parse(b.data.createdAt ?? 0) || 0) - (Date.parse(a.data.createdAt ?? 0) || 0));
    return leaves[0] ? { id: leaves[0].id, question: leaves[0].data.question } : null;
  });
  if (!frontier) throw Error('no frontier turn');
  // the computation behind "将发送 ~N tok · M 条消息" above the follow-up box, with an empty draft;
  // the same request is also measured with the box's "Inherit attachments" switch off
  const willSend = (id) => page.evaluate(async (nid) => {
    const { previewAsk } = await import('/src/lib/request-view.ts');
    const st = window.__store.getState();
    const measure = (opts) => {
      const p = previewAsk(st, '', { parentId: nid, ...opts }, []);
      const by = (kinds) => p.rows.filter((r) => kinds.includes(r.kind)).reduce((n, r) => n + r.tokens, 0);
      return { tokens: p.rows.reduce((n, r) => n + r.tokens, 0), messages: p.rows.length, materials: p.rows.filter((r) => r.kind === 'material').length, materialTokens: by(['material']), chainTokens: by(['question', 'answer', 'passage']) };
    };
    return { default: measure({}), withoutInherited: measure({ excludeAllInheritedAttachments: true }) };
  }, id);
  result.original.frontierWillSend = await willSend(frontier.id);
  log('frontier before', JSON.stringify(result.original.frontierWillSend));

  // condense through the window, every candidate segment as the window ticks them
  await page.evaluate(() => window.__ui.getState().setCondenseDialogOpen(true));
  await page.locator('[data-condense-dialog]').waitFor();
  const scanline = await page.locator('[data-condense-scanline]').textContent().catch(() => null);
  const totalLine = await page.locator('[data-condense-total]').textContent().catch(() => null);
  const ids = await page.evaluate(async () => (await (await import('/src/lib/use-models.ts')).getModelsOnce())?.models.map((m) => m.id) ?? []);
  const model = modelArg && ids.includes(modelArg) ? modelArg : ids.find((id) => /glm-5\.3-flash/.test(id)) ?? ids.find((id) => /flash/.test(id)) ?? ids[0];
  if (model) await page.locator('[data-condense-model]').selectOption(model).catch(() => {});
  result.condense = { model, scanline: scanline?.trim(), estimate: totalLine?.trim(), segments: await page.locator('[data-condense-item]').count() };
  log('condense', result.condense);
  await save();
  const t0 = Date.now();
  await page.locator('[data-condense-build]').click();
  let status = 'building';
  while (Date.now() - t0 < 60 * 60 * 1000) {
    const run = await page.evaluate(() => { const r = window.__ui.getState().condenseRun; return { status: r.status, current: r.current, total: r.total, error: r.error }; });
    status = run.status;
    if (status === 'done' || status === 'error' || status === 'idle') { result.condense.run = run; break; }
    if ((Date.now() - t0) % 30000 < 5000) log(`segment ${run.current}/${run.total}`);
    await page.waitForTimeout(5000);
  }
  result.condense.seconds = Math.round((Date.now() - t0) / 1000);
  if (status !== 'done') throw Error(`condense ended as ${status}: ${result.condense.run?.error ?? 'timeout'}`);
  await page.keyboard.press('Escape');

  // the copy's frontier: the copied twin of the original frontier
  const copy = await page.evaluate(async ({ q }) => {
    const { isQaTurn } = await import('/src/lib/condense.ts');
    const { countTokens } = await import('/src/utils.ts');
    const s = window.__store.getState();
    const orig = new Set(window.__ui.getState().condenseRun.originalIds);
    const fresh = s.nodes.filter((n) => !orig.has(n.id));
    const twin = fresh.find((n) => n.data.question === q);
    const qa = fresh.filter((n) => isQaTurn(n) || n.data.condensedFrom);
    return {
      nodes: fresh.length,
      turns: qa.length,
      tokens: fresh.reduce((sum, n) => sum + countTokens(`${n.data.question ?? ''}\n${n.data.response ?? ''}`), 0),
      frontierId: twin?.id ?? null,
    };
  }, { q: frontier.question });
  if (!copy.frontierId) throw Error('the copy has no twin of the frontier');
  result.copy = { nodes: copy.nodes, turns: copy.turns, tokens: copy.tokens };
  result.copy.frontierWillSend = await willSend(copy.frontierId);
  result.originalUntouched = (await shape()).qaTurns >= result.original.qaTurns;
  const pct = (b, a) => Math.round(((b - a) / b) * 1000) / 10;
  const o = result.original.frontierWillSend, c = result.copy.frontierWillSend;
  result.reduction = {
    canvasQa: pct(result.original.qaTokens, result.copy.tokens),
    nextTurnDefault: pct(o.default.tokens, c.default.tokens),
    nextTurnWithoutInherited: pct(o.withoutInherited.tokens, c.withoutInherited.tokens),
    originalDefaultToCopyWithoutInherited: pct(o.default.tokens, c.withoutInherited.tokens),
  };
  log('frontier after', JSON.stringify(c), JSON.stringify(result.reduction));

  result.verdict = 'DONE';
} catch (err) {
  result.verdict = 'FAIL';
  result.error = err instanceof Error ? err.message : String(err);
  console.error(result.error);
} finally {
  result.finishedAt = new Date().toISOString();
  await save();
  await browser?.close().catch(() => {});
  server?.kill(); vite?.kill();
  await fs.rm(weftHome, { recursive: true, force: true }).catch(() => {});
  console.log(`${result.verdict} · ${out}`);
}
