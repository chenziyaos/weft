#!/usr/bin/env node
// Live canvas bridge acceptance: the real local server serving the built dist,
// a real browser page with the bridge turned on, and the public graph CLI.
// No model is called; the answer written back is synthetic.
import { chromium } from 'playwright-core';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'evidence', `canvas-bridge-${Date.now()}`);
const home = path.join(out, 'weft-home');
await fs.mkdir(home, { recursive: true });
const port = Number(process.env.BRIDGE_PORT ?? 3197);
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
function cli(label, args) {
  const r = spawnSync(process.execPath, [path.join(root, 'cli/dist/weft.mjs'), 'graph', ...args], {
    cwd: out, env: { ...process.env, WEFT_HOME: home }, encoding: 'utf8', timeout: 40000,
  });
  const entry = { label, args, status: r.status, stdout: r.stdout, stderr: r.stderr };
  commands.push(entry);
  const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };
  return { ...entry, json: parse(r.stdout), error: parse(r.stderr)?.error };
}
async function inspect(label) {
  const r = cli(label, ['canvas-inspect']);
  if (r.status !== 0) throw Error(`${label}: ${r.stderr}`);
  return r.json;
}
async function overlaps() {
  return page.evaluate(() => {
    const rects = [...document.querySelectorAll('.react-flow__node')].map((el) => ({ id: el.getAttribute('data-id'), r: el.getBoundingClientRect() }));
    const hits = [];
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i].r, b = rects[j].r;
      if (a.left < b.right - 2 && b.left < a.right - 2 && a.top < b.bottom - 2 && b.top < a.bottom - 2) hits.push([rects[i].id, rects[j].id]);
    }
    return hits;
  });
}
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
  let serverLog = '';
  server.stdout.on('data', (d) => { serverLog += d; });
  server.stderr.on('data', (d) => { serverLog += d; });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${origin}/api/canvas/status`)).ok) break; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  const tokenStat = await fs.stat(path.join(home, 'canvas-bridge.json'));
  await check('Server writes the bridge token file owner-only (0600)', (tokenStat.mode & 0o777) === 0o600, { mode: (tokenStat.mode & 0o777).toString(8) });

  stage = 'no-canvas';
  const none = cli('inspect-before-bridge', ['canvas-inspect']);
  await check('Without an opted-in canvas the CLI is refused with NO_CANVAS', none.status === 1 && none.error?.code === 'NO_CANVAS', { error: none.error });
  const wrong = await fetch(`${origin}/api/canvas/request`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer nope' }, body: JSON.stringify({ kind: 'inspect' }) });
  await check('A request without the token is rejected (401)', wrong.status === 401);
  const foreign = await fetch(`${origin}/api/canvas/reply`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } });
  await check('A foreign web origin gets no CORS grant for the page endpoints', !foreign.headers.get('access-control-allow-origin'));

  stage = 'browser';
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1500, height: 950 }, locale: 'en-US' });
  context.setDefaultTimeout(15000);
  await context.addInitScript(() => { localStorage.setItem('weft.tutorialDone', '1'); });
  page = await context.newPage();
  page.on('pageerror', (e) => errors.push({ stage, message: e.stack }));
  page.on('dialog', (d) => d.accept());
  await page.goto(origin);
  await page.getByTestId('host-handoff-open').click();
  const graph = { version: 1, name: 'Bridge fixture', nodes: [
    node('root', 'Why do postmortems fail to prevent repeats?', 'Action items lack owners and deadlines.', 0, 0),
    node('evidence', 'What does the incident data say?', '7 of 10 repeats had an unowned action item.', 520, 0),
  ], edges: [] };
  await save('fixture.weft.json', graph);
  await page.getByTestId('host-handoff-import-graph').setInputFiles(file('fixture.weft.json'));
  await page.getByRole('status').filter({ hasText: '已导入' }).waitFor();

  stage = 'bridge-on';
  await page.getByTestId('canvas-bridge-toggle').check();
  await page.getByTestId('canvas-bridge-status').filter({ hasText: '已开启' }).waitFor();
  await check('Turning the bridge on shows it as live (status and launcher dot)', await page.getByTestId('canvas-bridge-dot').isVisible());
  const s0 = await inspect('inspect-0');
  await save('inspect-0.json', s0);
  await check('canvas-inspect reads the open canvas: 2 nodes, a project ID and a graph hash',
    s0.nodes.length === 2 && /^sha256:/.test(s0.hash) && !!s0.projectId, { nodes: s0.nodes.length });

  stage = 'edit';
  const ops = [
    { op: 'branch', source: 'root', id: 'review', question: 'If we fix one thing, what should it be?', quote: 'Action items lack owners' },
    { op: 'reference', source: 'evidence', target: 'review', id: 'evidence-review' },
  ];
  await save('ops-1.json', ops);
  const e1 = cli('edit-1', ['canvas-edit', '--operations', file('ops-1.json'), '--request-id', 'bridge-edit-1', '--expected-hash', s0.hash]);
  await check('canvas-edit applies a branch and a reference to the live canvas', e1.status === 0 && e1.json?.counts?.branch === 1 && e1.json?.counts?.reference === 1, { stdout: e1.stdout, stderr: e1.stderr });
  await page.locator('.react-flow__node[data-id="review"]').waitFor();
  await check('The new node appears on the canvas without a reload', await page.locator('.react-flow__node[data-id="review"]').count() === 1);
  const s1 = await inspect('inspect-1');
  await save('inspect-1.json', s1);
  const kinds = Object.fromEntries(s1.edges.map((e) => [e.id, e.kind]));
  await check('The canvas holds the edges the operations describe (solid branch, dashed reference)',
    kinds['branch:review'] === 'branch' && kinds['evidence-review'] === 'reference', { kinds });
  await check('The reported afterHash is the canvas hash afterwards', e1.json?.afterHash === s1.hash && e1.json?.beforeHash === s0.hash);
  await page.waitForTimeout(400);
  const o1 = await overlaps();
  await check('Agent-added nodes are laid out by the arrows without overlapping cards', o1.length === 0, { overlaps: o1 });
  await check('The edit is listed in the panel activity', (await page.getByTestId('canvas-bridge-activity').innerText()).includes('edit'));

  stage = 'idempotency';
  const retry = cli('edit-1-retry', ['canvas-edit', '--operations', file('ops-1.json'), '--request-id', 'bridge-edit-1', '--expected-hash', s0.hash]);
  const s1b = await inspect('inspect-1b');
  await check('Retrying a request ID with the same payload replays the reply and changes nothing', retry.status === 0 && retry.json?.afterHash === e1.json?.afterHash && s1b.hash === s1.hash);
  await save('ops-2.json', [{ op: 'move-node', id: 'review', x: 10, y: 400 }]);
  const conflictId = cli('edit-1-other-payload', ['canvas-edit', '--operations', file('ops-2.json'), '--request-id', 'bridge-edit-1']);
  await check('Reusing a request ID for a different payload is IDEMPOTENCY_CONFLICT', conflictId.error?.code === 'IDEMPOTENCY_CONFLICT', { error: conflictId.error });
  const staleHash = cli('edit-stale-hash', ['canvas-edit', '--operations', file('ops-2.json'), '--request-id', 'bridge-edit-2', '--expected-hash', s0.hash]);
  await check('An edit based on an older hash is REVISION_CONFLICT', staleHash.error?.code === 'REVISION_CONFLICT', { error: staleHash.error });
  await save('ops-bad.json', [{ op: 'connect', source: 'root', target: 'review', id: 'x', style: 'red' }]);
  const bad = cli('edit-invalid', ['canvas-edit', '--operations', file('ops-bad.json'), '--request-id', 'bridge-edit-3']);
  const s1c = await inspect('inspect-1c');
  await check('An invalid operation is rejected by the workspace validator and changes nothing', bad.error?.code === 'UNKNOWN_FIELD' && s1c.hash === s1.hash, { error: bad.error });

  stage = 'undo';
  await save('ops-archive.json', [{ op: 'archive-node', id: 'evidence', archived: true }]);
  const arch = cli('edit-archive', ['canvas-edit', '--operations', file('ops-archive.json'), '--request-id', 'bridge-archive', '--expected-hash', s1.hash]);
  const s2 = await inspect('inspect-2');
  await check('Archiving through the bridge takes effect', arch.status === 0 && s2.nodes.find((n) => n.id === 'evidence')?.archived === true);
  await page.getByRole('button', { name: 'Undo', exact: true }).last().click();
  await page.waitForTimeout(300);
  const s3 = await inspect('inspect-3');
  // The event log is append-only, so the graph hash moves on even after an undo.
  await check('The toast Undo reverts an agent edit like any canvas edit', s3.nodes.find((n) => n.id === 'evidence')?.archived === false && s3.hash !== s2.hash, { hash: s3.hash });

  stage = 'compile-answer';
  const handoffPath = file('review.handoff.json');
  const comp = cli('compile', ['canvas-compile', '--target', 'review', '--host', 'claude-code', '--out', handoffPath]);
  const handoff = comp.status === 0 ? await load(handoffPath) : null;
  const joined = handoff ? handoff.messages.map((m) => m.content).join('\n') : '';
  await check('canvas-compile writes the handoff for the live target: quote, reference and question in context',
    !!handoff && joined.includes('7 of 10 repeats') && handoff.messages.some((m) => m.role === 'user' && m.content === 'If we fix one thing, what should it be?')
      && handoff.messages.at(-1).content.includes('Action items lack owners'),
    { stderr: comp.stderr });
  await fs.writeFile(file('answer.txt'), 'Give every action item one named owner and a date; review open items weekly.\n');
  const res = cli('result', ['result', '--handoff', handoffPath, '--answer', file('answer.txt'), '--host', 'claude-code', '--run-id', 'bridge-synthetic-01', '--mode', 'current-session', '--out', file('review.host-result.json')]);
  const ap = cli('apply', ['canvas-apply', '--result', file('review.host-result.json'), '--request-id', 'bridge-answer-1']);
  await check('canvas-apply writes the answer back as a version with a host receipt', res.status === 0 && ap.status === 0 && ap.json?.responseIndex === 0 && ap.json?.receipt?.resultId, { stderr: ap.stderr });
  await page.locator('.react-flow__node[data-id="review"]').getByText('one named owner').first().waitFor();
  await check('The written answer is visible on the canvas node', true);
  const s4 = await inspect('inspect-4');
  await check('The answered node now has one version and appears under replay', s4.nodes.find((n) => n.id === 'review')?.versions === 1 && s4.status.replay.includes('review'));
  const again = cli('apply-replay', ['canvas-apply', '--result', file('review.host-result.json'), '--request-id', 'bridge-answer-2']);
  await check('Applying the same result again is refused (REPLAY)', again.error?.code === 'REPLAY', { error: again.error });

  stage = 'persist';
  await page.waitForTimeout(1500);
  await page.reload();
  await page.getByTestId('host-handoff-open').click();
  const offAfterReload = cli('inspect-after-reload', ['canvas-inspect']);
  await check('A reload turns the bridge off until it is enabled again', offAfterReload.error?.code === 'NO_CANVAS');
  await page.getByTestId('canvas-bridge-toggle').check();
  await page.getByTestId('canvas-bridge-status').filter({ hasText: '已开启' }).waitFor();
  const s5 = await inspect('inspect-5');
  await check('Agent edits and the written answer persist across a reload', s5.nodes.length === 3 && s5.nodes.find((n) => n.id === 'review')?.versions === 1);

  stage = 'off';
  await page.getByTestId('canvas-bridge-toggle').uncheck();
  await page.waitForTimeout(300);
  const off = cli('inspect-off', ['canvas-inspect']);
  await check('Turning the bridge off refuses further agent requests', off.error?.code === 'NO_CANVAS');
  await page.screenshot({ path: file('final.png') });
  await check('No page errors', errors.length === 0, { errors });
  await save('server.log', serverLog);
} catch (err) {
  await check(`Unexpected failure: ${err instanceof Error ? err.message : String(err)}`, false);
} finally {
  await browser?.close().catch(() => {});
  server?.kill();
  const passed = checks.filter((c) => c.ok).length;
  const summary = { verdict: passed === checks.length ? 'PASS' : 'FAIL', passed, failed: checks.length - passed, model: 'none (synthetic answer)', checks, commands, errors };
  await save('summary.json', summary);
  console.log(`${summary.verdict} ${passed}/${checks.length} → ${path.relative(root, out)}`);
  process.exitCode = summary.verdict === 'PASS' ? 0 : 1;
}
