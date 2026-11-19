#!/usr/bin/env node
// The local-server road for agent sessions, as someone without the desktop
// app meets it: `weft setup skill` installs /weft and $weft, `weft open`
// starts the server in the background and opens one Claude Code session in
// the browser, the canvas follows the session as it grows, the start page
// and the conversation map list both agents' sessions, condensing shows the
// whole-canvas token total, and `weft stop` ends the background server.
// Synthetic sessions in a throwaway HOME; a stand-in `open` records the URL
// instead of launching a browser. No model is called.
//
//   node scripts/verify-local-atlas.mjs                      # this checkout's CLI
//   node scripts/verify-local-atlas.mjs --weft path/to/weft  # an installed package
import { chromium } from 'playwright-core';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const weftArg = process.argv.includes('--weft') ? process.argv[process.argv.indexOf('--weft') + 1] : null;
const weft = weftArg ? [path.resolve(weftArg)] : [process.execPath, path.join(root, 'cli/dist/weft.mjs')];
const out = path.join(root, 'evidence', `local-atlas-${Date.now()}`);
await fs.mkdir(out, { recursive: true });
const home = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'weft-local-atlas-'));
const proj = path.join(home, 'work', 'demo');
const bin = path.join(home, 'bin');
const opened = path.join(home, 'opened.txt');
for (const d of [proj, bin]) await fs.mkdir(d, { recursive: true });
await fs.writeFile(path.join(bin, 'open'), `#!/bin/sh\necho "$1" >> '${opened}'\n`, { mode: 0o755 });
await fs.writeFile(path.join(bin, 'xdg-open'), `#!/bin/sh\necho "$1" >> '${opened}'\n`, { mode: 0o755 });
const port = Number(process.env.LOCAL_ATLAS_PORT ?? 3296);
const origin = `http://localhost:${port}`;
const checks = [], errors = [];
let browser, page;
const file = (name) => path.join(out, name);
const env = { ...process.env, HOME: home, WEFT_HOME: path.join(home, '.weft'), PATH: `${bin}:${process.env.PATH}`, WEFT_PORT: '' };
for (const k of Object.keys(env)) if (/_API_KEY$|^OLLAMA_MODELS$/.test(k)) delete env[k];
async function check(name, ok, detail = {}) {
  checks.push({ name, ok: !!ok, ...detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok && page) await page.screenshot({ path: file(`failure-${checks.length}.png`) }).catch(() => {});
}
const run = (args, opts = {}) => spawnSync(weft[0], [...weft.slice(1), ...args], { encoding: 'utf8', env, cwd: proj, ...opts });
const wait = async (fn, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 250)); } return false; };
const portState = async () => { try { return (await fetch(`${origin}/api/models`)).ok ? 'up' : 'other'; } catch { return 'down'; } };

// A Claude Code session of six turns in one chain, and a Codex session.
const ccId = '7c1d2e3f-0a1b-4c5d-8e9f-0123456789ab';
const ccDir = path.join(home, '.claude', 'projects', '-work-demo');
const ccFile = path.join(ccDir, `${ccId}.jsonl`);
const topics = ['cache layout', 'eviction policy', 'warm-up on deploy', 'metrics to watch', 'failure modes', 'rollout plan'];
let parent = null;
const ccLines = [];
const ccTurn = (i, q, a) => {
  const at = new Date(Date.UTC(2026, 9, 12, 2, i)).toISOString();
  const u = { type: 'user', uuid: `u${i}`, parentUuid: parent, sessionId: ccId, cwd: '/work/demo', timestamp: at, message: { role: 'user', content: q } };
  const r = { type: 'assistant', uuid: `a${i}`, parentUuid: `u${i}`, sessionId: ccId, cwd: '/work/demo', timestamp: at, message: { role: 'assistant', content: [{ type: 'text', text: a }] } };
  parent = `a${i}`;
  return [JSON.stringify(u), JSON.stringify(r)];
};
topics.forEach((tp, i) => ccLines.push(...ccTurn(i, `CC question ${i + 1}: how should we handle the ${tp}?`, `CC answer ${i + 1} on the ${tp}. ${'Detail sentence about the trade-offs involved. '.repeat(12)}`)));
await fs.mkdir(ccDir, { recursive: true });
await fs.writeFile(ccFile, ccLines.join('\n') + '\n');
const cxId = '019a2b3c-4d5e-7f60-8a9b-cdef01234567';
const cxDir = path.join(home, '.codex', 'sessions', '2026', '10', '12');
await fs.mkdir(cxDir, { recursive: true });
const cx = (type, payload, i = 0) => JSON.stringify({ timestamp: new Date(Date.UTC(2026, 9, 12, 1, i)).toISOString(), type, payload });
await fs.writeFile(path.join(cxDir, `rollout-2026-10-12T01-00-00-${cxId}.jsonl`), [
  cx('session_meta', { id: cxId, cwd: '/work/demo', timestamp: '2026-10-12T01:00:00.000Z' }),
  cx('turn_context', { turn_id: 't1' }),
  cx('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Codex question: where does the config live?' }] }, 1),
  cx('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Codex answer: in config/app.toml.' }] }, 1),
].join('\n') + '\n');

try {
  // ── /weft and $weft come with setup skill ──
  const dry = run(['setup', 'skill', '--hosts', 'claude', 'codex']);
  const ccCmd = path.join(home, '.claude', 'commands', 'weft.md');
  const cxCmd = path.join(home, '.codex', 'skills', 'weft', 'SKILL.md');
  const absent = async (p) => !(await fs.stat(p).catch(() => null));
  await check('setup skill without --apply only announces the /weft and $weft commands', /\/weft in Claude Code: would install/.test(dry.stderr) && /\$weft in Codex: would install/.test(dry.stderr) && await absent(ccCmd) && await absent(cxCmd), { stderr: dry.stderr.slice(-600) });
  const parses = (t) => { try { JSON.parse(t); return true; } catch { return false; } };
  await check('Its standard output stays the installer\'s JSON manifest', parses(dry.stdout), { stdout: dry.stdout.slice(-300) });
  const applied = run(['setup', 'skill', '--hosts', 'claude', 'codex', '--apply']);
  const ccBody = await fs.readFile(ccCmd, 'utf8').catch(() => '');
  const cxBody = await fs.readFile(cxCmd, 'utf8').catch(() => '');
  await check('setup skill --apply installs both commands where the desktop app puts them, with the weft open fallback', applied.status === 0 && ccBody.includes('weft open <sessionId>') && cxBody.includes('weft open <sessionId>') && /^name: weft$/m.test(cxBody), { stderr: applied.stderr.slice(-600) });
  const again = run(['setup', 'skill', '--hosts', 'claude', 'codex', '--apply']);
  await check('Running it again reports the commands as already installed', /\/weft in Claude Code: already installed/.test(again.stderr) && /\$weft in Codex: already installed/.test(again.stderr), { stderr: again.stderr.slice(-400) });

  // ── weft open with nothing running ──
  await check('Nothing is listening on the test port before weft open', (await portState()) === 'down');
  const op = run(['open', ccId, '--port', String(port)], { timeout: 60000 });
  const openedUrl = async () => (await fs.readFile(opened, 'utf8').catch(() => '')).trim().split('\n').pop() ?? '';
  await wait(async () => !!(await openedUrl()), 5000);
  const url = await openedUrl();
  const expected = `${origin}/#open=${encodeURIComponent(`weft://open?session=${ccId}`)}`;
  await check('weft open starts the server in the background and opens the session link', op.status === 0 && /started the Weft server in the background/.test(op.stdout) && url === expected && (await portState()) === 'up', { stdout: op.stdout, stderr: op.stderr, url });

  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1500, height: 950 }, locale: 'zh-CN' });
  context.setDefaultTimeout(20000);
  await context.addInitScript(() => { localStorage.setItem('weft.tutorialDone', '1'); localStorage.setItem('weft.lang', 'zh'); });
  page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.stack));
  await page.goto(url);
  const landed = await wait(async () => (await page.getByText('CC question 6', { exact: false }).count()) > 0);
  await page.waitForTimeout(800);
  await page.screenshot({ path: file('01-opened-session.png') });
  const bodyText = await page.evaluate(() => document.body.innerText);
  await check('The page opens the Claude Code session as a canvas through the local server', landed && bodyText.includes('CC question 1'));
  await check('The link is taken once: the fragment is cleared after opening', !(await page.evaluate(() => location.hash)));

  // ── the canvas follows the session ──
  await fs.appendFile(ccFile, ccTurn(6, 'CC question 7: what changed after the first week?', 'CC answer 7: hit rate rose to 93%.').join('\n') + '\n');
  const t0 = Date.now();
  const followed = await wait(async () => (await page.getByText('CC question 7', { exact: false }).count()) > 0, 20000);
  await page.screenshot({ path: file('02-followed-new-turn.png') });
  await check('A turn appended to the session file appears on the open canvas within seconds', followed, { seconds: (Date.now() - t0) / 1000 });

  // ── condensing shows the whole-canvas total ──
  await page.locator('button[title="更多操作"]').click();
  await page.locator('button[title^="凝练：让模型检查全图"]').click();
  const total = page.locator('[data-condense-total]');
  await total.waitFor();
  const totalText = await total.textContent();
  await page.screenshot({ path: file('03-condense-total.png') });
  const m = /全图问答约 ([\d,]+) tok，凝练所选段后约 ([\d,]+) tok（减少 ([\d.]+)%）/.exec(totalText ?? '');
  const [before, after, pct] = m ? [Number(m[1].replace(/,/g, '')), Number(m[2].replace(/,/g, '')), Number(m[3])] : [0, 0, 0];
  await check('The condense window states the canvas total before and after, and the reduction', !!m && before > after && after > 0 && Math.abs(pct - Math.round(((before - after) / before) * 1000) / 10) < 0.11, { totalText });
  await page.keyboard.press('Escape');

  // ── the start page and the conversation map on a fresh canvas origin state ──
  const fresh = await browser.newContext({ viewport: { width: 1500, height: 950 }, locale: 'zh-CN' });
  await fresh.addInitScript(() => { localStorage.setItem('weft.tutorialDone', '1'); localStorage.setItem('weft.lang', 'zh'); });
  const p2 = await fresh.newPage();
  p2.on('pageerror', (e) => errors.push(e.stack));
  await p2.goto(`${origin}/`);
  const landing = p2.locator('[data-landing-atlas]');
  await check('The start page offers the agent conversations once the local server answers', await landing.waitFor({ timeout: 15000 }).then(() => true, () => false));
  await p2.screenshot({ path: file('04-start-page.png') });
  await landing.click();
  const both = await wait(async () => (await p2.getByText('CC question 1', { exact: false }).count()) > 0 && (await p2.getByText('Codex question', { exact: false }).count()) > 0);
  await p2.screenshot({ path: file('05-conversation-map.png') });
  await check('The conversation map lists both the Claude Code and the Codex session', both);
  await p2.getByRole('button', { name: '接入', exact: true }).click();
  const sources = await p2.locator('[data-atlas-source]').evaluateAll((els) => els.map((e) => e.getAttribute('data-atlas-source')));
  await p2.screenshot({ path: file('06-sources.png') });
  await check('Its sources are the agents on this machine, without an empty harness entry', sources.includes('claude-projects') && sources.includes('codex-sessions') && !sources.includes('dsh-sessions'), { sources });
  await fresh.close();

  // ── reuse and stop ──
  const op2 = run(['open', cxId, '--port', String(port)], { timeout: 30000 });
  await check('A second weft open reuses the running server', op2.status === 0 && !/started the Weft server/.test(op2.stdout), { stdout: op2.stdout });
  const bad = run(['open', 'x;rm', '--port', String(port)]);
  await check('weft open refuses an argument that is neither a session id nor a weft:// link', bad.status === 2);
  const stop = run(['stop']);
  const down = await wait(async () => (await portState()) === 'down', 10000);
  await check('weft stop ends the background server', /stopped the background Weft server/.test(stop.stdout) && down, { stdout: stop.stdout });

  await check('No page errors', errors.length === 0, { errors });
} catch (err) {
  await check(`Unexpected failure: ${err.message}`, false, { stack: err.stack });
} finally {
  await browser?.close().catch(() => {});
  if ((await portState()) === 'up') run(['stop']);
  await fs.rm(home, { recursive: true, force: true });
  const passed = checks.filter((c) => c.ok).length;
  await fs.writeFile(file('summary.json'), JSON.stringify({ weft: weftArg ?? 'cli/dist/weft.mjs', passed, failed: checks.length - passed, checks }, null, 2));
  console.log(`\n${passed}/${checks.length} PASS · ${out}`);
  process.exitCode = passed === checks.length ? 0 : 1;
}
