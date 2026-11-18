#!/usr/bin/env node
// Earlier tool outputs stay out of a follow-up unless asked for.
// On a chain  A (agent: two outputs, one touched files; plus a file the user
// attached) → B (agent: one output) → C, it checks through the app's own
// compile, its pre-send preview and the attachments panel:
//  1. a follow-up on C carries neither A's nor B's outputs, keeps the note of
//     the files A touched, and keeps the user's file;
//  2. a follow-up on B carries B's own outputs (the turn it continues);
//  3. C's panel lists A's outputs as left out and B's (the turn C continues)
//     as included; one click brings one of A's back into C's own context;
//  4. a request past what most models hold shows the amber warning; a small one doesn't.
import { chromium } from 'playwright-core';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'evidence', `tool-outputs-${Date.now()}`);
const home = path.join(out, 'home');
await fs.mkdir(home, { recursive: true });
const apiPort = 3192, webPort = 5192, api = `http://127.0.0.1:${apiPort}`;
const checks = [], errors = [];
let browser, server, vite, page;
const file = (name) => path.join(out, name);
async function check(name, ok, detail = {}) {
  checks.push({ name, ok: !!ok, ...detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok && page) await page.screenshot({ path: file(`failure-${checks.length}.png`) }).catch(() => {});
}
async function waitHttp(url) {
  for (let i = 0; i < 200; i++) { try { if ((await fetch(url)).ok) return true; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 150)); }
  return false;
}
const env = { ...process.env, HOME: home, USERPROFILE: home, WEFT_HOME: path.join(home, '.weft') };
for (const k of Object.keys(env)) if (/_API_KEY$/.test(k)) delete env[k];

try {
  server = spawn(process.execPath, ['server.mjs'], { cwd: root, env: { ...env, PORT: String(apiPort), HOST: '127.0.0.1' }, stdio: 'ignore' });
  vite = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'], { cwd: root, env: { ...env, VITE_API_BASE: api }, stdio: 'ignore' });
  if (!(await waitHttp(`${api}/api/models`)) || !(await waitHttp(`http://127.0.0.1:${webPort}/`))) throw Error('servers did not start');
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: 'zh-CN' });
  context.setDefaultTimeout(20000);
  await context.addInitScript(() => { localStorage.setItem('weft.tutorialDone', '1'); localStorage.setItem('weft.lang', 'zh'); });
  page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.stack));
  await page.goto(`http://127.0.0.1:${webPort}/`);
  await page.waitForFunction(() => window.__store?.persist?.hasHydrated?.());

  const seed = (bigAnswer = '') => page.evaluate((big) => {
    const att = (id, name, content, extra = {}) => ({ id, name, type: 'text/plain', size: content.length, content, ...extra });
    const node = (id, x, y, q, r, attachments = []) => ({ id, type: 'thought', position: { x, y }, dragHandle: '.drag-handle', data: { question: q, response: r, responses: [r], responseIndex: 0, isRoot: id === 'A', isBranch: false, isCollapsed: false, isEditing: false, isEditingResponse: false, isLoading: false, tokenCount: 0, highlights: [], highlightMode: 'off', attachments, excludedAttachmentIds: [], includedAttachmentIds: [], roleMode: 'inherit', createdAt: new Date().toISOString() } });
    const nodes = [
      node('A', 0, 0, 'Find why the cache misses.', 'Read the config and ran the tests: the key format changed.', [
        att('a-run', 'tool: exec_command', '[call] npm test\n[result]\nTOOL-OUTPUT-A-RUN 42 passed'),
        att('a-edit', 'tool: apply_patch', '[call] edit src/cache.ts\n[result]\nTOOL-OUTPUT-A-EDIT ok', { op: 'edited', paths: ['/work/src/cache.ts'] }),
        att('a-file', 'notes.txt', 'USER-FILE-ON-A design notes'),
      ]),
      node('B', 0, 300, 'Fix the key format.', 'Changed the key builder; tests pass.', [
        att('b-run', 'tool: exec_command', '[call] npm test\n[result]\nTOOL-OUTPUT-B-RUN 43 passed'),
      ]),
      node('C', 0, 600, 'Summarize what changed.', `The key builder now includes the version.${big}`),
    ];
    const edges = [
      { id: 'e1', source: 'A', target: 'B', type: 'thought', data: {} },
      { id: 'e2', source: 'B', target: 'C', type: 'thought', data: {} },
    ];
    const s = window.__store.getState(); s.setNodes(nodes); s.setEdges(edges);
  }, bigAnswer);
  const followUp = (parentId) => page.evaluate(async (pid) => {
    const { previewAsk } = await import('/src/lib/request-view.ts');
    const p = previewAsk(window.__store.getState(), '', { parentId: pid }, []);
    return { text: p.rows.map((r) => r.content).join('\n'), tokens: p.rows.reduce((n, r) => n + r.tokens, 0) };
  }, parentId);
  const ownContext = (id) => page.evaluate((nid) => {
    const s = window.__store.getState(); const n = s.nodes.find((x) => x.id === nid);
    return window.__buildContext(nid, s.nodes, s.edges, undefined, n.data.excludedAttachmentIds, n.data.includedAttachmentIds).messages.map((m) => m.content).join('\n');
  }, id);

  await seed();
  // ── 1. a follow-up on C ──
  const onC = await followUp('C');
  await check('A follow-up on C carries no earlier tool output', !/TOOL-OUTPUT-A-RUN|TOOL-OUTPUT-A-EDIT|TOOL-OUTPUT-B-RUN/.test(onC.text), { tokens: onC.tokens });
  await check('It still notes the files A touched, without their contents', /Files this turn touched.*edited: cache\.ts/.test(onC.text));
  await check('The file the user attached to A still comes along', /USER-FILE-ON-A/.test(onC.text));
  // ── 2. a follow-up on B ──
  const onB = await followUp('B');
  await check('A follow-up on B carries B\'s own output, not A\'s', /TOOL-OUTPUT-B-RUN/.test(onB.text) && !/TOOL-OUTPUT-A-RUN/.test(onB.text));

  // ── 3. the panel on C ──
  await page.evaluate(() => window.__rf?.fitView({ nodes: [{ id: 'C' }], maxZoom: 1, duration: 0 }));
  await page.waitForTimeout(500);
  const card = page.locator('.react-flow__node[data-id="C"]');
  for (let i = 0; i < 3 && (await page.evaluate(() => window.__store.getState().selectedNodeId)) !== 'C'; i++) {
    await card.dblclick({ position: { x: 120, y: 16 }, timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(700);
  }
  const attSummary = page.locator('summary', { hasText: '附件' }).first();
  await attSummary.click();
  await page.waitForTimeout(300);
  const leftRows = page.locator('[data-tool-output-left]');
  const leftCount = await leftRows.count();
  await page.screenshot({ path: file('01-panel-left-out.png') });
  await check('C\'s panel lists A\'s two tool outputs as left out by default, B\'s as included', leftCount === 2, { leftCount });
  const runRow = page.locator('div.flex.items-center.gap-2.rounded-lg').filter({ hasText: 'tool: exec_command' }).filter({ hasText: 'Find why' }).first();
  await runRow.locator('button').last().click();
  await page.waitForTimeout(300);
  const ctxC = await ownContext('C');
  await check('One click brings that output into C\'s own context; A\'s other output stays out', /TOOL-OUTPUT-A-RUN/.test(ctxC) && !/TOOL-OUTPUT-A-EDIT/.test(ctxC) && /TOOL-OUTPUT-B-RUN/.test(ctxC));
  await page.screenshot({ path: file('02-panel-reincluded.png') });

  // ── 4. the warning ──
  const warnSmall = await page.locator('[data-context-over]').count();
  await check('A small request shows no window warning', warnSmall === 0);
  await page.locator('button[title="关闭面板"]').first().click().catch(() => {});
  await page.waitForFunction(() => window.__store?.persist?.hasHydrated?.());
  await seed(' filler'.repeat(260000));
  await page.evaluate(() => window.__store.getState().setSelectedNodeId(null));
  await page.waitForTimeout(300);
  for (let i = 0; i < 3 && (await page.evaluate(() => window.__store.getState().selectedNodeId)) !== 'C'; i++) {
    await card.dblclick({ position: { x: 120, y: 16 }, timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(900);
  }
  const warn = page.locator('[data-context-over]');
  await warn.waitFor({ timeout: 10000 }).catch(() => {});
  const warnText = (await warn.count()) ? await warn.textContent() : null;
  await page.screenshot({ path: file('03-over-window.png') });
  await check('A request past what most models hold shows the amber warning', /多数模型/.test(warnText ?? '') && /继承附件/.test(warnText ?? ''), { warnText });
  await check('No page errors', errors.length === 0, { errors });
} catch (err) {
  await check(`Unexpected failure: ${err instanceof Error ? err.message : String(err)}`, false);
} finally {
  await browser?.close().catch(() => {});
  server?.kill(); vite?.kill();
  await fs.rm(home, { recursive: true, force: true }).catch(() => {});
  const passed = checks.filter((c) => c.ok).length;
  const summary = { verdict: passed === checks.length ? 'PASS' : 'FAIL', passed, total: checks.length, checks, errors };
  await fs.writeFile(file('summary.json'), JSON.stringify(summary, null, 2));
  console.log(`\n${passed}/${checks.length} ${summary.verdict} · ${out}`);
  process.exitCode = summary.verdict === 'PASS' ? 0 : 1;
}
