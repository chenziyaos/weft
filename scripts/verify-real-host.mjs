#!/usr/bin/env node
// Real-host acceptance for the live canvas bridge. A browser page opens the
// canvas with the bridge on; the Weft Skill is installed into a fresh project;
// Claude Code and Codex (each on its own login) each get a plain
// request in that project, without commands, and must find the Skill, edit
// the open canvas, read the compiled context, answer and write the answer back.
// Usage: node scripts/verify-real-host.mjs [claude] [codex]
// Models: WEFT_E2E_CLAUDE_MODEL (default sonnet), WEFT_E2E_CODEX_MODEL (default: the CLI's own).
import { chromium } from 'playwright-core';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argHosts = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const hosts = argHosts.length ? argHosts : ['claude', 'codex'];
// --parallel: every host works on the same live canvas at the same time.
const parallel = process.argv.includes('--parallel');
const out = path.join(root, 'evidence', `real-host-${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`);
const home = path.join(out, 'weft-home');
const project = path.join(out, 'project');
await fs.mkdir(home, { recursive: true });
await fs.mkdir(project, { recursive: true });
const port = Number(process.env.BRIDGE_PORT ?? 3198);
const origin = `http://127.0.0.1:${port}`;
const checks = [], errors = [], runs = [];
let stage = 'setup', browser, server, page;
const file = (name) => path.join(out, name);
const save = (name, data) => fs.writeFile(file(name), typeof data === 'string' ? data : JSON.stringify(data, null, 2));

async function check(name, ok, detail = {}) {
  checks.push({ name, ok: !!ok, stage, ...detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok && page) await page.screenshot({ path: file(`failure-${checks.length}.png`) }).catch(() => {});
}
function inspect() {
  const r = spawnSync(process.execPath, [path.join(root, 'cli/dist/weft.mjs'), 'graph', 'canvas-inspect'], { env: { ...process.env, WEFT_HOME: home }, encoding: 'utf8' });
  if (r.status !== 0) throw Error(`canvas-inspect: ${r.stderr}`);
  return JSON.parse(r.stdout);
}
function runHost(label, command, args, env, cwd) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => child.kill('SIGTERM'), 8 * 60_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ label, code, started, ms: Date.now() - started, stdout, stderr });
    });
  });
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

const TASKS = {
  claude: {
    model: process.env.WEFT_E2E_CLAUDE_MODEL || 'sonnet', receiptHost: 'claude-code', marker: '一件事', question: '如果只能改一件事，最该改什么？',
    prompt: '我的 Weft 画布现在开着。请在「为什么复盘写了，同样的事故还会重复发生？」这个问题下面开一个分支，问题是「如果只能改一件事，最该改什么？」，并把「事故数据怎么说？」那个节点作为引用连到这个新分支上。然后只根据这个分支实际会收到的上下文回答它（150 字以内），把回答写回画布。完成后告诉我做了哪些修改。',
  },
  codex: {
    model: process.env.WEFT_E2E_CODEX_MODEL || null, receiptHost: 'codex', marker: '衡量', question: '怎么衡量改进是否真的生效？',
    prompt: '我的 Weft 画布现在开着。请在「为什么复盘写了，同样的事故还会重复发生？」这个问题下面再开一个分支，问题是「怎么衡量改进是否真的生效？」，并把「事故数据怎么说？」那个节点作为引用连到这个新分支上。然后只根据这个分支实际会收到的上下文回答它（150 字以内），把回答写回画布。完成后告诉我做了哪些修改。',
  },
};

function hostCommand(host) {
  const t = TASKS[host];
  const base = { ...process.env, WEFT_HOME: home };
  if (host === 'claude') {
    return {
      command: 'claude',
      args: ['-p', t.prompt, '--output-format', 'stream-json', '--verbose', '--model', t.model,
        '--allowedTools', 'Bash(node:*)', 'Read', 'Write', 'Skill', 'Glob'],
      env: base,
    };
  }
  return {
    command: 'codex',
    args: ['exec', '--json', '--skip-git-repo-check', '-C', project, '-s', 'workspace-write',
      '-c', 'sandbox_workspace_write.network_access=true',
      ...(t.model ? ['-c', `model="${t.model}"`] : []),
      t.prompt],
    env: base,
  };
}

function skillEvidence(host, stdout) {
  const lines = stdout.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const text = JSON.stringify(lines);
  const usedCli = /skills\/weft(?:-canvas)?\/scripts\/weft\.mjs/.test(text);
  const readSkill = host === 'claude'
    ? lines.some((l) => l.type === 'assistant' && l.message?.content?.some((c) => c.type === 'tool_use' && (c.name === 'Skill' || /skills\/weft(?:-canvas)?\/SKILL\.md/.test(JSON.stringify(c.input)))))
    : /skills\/weft(?:-canvas)?\/SKILL\.md/.test(text);
  // Hosts call the CLI either by path or through a shell variable holding it (`CLI=.../weft.mjs; node "$CLI" ...`).
  const commands = [...text.matchAll(/(?:weft\.mjs|\$\{?CLI\}?)\\?"?\s+([a-z-]+)/g)].map((m) => m[1]);
  return { usedCli, readSkill, commands: [...new Set(commands)] };
}

try {
  stage = 'install';
  const install = spawnSync(process.execPath, [path.join(root, 'scripts/install-skill.mjs'), '--project', project, '--hosts', ...hosts.map((h) => (h === 'claude' ? 'claude' : 'codex')), '--apply'], { encoding: 'utf8' });
  await save('install.json', { status: install.status, stdout: install.stdout, stderr: install.stderr });
  await check('The Skill installs into a fresh project', install.status === 0, { stderr: install.stderr });

  stage = 'server';
  server = spawn(process.execPath, ['server.mjs'], {
    cwd: root, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', SERVE_DIST: path.join(root, 'dist'), WEFT_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${origin}/api/canvas/status`)).ok) break; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 150));
  }

  stage = 'canvas';
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1500, height: 950 }, locale: 'zh-CN' });
  context.setDefaultTimeout(15000);
  await context.addInitScript(() => { localStorage.setItem('weft.tutorialDone', '1'); });
  page = await context.newPage();
  page.on('pageerror', (e) => errors.push({ stage, message: e.stack }));
  page.on('dialog', (d) => d.accept());
  await page.goto(origin);
  await page.getByTestId('host-handoff-open').click();
  const graph = { version: 1, name: '复盘画布', nodes: [
    node('root', '为什么复盘写了，同样的事故还会重复发生？', '常见原因：行动项没有负责人和截止时间，复盘结论停留在文档里，没有人跟进验证。', 0, 0),
    node('evidence', '事故数据怎么说？', '过去 10 起重复事故中，有 7 起对应的复盘行动项没有指定负责人；平均关闭周期 41 天。', 560, 0),
  ], edges: [] };
  await fs.writeFile(file('fixture.weft.json'), JSON.stringify(graph));
  await page.getByTestId('host-handoff-import-graph').setInputFiles(file('fixture.weft.json'));
  await page.getByRole('status').filter({ hasText: '已导入' }).waitFor();
  await page.getByTestId('canvas-bridge-toggle').check();
  await page.getByTestId('canvas-bridge-status').filter({ hasText: '已开启' }).waitFor();
  await page.screenshot({ path: file('00-canvas-before.png') });
  let before = inspect();
  await save('inspect-before.json', before);

  const launch = async (host) => {
    const cmd = hostCommand(host);
    const r = await runHost(host, cmd.command, cmd.args, cmd.env, project);
    await save(`${host}-stdout.jsonl`, r.stdout);
    await save(`${host}-stderr.txt`, r.stderr);
    return r;
  };
  const evaluate = async (host, r, after) => {
    stage = `host-${host}`;
    const t = TASKS[host];
    const ev = skillEvidence(host, r.stdout);
    const added = after.nodes.filter((n) => !before.nodes.some((b) => b.id === n.id));
    const target = added.find((n) => n.question.includes(t.marker));
    const edges = target ? after.edges.filter((e) => e.target === target.id) : [];
    const branchFromRoot = edges.some((e) => e.source === 'root' && (e.kind === 'branch' || e.kind === 'solid'));
    const refFromEvidence = edges.some((e) => e.source === 'evidence' && e.kind.startsWith('reference'));
    const answered = !!target && target.versions >= 1 && after.status.replay.includes(target.id);
    runs.push({ host, model: t.model, exit: r.code, ms: r.ms, skill: ev, added: added.map((n) => n.id), target: target?.id ?? null, answer: target?.answer ?? null });
    await check(`${host}: the host process finished (exit 0)`, r.code === 0, { exit: r.code, ms: r.ms });
    await check(`${host}: the host read the installed Skill`, ev.readSkill, ev);
    await check(`${host}: the host drove the canvas through the installed Skill CLI`, ev.usedCli && ev.commands.includes('canvas-edit'), ev);
    await check(`${host}: the requested branch question is on the canvas`, !!target, { added: added.map((n) => ({ id: n.id, question: n.question })) });
    await check(`${host}: it hangs off the root question and the evidence node is wired in as a reference`, branchFromRoot && refFromEvidence, { edges });
    await check(`${host}: the answer was written back with a host receipt`, answered, { versions: target?.versions, replay: after.status.replay });
    if (target) {
      await page.locator(`.react-flow__node[data-id="${target.id}"]`).waitFor().catch(() => {});
      await page.getByRole('button', { name: /适应视图|Fit View/ }).click().catch(() => {});
      await page.waitForTimeout(400);
      await page.screenshot({ path: file(`01-canvas-after-${host}.png`) });
    }
    const o = await overlaps();
    await check(`${host}: the canvas lays the new nodes out without overlapping cards`, o.length === 0, { overlaps: o });
  };

  if (parallel) {
    const rs = await Promise.all(hosts.map(launch));
    const overlap = Math.min(...rs.map((r) => r.started + r.ms)) > Math.max(...rs.map((r) => r.started));
    await check('The hosts ran at the same time on one canvas', overlap, { windows: rs.map((r) => ({ host: r.label, started: r.started, ms: r.ms })) });
    const after = inspect();
    await save('inspect-after-parallel.json', after);
    for (let i = 0; i < hosts.length; i++) await evaluate(hosts[i], rs[i], after);
  } else {
    for (const host of hosts) {
      const r = await launch(host);
      const after = inspect();
      await save(`inspect-after-${host}.json`, after);
      await evaluate(host, r, after);
      before = after;
    }
  }

  stage = 'final';
  const exported = await page.evaluate(async () => {
    const out = [];
    for (const info of await indexedDB.databases()) {
      const db = await new Promise((res, rej) => { const r = indexedDB.open(info.name); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
      for (const name of db.objectStoreNames) {
        const rows = await new Promise((res, rej) => { const tx = db.transaction(name, 'readonly'); const s = tx.objectStore(name); const k = s.getAllKeys(); const v = s.getAll(); tx.oncomplete = () => res(k.result.map((key, i) => ({ key, value: v.result[i] }))); tx.onerror = () => rej(tx.error); });
        out.push(...rows.filter((r) => String(r.key).startsWith('weft:project:')));
      }
      db.close();
    }
    return out;
  });
  const stored = exported.map((r) => (typeof r.value === 'string' ? JSON.parse(r.value) : r.value)).map((v) => v.state).find((s) => s?.nodes?.some((n) => n.id === 'evidence'));
  const receipts = (stored?.nodes ?? []).flatMap((n) => (n.data.hostReceipts ?? []).map((rc) => ({ node: n.id, host: rc.host ?? null, runId: rc.runId ?? null, mode: rc.executionMode ?? null, isolationVerified: rc.isolationVerified, deliveredMessages: rc.deliveredInput ? JSON.parse(rc.deliveredInput).messages.length : null, delivered: rc.deliveredInput ?? '' })));
  await save('receipts.json', receipts.map(({ delivered, ...rc }) => rc));
  if (parallel) {
    const leaks = hosts.flatMap((h) => receipts.filter((rc) => rc.host === TASKS[h].receiptHost)
      .flatMap((rc) => hosts.filter((o) => o !== h && rc.delivered.includes(TASKS[o].question)).map((o) => `${h} saw ${o}`)));
    await check('Each host answered from its own branch only: no sibling question in its delivered input', leaks.length === 0 && receipts.length >= hosts.length, { leaks });
  }
  await check('Receipts persisted in the canvas storage name each host', hosts.every((h) => receipts.some((rc) => rc.host === TASKS[h].receiptHost)), { receipts });
  const events = (stored?.events ?? []).filter((e) => e.op === 'agent-edit');
  await check('Every agent change is in the canvas event log as agent-edit', events.length >= hosts.length * 2, { events: events.length });
  await check('No page errors', errors.length === 0, { errors });
} catch (err) {
  await check(`Unexpected failure: ${err instanceof Error ? err.message : String(err)}`, false);
} finally {
  await browser?.close().catch(() => {});
  server?.kill();
  const passed = checks.filter((c) => c.ok).length;
  const summary = { verdict: passed === checks.length ? 'PASS' : 'FAIL', passed, failed: checks.length - passed, parallel, hosts: runs, checks, errors };
  await save('summary.json', summary);
  console.log(`${summary.verdict} ${passed}/${checks.length} → ${path.relative(root, out)}`);
  process.exitCode = summary.verdict === 'PASS' ? 0 : 1;
}
