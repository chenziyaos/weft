#!/usr/bin/env node
// Acceptance for the published CLI package as a new user meets it: install the
// tarball (or a registry spec) into an empty project, `weft serve`, use the
// canvas in a real browser, install the Skill with `weft setup skill`, and let
// the installed Skill's CLI edit and answer on the live canvas. No model is
// called; the answer is synthetic.
//
//   npm run cli:pack && node scripts/verify-cli-package.mjs cli/weft-canvas-X.tgz
//   node scripts/verify-cli-package.mjs weft-canvas@X --registry <URL>
import { chromium } from 'playwright-core';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const spec = process.argv[2];
if (!spec) { console.error('usage: verify-cli-package.mjs <tarball | package spec> [--registry URL]'); process.exit(2); }
const registry = process.argv.includes('--registry') ? process.argv[process.argv.indexOf('--registry') + 1] : null;
const out = path.join(root, 'evidence', `cli-package-${Date.now()}`);
const app = path.join(out, 'install'), proj = path.join(out, 'project'), home = path.join(out, 'weft-home');
for (const d of [app, proj, home]) await fs.mkdir(d, { recursive: true });
const port = Number(process.env.PACKAGE_PORT ?? 3198);
const origin = `http://localhost:${port}`;
const checks = [], errors = [];
let browser, server, page;
const file = (name) => path.join(out, name);
const save = (name, data) => fs.writeFile(file(name), typeof data === 'string' ? data : JSON.stringify(data, null, 2));
const env = { ...process.env, WEFT_HOME: home, WEFT_PORT: '' };
for (const k of Object.keys(env)) if (/_API_KEY$|^OLLAMA_MODELS$/.test(k)) delete env[k];

async function check(name, ok, detail = {}) {
  checks.push({ name, ok: !!ok, ...detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok && page) await page.screenshot({ path: file(`failure-${checks.length}.png`) }).catch(() => {});
}
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', env, ...opts });
const weftBin = path.join(app, 'node_modules/.bin/weft');
const json = (s) => { try { return JSON.parse(s); } catch { return null; } };
const node = (id, question, response, x, y) => ({ id, type: 'thought', position: { x, y }, data: {
  question, response, responses: response ? [response] : [], responseIndex: 0, isRoot: true, isBranch: false,
  isCollapsed: false, isEditing: false, isEditingResponse: false, isLoading: false, tokenCount: 0, highlights: [],
  highlightMode: 'off', attachments: [], excludedAttachmentIds: [], includedAttachmentIds: [], roleMode: 'inherit' } });
/** One-page PDF whose only text is `Weft package probe`. */
function probePdf() {
  const stream = 'BT /F1 18 Tf 20 60 Td (Weft package probe) Tj ET';
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let pdf = '%PDF-1.4\n'; const offsets = [];
  objs.forEach((o, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  return Buffer.from(`${pdf}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}
function startServe() {
  const p = spawn(weftBin, ['serve', '--no-open', '--port', String(port)], { cwd: proj, env });
  let stdout = '', stderr = '';
  p.stdout.on('data', (d) => { stdout += d; });
  p.stderr.on('data', (d) => { stderr += d; });
  return { p, get stdout() { return stdout; }, get stderr() { return stderr; } };
}
async function until(fn, ms = 20000) {
  for (const end = Date.now() + ms; Date.now() < end;) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 150)); }
  return false;
}
const portFree = () => new Promise((resolve) => { const s = net.createServer().once('error', () => resolve(false)).once('listening', () => s.close(() => resolve(true))).listen(port, '127.0.0.1'); });

try {
  run('npm', ['init', '-y'], { cwd: app });
  const installed = run('npm', ['install', '--no-audit', '--no-fund', '--prefer-online', ...(registry ? ['--registry', registry] : []), spec.endsWith('.tgz') ? path.resolve(spec) : spec], { cwd: app });
  const pkg = json(await fs.readFile(path.join(app, 'node_modules/weft-canvas/package.json'), 'utf8').catch(() => 'null'));
  const deps = (await fs.readdir(path.join(app, 'node_modules')).catch(() => [])).filter((n) => !n.startsWith('.'));
  await check('The package installs with no third-party runtime dependencies', installed.status === 0 && pkg && deps.length === 1, { version: pkg?.version, deps, npm: installed.status === 0 ? 'ok' : (installed.stderr || installed.error?.message || '').slice(-800) });

  // weft serve: the canvas app from the package, on a loopback origin
  server = startServe();
  const up = await until(() => server.stdout.includes('Weft is running at'));
  await check('weft serve starts the packaged canvas and prints its address', up && server.stdout.includes(`http://localhost:${port}/`), { stdout: server.stdout.trim() });
  await check('Without any model configured, the banner says how to add one', /No model is configured/.test(server.stdout) && server.stdout.includes(path.join(home, '.env')));
  const again = run(weftBin, ['serve', '--no-open', '--port', String(port)], { cwd: proj });
  await check('A second weft serve finds the running canvas instead of failing', again.status === 0 && /already running/.test(again.stdout), { stdout: again.stdout.trim() });

  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1500, height: 950 }, locale: 'zh-CN' });
  context.setDefaultTimeout(15000);
  await context.addInitScript(() => { localStorage.setItem('weft.tutorialDone', '1'); localStorage.setItem('weft.lang', 'zh'); });
  page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.stack));
  page.on('dialog', (d) => d.accept());
  await page.goto(origin);
  await page.locator('.react-flow').waitFor();
  await page.screenshot({ path: file('01-first-open.png') });
  await check('The canvas page loads from the package', true);

  const pdf = await fetch(`${origin}/api/pdf-extract`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ base64: probePdf().toString('base64'), renderImages: false }) }).then((r) => r.json());
  await check('PDF text extraction works inside the bundled server', pdf.text?.includes('Weft package probe') && pdf.numPages === 1, { pdf });

  // weft setup skill, then the installed Skill's own CLI drives the canvas
  // the /weft and $weft commands are per user: a throwaway HOME keeps them off this machine's real one
  const userHome = path.join(out, 'user-home');
  await fs.mkdir(userHome, { recursive: true });
  const setup = run(weftBin, ['setup', 'skill', '--apply'], { cwd: proj, env: { ...env, HOME: userHome } });
  const skillCli = path.join(proj, '.claude/skills/weft-canvas/scripts/weft.mjs');
  const exists = (p) => fs.stat(p).then(() => true, () => false);
  await check('weft setup skill --apply installs the Skill for Claude Code and Codex, and their /weft and $weft commands', setup.status === 0 && json(setup.stdout)?.destinations?.length === 2
    && (await exists(skillCli)) && (await exists(path.join(proj, '.agents/skills/weft-canvas/SKILL.md')))
    && (await exists(path.join(userHome, '.claude/commands/weft.md'))) && (await exists(path.join(userHome, '.codex/skills/weft/SKILL.md'))), { stderr: setup.stderr.slice(-600) });
  await fs.rm(userHome, { recursive: true, force: true });
  const skill = (args) => run(process.execPath, [skillCli, ...args], { cwd: proj });

  await page.getByTestId('host-handoff-open').click();
  await save('fixture.weft.json', { version: 1, name: '安装验收', nodes: [node('root', '新同学第一次用 Weft，最容易卡在哪？', '常见是不知道从哪开始：没配模型，或不知道 Agent 能改画布。', 0, 0)], edges: [] });
  await page.getByTestId('host-handoff-import-graph').setInputFiles(file('fixture.weft.json'));
  await page.getByRole('status').filter({ hasText: '已导入' }).waitFor();
  await page.getByTestId('canvas-bridge-toggle').check();
  await page.getByTestId('canvas-bridge-status').filter({ hasText: '已开启' }).waitFor();
  const status = json(skill(['canvas-status']).stdout);
  await check('The installed Skill CLI sees the live canvas', status?.listening === true, { status });
  const s0 = json(skill(['canvas-inspect']).stdout);
  await save('ops.json', [{ op: 'branch', source: 'root', id: 'first-step', question: '第一步应该提示什么？' }]);
  const edit = skill(['canvas-edit', '--operations', file('ops.json'), '--request-id', 'package-branch', '--expected-hash', s0.hash]);
  const compile = skill(['canvas-compile', '--target', 'first-step', '--host', 'claude-code', '--out', file('first-step.handoff.json')]);
  await save('answer.txt', '先提示一条命令：weft serve 打开画布，再用 weft setup skill --apply 让 Agent 能改它。');
  const result = skill(['result', '--handoff', file('first-step.handoff.json'), '--answer', file('answer.txt'), '--host', 'claude-code', '--run-id', 'package-run-1', '--mode', 'current-session', '--out', file('first-step.host-result.json')]);
  const apply = skill(['canvas-apply', '--result', file('first-step.host-result.json'), '--request-id', 'package-apply']);
  const shown = await page.getByText('先提示一条命令').first().waitFor().then(() => true, () => false);
  await page.screenshot({ path: file('02-agent-answered.png') });
  await check('Through the installed Skill an agent branches, answers and writes back; the answer shows on the page',
    [edit, compile, result, apply].every((r) => r.status === 0) && shown, { errors: [edit, compile, result, apply].map((r) => r.status === 0 ? 'ok' : r.stderr.trim()) });

  // Ctrl+C stops the server and frees the port
  await browser.close(); browser = null;
  server.p.kill('SIGINT');
  const code = await new Promise((r) => server.p.on('exit', (c, s) => r(c ?? s)));
  await check('Ctrl+C stops weft serve cleanly and frees the port', (code === 0 || code === 'SIGINT') && await until(portFree, 5000), { code });
  server = null;

  // a foreign program on the port: a clear message, no takeover
  const blocker = net.createServer((s) => s.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n')).listen(port, '127.0.0.1');
  await new Promise((r) => blocker.once('listening', r));
  const taken = await new Promise((resolve) => { const p = spawn(weftBin, ['serve', '--no-open', '--port', String(port)], { cwd: proj, env }); let e = ''; p.stderr.on('data', (d) => { e += d; }); p.on('exit', (c) => resolve({ c, e })); });
  blocker.close();
  await check('When another program holds the port, weft serve says so and suggests --port', taken.c === 1 && /--port/.test(taken.e), { stderr: taken.e.trim() });

  await check('No page errors', errors.length === 0, { errors });
} catch (err) {
  await check(`Unexpected failure: ${err.message}`, false, { stack: err.stack });
} finally {
  await browser?.close().catch(() => {});
  server?.p.kill('SIGTERM');
  await fs.rm(path.join(home, 'canvas-bridge.json'), { force: true });
  await fs.rm(app, { recursive: true, force: true });
  const passed = checks.filter((c) => c.ok).length;
  await save('summary.json', { spec, registry, passed, failed: checks.length - passed, checks });
  console.log(`\n${passed}/${checks.length} PASS · ${out}`);
  process.exitCode = passed === checks.length ? 0 : 1;
}
