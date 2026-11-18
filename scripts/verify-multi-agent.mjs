#!/usr/bin/env node
// Multi-agent collaboration on one live canvas: two hosts drive the real local
// server + built page through the public graph CLI at the same time.
// No model is called; answers are synthetic, so every outcome is deterministic.
import { chromium } from 'playwright-core';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'evidence', `multi-agent-${Date.now()}`);
const home = path.join(out, 'weft-home');
await fs.mkdir(home, { recursive: true });
const port = Number(process.env.BRIDGE_PORT ?? 3196);
const origin = `http://127.0.0.1:${port}`;
const checks = [], commands = [], errors = [];
let stage = 'setup', browser, server, page;
const file = (name) => path.join(out, name);
const save = (name, data) => fs.writeFile(file(name), typeof data === 'string' ? data : JSON.stringify(data, null, 2));
const load = async (p) => JSON.parse(await fs.readFile(p, 'utf8'));

async function check(name, ok, detail = {}) {
  checks.push({ name, ok: !!ok, stage, ...detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok && page) await page.screenshot({ path: file(`failure-${checks.length}.png`) }).catch(() => {});
}
/** Run the public CLI without blocking, so two hosts can be in flight at once. */
function cli(label, args) {
  return new Promise((resolve) => {
    const started = Date.now();
    const p = spawn(process.execPath, [path.join(root, 'cli/dist/weft.mjs'), 'graph', ...args], { cwd: out, env: { ...process.env, WEFT_HOME: home } });
    let stdout = '', stderr = '';
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('close', (status) => {
      const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };
      const entry = { label, args, status, stdout, stderr, started, ms: Date.now() - started };
      commands.push(entry);
      resolve({ ...entry, json: parse(stdout), error: parse(stderr)?.error });
    });
  });
}
async function inspect(label) {
  const r = await cli(label, ['canvas-inspect']);
  if (r.status !== 0) throw Error(`${label}: ${r.stderr}`);
  return r.json;
}
async function answer(host, target, text, runId) {
  const handoff = file(`${runId}.handoff.json`);
  const c = await cli(`${runId}-compile`, ['canvas-compile', '--target', target, '--host', host, '--out', handoff]);
  if (c.status !== 0) return { compile: c };
  await fs.writeFile(file(`${runId}.txt`), text);
  const r = await cli(`${runId}-result`, ['result', '--handoff', handoff, '--answer', file(`${runId}.txt`), '--host', host, '--run-id', runId, '--mode', 'current-session', '--out', file(`${runId}.host-result.json`)]);
  const a = await cli(`${runId}-apply`, ['canvas-apply', '--result', file(`${runId}.host-result.json`), '--request-id', `${runId}-apply`]);
  return { compile: c, result: r, apply: a, handoff: await load(handoff) };
}
const text = (h) => h.messages.map((m) => m.content).join('\n');
const node = (id, question, response, x, y) => ({ id, type: 'thought', position: { x, y }, data: {
  question, response, responses: response ? [response] : [], responseIndex: 0, isRoot: true, isBranch: false,
  isCollapsed: false, isEditing: false, isEditingResponse: false, isLoading: false, tokenCount: 0, highlights: [],
  highlightMode: 'off', attachments: [], excludedAttachmentIds: [], includedAttachmentIds: [], roleMode: 'inherit' } });

try {
  stage = 'server';
  server = spawn(process.execPath, ['server.mjs'], {
    cwd: root, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', SERVE_DIST: path.join(root, 'dist'), WEFT_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${origin}/api/canvas/status`)).ok) break; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 150));
  }

  stage = 'browser';
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1500, height: 950 }, locale: 'zh-CN' });
  context.setDefaultTimeout(15000);
  await context.addInitScript(() => { localStorage.setItem('weft.tutorialDone', '1'); localStorage.setItem('weft.lang', 'zh'); });
  page = await context.newPage();
  page.on('pageerror', (e) => errors.push({ stage, message: e.stack }));
  page.on('dialog', (d) => d.accept());
  await page.goto(origin);
  await page.getByTestId('host-handoff-open').click();
  await save('fixture.weft.json', { version: 1, name: '多 Agent 协作', nodes: [
    node('root', '为什么复盘写了，同样的事故还会再发生？', '常见原因：行动项没有负责人和截止时间。', 0, 0),
    node('evidence', '事故数据怎么说？', '10 起重复事故里有 7 起的行动项没有负责人。', 520, 0),
  ], edges: [] });
  await page.getByTestId('host-handoff-import-graph').setInputFiles(file('fixture.weft.json'));
  await page.getByRole('status').filter({ hasText: '已导入' }).waitFor();
  await page.getByTestId('canvas-bridge-toggle').check();
  await page.getByTestId('canvas-bridge-status').filter({ hasText: '已开启' }).waitFor();
  const s0 = await inspect('inspect-0');

  // 1. Both hosts read the same revision and write at the same moment.
  stage = 'race';
  await save('a-ops.json', [{ op: 'branch', source: 'root', id: 'a-fix', question: '如果只能改一件事，最该改什么？' }]);
  await save('b-ops.json', [{ op: 'branch', source: 'root', id: 'b-measure', question: '怎么衡量复盘有没有起作用？' }]);
  const [ra, rb] = await Promise.all([
    cli('codex-edit', ['canvas-edit', '--operations', file('a-ops.json'), '--request-id', 'codex-branch', '--expected-hash', s0.hash]),
    cli('claude-edit', ['canvas-edit', '--operations', file('b-ops.json'), '--request-id', 'claude-branch', '--expected-hash', s0.hash]),
  ]);
  const overlap = Math.min(ra.started + ra.ms, rb.started + rb.ms) > Math.max(ra.started, rb.started);
  const winners = [ra, rb].filter((r) => r.status === 0), losers = [ra, rb].filter((r) => r.status !== 0);
  await check('Two hosts editing from the same revision at once: exactly one wins, the other gets REVISION_CONFLICT',
    overlap && winners.length === 1 && losers[0]?.error?.code === 'REVISION_CONFLICT', { overlap, a: ra.error ?? 'ok', b: rb.error ?? 'ok' });
  const s1 = await inspect('inspect-1');
  const winnerNode = winners[0] === ra ? 'a-fix' : 'b-measure', loserNode = winners[0] === ra ? 'b-measure' : 'a-fix';
  await check('The losing edit left no partial trace on the canvas', s1.nodes.some((n) => n.id === winnerNode) && !s1.nodes.some((n) => n.id === loserNode));
  const loser = losers[0] === ra ? ['codex-edit-retry', 'a-ops.json', 'codex-branch'] : ['claude-edit-retry', 'b-ops.json', 'claude-branch'];
  const retry = await cli(loser[0], ['canvas-edit', '--operations', file(loser[1]), '--request-id', loser[2], '--expected-hash', s1.hash]);
  const s2 = await inspect('inspect-2');
  await check('After re-reading, the loser retries with the same request ID and lands', retry.status === 0 && ['a-fix', 'b-measure'].every((id) => s2.nodes.some((n) => n.id === id)), { error: retry.error });

  // 2. Without a revision guard, simultaneous writes are serialised, not lost.
  stage = 'serial';
  await save('a-note.json', [{ op: 'reference', source: 'evidence', target: 'a-fix', id: 'ev-a' }]);
  await save('b-note.json', [{ op: 'reference', source: 'evidence', target: 'b-measure', id: 'ev-b' }]);
  const [na, nb] = await Promise.all([
    cli('codex-ref', ['canvas-edit', '--operations', file('a-note.json'), '--request-id', 'codex-ref']),
    cli('claude-ref', ['canvas-edit', '--operations', file('b-note.json'), '--request-id', 'claude-ref']),
  ]);
  const s3 = await inspect('inspect-3');
  await check('Unguarded simultaneous edits are applied one after another; neither is lost',
    na.status === 0 && nb.status === 0 && ['ev-a', 'ev-b'].every((id) => s3.edges.some((e) => e.id === id)) && na.json.afterHash !== nb.json.afterHash);

  // 3. Each host sees only what is wired into its own node.
  stage = 'blind';
  const [aa, ab] = await Promise.all([
    answer('codex', 'a-fix', '给每个行动项指定唯一负责人和截止时间。', 'codex-run-1'),
    answer('claude-code', 'b-measure', '看重复事故率和行动项按期关闭率。', 'claude-run-1'),
  ]);
  await check('Both hosts compile and write back in parallel', aa.apply?.status === 0 && ab.apply?.status === 0, { a: aa.apply?.stderr, b: ab.apply?.stderr });
  await check('Shared upstream reaches both: the root answer and the wired evidence are in each context',
    [aa, ab].every((r) => text(r.handoff).includes('行动项没有负责人和截止时间') && text(r.handoff).includes('7 起')));
  await check('Sibling branches stay blind: neither context contains the other host\'s question',
    !text(aa.handoff).includes('怎么衡量') && !text(ab.handoff).includes('如果只能改一件事'));

  // 4. One host builds on the other's answer.
  stage = 'build-on';
  const s4 = await inspect('inspect-4');
  await save('b-plan.json', [
    { op: 'add-node', id: 'b-plan', question: '按这个改法，下周具体怎么落地？' },
    { op: 'connect', source: 'a-fix', target: 'b-plan', id: 'a-fix-plan' },
  ]);
  const plan = await cli('claude-plan', ['canvas-edit', '--operations', file('b-plan.json'), '--request-id', 'claude-plan', '--expected-hash', s4.hash]);
  const ap = await answer('claude-code', 'b-plan', '周一过一遍未关闭的行动项，没有负责人的当场指定。', 'claude-run-2');
  await check('A host can continue from another host\'s answer: its context carries that answer',
    plan.status === 0 && ap.apply?.status === 0 && text(ap.handoff).includes('唯一负责人和截止时间'));

  // 5. When the upstream host revises, the downstream host's answer goes stale.
  stage = 'stale';
  const pendingHandoff = file('claude-pending.handoff.json');
  await cli('claude-pending-compile', ['canvas-compile', '--target', 'b-plan', '--host', 'claude-code', '--out', pendingHandoff]);
  await fs.writeFile(file('claude-pending.txt'), '基于旧结论的落地方案。');
  await cli('claude-pending-result', ['result', '--handoff', pendingHandoff, '--answer', file('claude-pending.txt'), '--host', 'claude-code', '--run-id', 'claude-pending', '--mode', 'current-session', '--out', file('claude-pending.host-result.json')]);
  const rev = await answer('codex', 'a-fix', '先让行动项进入迭代排期，和需求同等优先级。', 'codex-run-2');
  const late = await cli('claude-pending-apply', ['canvas-apply', '--result', file('claude-pending.host-result.json'), '--request-id', 'claude-pending-apply']);
  await check('An answer written against an upstream that changed meanwhile is still refused (STALE_RESULT)', late.error?.code === 'STALE_RESULT', { error: late.error });
  await page.waitForTimeout(800);
  const s5 = await inspect('inspect-5');
  const aNode = s5.nodes.find((n) => n.id === 'a-fix');
  await check('The upstream host appends a new answer version instead of overwriting', rev.apply?.status === 0 && aNode?.versions === 2);
  await check('The other host\'s downstream answer is flagged stale and queued for recompute',
    s5.status.stale.includes('b-plan') && s5.status.plan.includes('b-plan') && !s5.status.stale.includes('b-measure'), { status: s5.status });
  const badge = await page.locator('.react-flow__node[data-id="b-plan"]').getByText('上游已变').count();
  await check('The canvas shows that stale mark on the node', badge > 0);
  const blocked = await cli('claude-blocked', ['canvas-compile', '--target', 'b-plan', '--host', 'claude-code', '--out', file('blocked.handoff.json')]);
  const rerun = await answer('claude-code', 'b-plan', '下周一起，行动项和需求一起排期，周会只看排期内的完成率。', 'claude-run-3');
  await check('Recompiling the stale node now carries the revised upstream answer', rerun.apply?.status === 0 && text(rerun.handoff).includes('和需求同等优先级') && !text(rerun.handoff).includes('唯一负责人和截止时间'), { blocked: blocked.error ?? 'ok' });
  const s6 = await inspect('inspect-6');
  await check('After the recompute nothing is stale', s6.status.stale.length === 0, { status: s6.status });

  // 6. Who did what is recorded per node.
  stage = 'receipts';
  await page.waitForTimeout(1500);
  const receipts = await page.evaluate(async () => {
    const req = indexedDB.open('keyval-store');
    const db = await new Promise((r) => { req.onsuccess = () => r(req.result); });
    const tx = db.transaction('keyval').objectStore('keyval');
    const keys = await new Promise((r) => { const q = tx.getAllKeys(); q.onsuccess = () => r(q.result); });
    const out = {};
    for (const k of keys) {
      const v = await new Promise((r) => { const q = tx.get(k); q.onsuccess = () => r(q.result); });
      const s = typeof v === 'string' ? v : JSON.stringify(v);
      if (!s.includes('hostReceipts')) continue;
      const nodes = (JSON.parse(typeof v === 'string' ? v : JSON.stringify(v)).state ?? JSON.parse(s)).nodes ?? [];
      for (const n of nodes) if (n.data?.hostReceipts?.length) out[n.id] = n.data.hostReceipts.map((r) => `${r.host}:${r.runId}`);
    }
    return out;
  });
  await save('receipts.json', receipts);
  await check('Receipts name the host and run behind every answer version',
    JSON.stringify(receipts['a-fix']) === JSON.stringify(['codex:codex-run-1', 'codex:codex-run-2'])
      && receipts['b-measure']?.[0] === 'claude-code:claude-run-1'
      && JSON.stringify(receipts['b-plan']) === JSON.stringify(['claude-code:claude-run-2', 'claude-code:claude-run-3']), { receipts });
  await page.getByTestId('host-handoff-open').click().catch(() => {});
  await page.locator('.react-flow__controls-fitview').click().catch(() => {});
  await page.waitForTimeout(500);
  await page.screenshot({ path: file('final.png') });
  await check('No page errors', errors.length === 0, { errors });
} catch (err) {
  await check(`Unexpected failure: ${err instanceof Error ? err.message : String(err)}`, false);
} finally {
  await browser?.close().catch(() => {});
  server?.kill();
  const passed = checks.filter((c) => c.ok).length;
  const summary = { verdict: passed === checks.length ? 'PASS' : 'FAIL', passed, failed: checks.length - passed, model: 'none (synthetic answers)', checks, commands };
  await save('summary.json', summary);
  console.log(`${summary.verdict} ${passed}/${checks.length} → ${path.relative(root, out)}`);
  process.exitCode = summary.verdict === 'PASS' ? 0 : 1;
}
