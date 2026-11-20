// Real end-to-end user journey against live models (whatever the proxy has configured).
// Prereq: `npm run server` (:3001, at least three models via .env) and `npm run dev` (:5173),
// local Chrome, and Codex signed in for the agent step.
// E2E_COMPARE: comma-separated model ids for the comparison step (default: the first three offered).
// E2E_AGENT_MODEL: a substring of the Codex model to pick (default: the first one listed).
// Usage: node scripts/e2e-user-journey.mjs [outDir]
// Writes screenshots, downloads and metrics.json (per-step timing + node data) to outDir.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const APP = process.env.APP_URL ?? 'http://localhost:5173';
const API = process.env.API_URL ?? 'http://localhost:3001';
const OUT = path.resolve(process.argv[2] ?? `evidence/weft-user-journey-${Date.now()}`);
const COMPARE_MODELS = (process.env.E2E_COMPARE ?? '').split(',').filter(Boolean);
const AGENT_MODEL = process.env.E2E_AGENT_MODEL ?? '';
fs.mkdirSync(OUT, { recursive: true });

const metrics = { startedAt: new Date().toISOString(), app: APP, steps: [], errors: [] };
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', deviceScaleFactor: 2, acceptDownloads: true });
await ctx.addInitScript(() => {
  localStorage.setItem('weft.tutorialDone', '1');
  localStorage.setItem('weft.seeded', 'yes');
  localStorage.setItem('weft.lang', 'zh');
});
const page = await ctx.newPage();
page.on('pageerror', (e) => metrics.errors.push('pageerror: ' + e.message));

const shot = (name, target = page) => target.screenshot({ path: path.join(OUT, `${name}.png`) });
const nodes = () => page.evaluate(() => window.__store.getState().nodes.map((n) => ({
  id: n.id, kind: n.data.stepKind ?? 'thought', question: n.data.question, model: n.data.model ?? null,
  loading: !!n.data.isLoading, failed: !!n.data.generationFailed, chars: n.data.response.length, tokens: n.data.tokenCount,
  reasoning: !!(n.data.reasoning || n.data.reasonings?.some?.(Boolean)),
  agent: n.data.agentSession ? { runtime: n.data.agentSession.runtime, cwd: n.data.agentSession.cwd, changes: n.data.agentSession.changes ?? null } : null,
  createdAt: n.data.createdAt ?? null, generatedAt: n.data.lastGeneratedAt ?? null,
})));
const edges = () => page.evaluate(() => window.__store.getState().edges.map((e) => ({ source: e.source, target: e.target, cross: !!e.data?.isCrossLink })));

/** Wait until at least `count` nodes exist and none is generating; record when each new node finished. */
async function settle(count, timeoutMs, t0 = Date.now()) {
  const doneAt = {};
  while (Date.now() - t0 < timeoutMs) {
    const ns = await nodes();
    for (const n of ns) if (!n.loading && (n.chars > 0 || n.failed) && !(n.id in doneAt)) doneAt[n.id] = Date.now() - t0;
    if (ns.length >= count && ns.every((n) => !n.loading)) return { ns, doneAt, ms: Date.now() - t0 };
    await page.waitForTimeout(1000);
  }
  throw new Error(`timed out after ${timeoutMs / 1000}s waiting for ${count} settled nodes`);
}

async function step(name, fn) {
  const t0 = Date.now();
  const rec = { name, ok: false, ms: 0 };
  try { Object.assign(rec, await fn()); rec.ok = true; } catch (e) { rec.error = e.message.split('\n')[0]; await shot(`fail-${name}`).catch(() => {}); }
  rec.ms = Date.now() - t0;
  metrics.steps.push(rec);
  console.log(`${rec.ok ? 'PASS' : 'FAIL'} ${name} ${(rec.ms / 1000).toFixed(1)}s${rec.error ? ' — ' + rec.error : ''}`);
  return rec;
}

const closePanel = async () => {
  const x = page.locator('button[title="关闭面板"]');
  if (await x.count()) { await x.first().click(); await page.waitForTimeout(400); }
};
// the detail panel: the nearest ancestor of its close button that also holds the follow-up box
// (expanded cards on the canvas carry follow-up boxes of their own)
const panel = () => page.locator('button[title="关闭面板"]').locator('xpath=ancestor::*[.//textarea[@placeholder="继续追问…"]][1]');
const followBox = () => panel().locator('textarea[placeholder="继续追问…"]');
/** Open a node's detail panel by double-clicking its card, located by exact question. */
async function openPanel(question) {
  await page.keyboard.press('Escape');
  await closePanel();
  const id = await page.evaluate((q) => window.__store.getState().nodes.find((n) => n.data.question === q || n.data.question.startsWith(q))?.id, question);
  if (!id) throw new Error('no node for ' + question.slice(0, 20));
  // bring the card on screen first (the dev build exposes the React Flow instance)
  await page.evaluate((nid) => window.__rf?.fitView({ nodes: [{ id: nid }], maxZoom: 1, duration: 0 }), id);
  await page.waitForTimeout(500);
  const card = page.locator(`.react-flow__node[data-id="${id}"]`);
  for (let i = 0; i < 2; i++) {
    await card.dblclick({ position: { x: 120, y: 16 }, timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(700);
    if ((await page.evaluate(() => window.__store.getState().selectedNodeId)) === id && (await followBox().count())) break;
  }
  if ((await page.evaluate(() => window.__store.getState().selectedNodeId)) !== id) throw new Error('double-click did not open the panel on ' + question.slice(0, 20));
  await followBox().waitFor({ timeout: 5000 });
  return id;
}
async function willSend() {
  const el = panel().getByText(/将发送 ~\d+ tok/).first();
  return (await el.count()) ? (await el.textContent()).trim() : null;
}
async function followUp(text, expectCount, timeoutMs = 180000) {
  const box = followBox();
  await box.fill(text);
  const t0 = Date.now();
  await box.press('Enter');
  return settle(expectCount, timeoutMs, t0);
}
async function autoLayout() {
  await closePanel();
  await page.locator('button[title="更多操作"]').first().click();
  await page.getByRole('button', { name: /一键排版/ }).first().click();
  await page.waitForTimeout(400);
  const confirm = page.getByRole('button', { name: '一键排版', exact: true });
  if (await confirm.count()) await confirm.last().click();
  await page.waitForTimeout(1200);
}
// padding keeps cards clear of the floating toolbars at the canvas edges
const fitView = async () => {
  await page.mouse.move(5, 450);
  await page.evaluate(() => window.__rf?.fitView({ padding: 0.18, duration: 0 }));
  await page.waitForTimeout(700);
};

const Q1 = '为什么很多团队写了复盘文档，同样的事故还是一再发生？';
const QA = '如果只能改一件事，最该先改什么？给出可落地的做法。';
const QB = '换个角度：怎么衡量复盘到底有没有起作用？';
const QM = '用三句话回答：复盘的行动项为什么总是落不了地？';
const QAgent = '在当前工作目录创建文件 weft-e2e.md，写入一个三行的复盘行动项清单（Markdown 列表），然后用一句话告诉我文件的完整路径。';

await step('01-landing', async () => {
  await page.goto(APP, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  await shot('01-landing');
  const status = await (await fetch(`${API}/api/models`)).json();
  return { models: (status.models ?? []).length };
});

await step('02-model-settings', async () => {
  await page.locator('button[title="模型：对新的生成生效"]').first().click();
  await page.locator('[data-picker-apikey]').click();
  await page.locator('[data-provider-add]').waitFor({ timeout: 5000 });
  await page.waitForTimeout(800);
  await shot('02-model-settings');
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await page.waitForTimeout(300);
  return {};
});

await step('03-model-picker', async () => {
  await page.locator('button[title="模型：对新的生成生效"]').first().click();
  await page.waitForTimeout(1500);
  await shot('03-model-picker');
  const groups = await page.locator('[data-runtime-group]').evaluateAll((els) => els.map((e) => e.getAttribute('data-runtime-group')));
  await page.locator('button[title="模型：对新的生成生效"]').first().click();
  await page.waitForTimeout(300);
  return { agentRuntimes: groups };
});

await step('04-first-question', async () => {
  const box = page.getByPlaceholder('你想探索什么？');
  await box.fill(Q1);
  const t0 = Date.now();
  await box.press('Enter');
  const r = await settle(1, 180000, t0);
  await page.waitForTimeout(500);
  await shot('04-first-answer');
  return { latencyMs: r.ms, node: r.ns[0] };
});

await step('05-focus-panel', async () => {
  await openPanel(Q1);
  await page.waitForTimeout(800);
  await shot('05-focus-panel');
  return { willSend: await willSend() };
});

await step('06-follow-up', async () => {
  const r = await followUp(QA, 2);
  await page.waitForTimeout(500);
  await shot('06-follow-up');
  const child = r.ns.find((n) => n.question === QA);
  await openPanel(QA);
  const preview = await willSend();
  await panel().locator('[title="预览将要发送的确切上下文"]').first().click({ timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(500);
  await shot('06b-chain-context');
  return { latencyMs: r.ms, node: child, nextTurnWillSend: preview };
});

await step('07-branch', async () => {
  await openPanel(Q1);
  const before = await willSend();
  const r = await followUp(QB, 3);
  const child = r.ns.find((n) => n.question === QB);
  await openPanel(QB);
  const after = await willSend();
  await closePanel();
  await fitView();
  await shot('07-branch-canvas');
  return { latencyMs: r.ms, node: child, branchContextFromRoot: before, nextTurnOnBranchWillSend: after };
});

await step('07b-cut-wire', async () => {
  const ids = await page.evaluate(([a, b]) => {
    const ns = window.__store.getState().nodes;
    const src = ns.find((n) => n.data.question === a)?.id, dst = ns.find((n) => n.data.question === b)?.id;
    return { edge: window.__store.getState().edges.find((e) => e.source === src && e.target === dst)?.id, dst };
  }, [Q1, QB]);
  if (!ids.edge) throw new Error('no edge from the first question to the branch');
  await openPanel(QB);
  const before = await willSend();
  await closePanel();
  await fitView();
  // a curved edge's bounding-box centre is usually off the path; click the path's own midpoint
  const mid = await page.evaluate((id) => {
    const p = document.querySelector(`.react-flow__edge[data-id="${id}"] path.react-flow__edge-interaction`)
      ?? document.querySelector(`.react-flow__edge[data-id="${id}"] path`);
    const pt = p.getPointAtLength(p.getTotalLength() / 2).matrixTransform(p.getScreenCTM());
    return { x: pt.x, y: pt.y };
  }, ids.edge);
  await page.mouse.click(mid.x, mid.y);
  await page.waitForTimeout(300);
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(500);
  const gone = await page.evaluate((id) => !window.__store.getState().edges.some((e) => e.id === id), ids.edge);
  if (!gone) throw new Error('edge was not deleted');
  await page.mouse.click(5, 450);
  await fitView();
  await shot('07c-cut-canvas');
  await openPanel(QB);
  const after = await willSend();
  await shot('07b-cut-wire');
  await closePanel();
  await page.keyboard.press('Meta+z');
  await page.waitForTimeout(300);
  await page.mouse.click(5, 450);
  await page.evaluate(() => window.__store.setState((st) => ({ edges: st.edges.map((e) => (e.selected ? { ...e, selected: false } : e)) })));
  await page.waitForTimeout(600);
  const restored = await page.evaluate((id) => window.__store.getState().edges.some((e) => e.id === id), ids.edge);
  if (!restored) throw new Error('undo did not restore the edge');
  return { willSendBefore: before, willSendAfterCut: after, restoredByUndo: restored };
});

await step('08-auto-layout', async () => {
  await autoLayout();
  await fitView();
  await shot('08-auto-layout');
  return {};
});

await step('09-multi-model', async () => {
  await openPanel(Q1);
  await page.locator('button[title="更多操作"]').last().click();
  await page.getByRole('button', { name: /添加视角/ }).first().click();
  await page.getByRole('button', { name: /多模型对照/ }).click();
  await page.locator('.fixed.inset-0 textarea').first().fill(QM);
  const chips = page.locator('[data-fanout-models] button');
  const available = await chips.allInnerTexts();
  const picked = COMPARE_MODELS.length ? COMPARE_MODELS.filter((m) => available.includes(m)) : available.slice(0, 3);
  for (const id of picked) await chips.filter({ hasText: new RegExp(`^${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }).click();
  await shot('09-multi-model-dialog');
  const prev = (await nodes()).length;
  const t0 = Date.now();
  await page.locator('[data-fanout-run]').click();
  const r = await settle(prev + picked.length + 1, 300000, t0);
  const fresh = r.ns.slice(prev);
  const perModel = fresh.map((n) => ({ model: n.model, chars: n.chars, tokens: n.tokens, doneMs: r.doneAt[n.id] ?? null, failed: n.failed, synthesis: n.question !== QM }));
  await autoLayout();
  await fitView();
  await shot('09b-multi-model-canvas');
  const synth = fresh.find((n) => n.question !== QM);
  if (synth) { await openPanel(synth.question.slice(0, 30)); await page.waitForTimeout(600); await shot('09c-synthesis-panel'); }
  const es = await edges();
  return { picked, totalMs: r.ms, perModel, synthesisInEdges: synth ? es.filter((e) => e.target === synth.id).length : 0 };
});

await step('10-agent-codex', async () => {
  await closePanel();
  await page.locator('button[title="模型：对新的生成生效"]').first().click();
  await page.locator('[data-runtime-toggle="Codex"]').click();
  const entries = page.locator('[data-runtime-group="Codex"] button[title]');
  const titles = await entries.evaluateAll((els) => els.map((e) => e.getAttribute('title')));
  const want = (AGENT_MODEL && titles.find((tt) => tt.toLowerCase().includes(AGENT_MODEL.toLowerCase()))) || titles[0];
  if (!want) throw new Error('no Codex entry in picker');
  await page.locator(`[data-runtime-group="Codex"] button[title=${JSON.stringify(want)}]`).first().click();
  await page.waitForTimeout(400);
  if (await page.locator('[data-agent-effort-ok]').count()) await page.locator('[data-agent-effort-ok]').click();
  await page.waitForTimeout(400);
  await shot('10-agent-picked');
  const cwdChip = await page.locator('[data-agent-cwd]').count() ? (await page.locator('[data-agent-cwd]').innerText()).trim() : null;
  await openPanel(QA);
  const prev = (await nodes()).length;
  const r = await followUp(QAgent, prev + 1, 300000);
  const node = r.ns.find((n) => n.question === QAgent);
  await page.waitForTimeout(800);
  await shot('10b-agent-answer');
  await closePanel();
  await fitView();
  await shot('10c-canvas-with-agent');
  const file = node?.agent?.cwd ? path.join(node.agent.cwd, 'weft-e2e.md') : null;
  const fileContent = file && fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  return { pickerEntry: want, cwdChip, latencyMs: r.ms, node, fileWritten: !!fileContent, fileContent };
});

await step('11-export', async () => {
  await closePanel();
  // back to the gateway's default model for later sessions
  await page.evaluate(() => localStorage.removeItem('weft.model'));
  await page.locator('button[title="更多操作"]').first().click();
  await page.waitForTimeout(300);
  await shot('11-more-menu');
  const [vault] = await Promise.all([page.waitForEvent('download'), page.locator('[data-menu-export-vault]').click()]);
  await vault.saveAs(path.join(OUT, 'canvas.vault.zip'));
  await page.locator('button[title="更多操作"]').first().click();
  const [backup] = await Promise.all([page.waitForEvent('download'), page.locator('[data-menu-export]').click()]);
  await backup.saveAs(path.join(OUT, 'canvas.weft.json'));
  return { vault: vault.suggestedFilename(), backup: backup.suggestedFilename(), vaultBytes: fs.statSync(path.join(OUT, 'canvas.vault.zip')).size, backupBytes: fs.statSync(path.join(OUT, 'canvas.weft.json')).size };
});

await step('12-reload-persists', async () => {
  const before = (await nodes()).length;
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);
  const after = (await nodes()).length;
  await fitView();
  await shot('12-after-reload');
  if (after !== before) throw new Error(`nodes ${before} → ${after}`);
  return { nodes: after };
});

metrics.finishedAt = new Date().toISOString();
metrics.finalNodes = await nodes().catch(() => []);
metrics.finalEdges = await edges().catch(() => []);
metrics.pass = metrics.steps.every((s) => s.ok) && metrics.errors.length === 0;
fs.writeFileSync(path.join(OUT, 'metrics.json'), JSON.stringify(metrics, null, 2));
console.log(metrics.pass ? 'JOURNEY PASS' : 'JOURNEY FAIL', OUT);
await browser.close();
process.exit(metrics.pass ? 0 : 1);
