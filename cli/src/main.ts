#!/usr/bin/env node
// Weft — the command line and the MCP server over the why layer in
// ./lib.ts (see there for the stores, the index and the four questions).
import { promises as fsp, existsSync, statSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import legacyHome from '../../runtime/legacy-home.cjs';
// Load index/history dependencies only after dispatching the graph-only path.
async function runIndexCli(): Promise<void> {
const { deriveTouches } = await import('../../src/lib/events/project');
const indexLib = await import('./lib');
const {
  HOME,
  FACT_FILE,
  CACHE_FILE,
  TEXT_FILE,
  TEXT_LINES,
  LEGACY_FILE,
  eventsOf,
  LOCK_FILE,
  loadFacts,
  loadCache,
  buildIndex,
  ensureFresh,
  artifactsLine,
  summarize,
  resolveQuery,
  hitsFor,
  renderWhy,
  findHits,
  memoriesJson,
  suggestJson,
  topicsJson,
  byTopicJson,
  renderFind,
  factsForCheck,
  renderCheck,
  renderRecall,
  CLI_VERSION,
  MCP_TOOLS,
  mcpCall,
} = indexLib;

async function serveMcp(): Promise<void> {
  const send = (msg: unknown): void => { process.stdout.write(`${JSON.stringify(msg)}\n`); };
  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let req: { id?: unknown; method?: string; params?: Record<string, unknown> };
    try { req = JSON.parse(line) as typeof req; } catch { continue; }
    const { id, method, params } = req;
    if (method === 'notifications/initialized' || method === 'notifications/cancelled') continue;
    if (id === undefined) continue; // a notification we do not handle
    try {
      if (method === 'initialize') {
        send({ jsonrpc: '2.0', id, result: { protocolVersion: (params?.protocolVersion as string) ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'weft', version: CLI_VERSION } } });
      } else if (method === 'ping') {
        send({ jsonrpc: '2.0', id, result: {} });
      } else if (method === 'tools/list') {
        send({ jsonrpc: '2.0', id, result: { tools: MCP_TOOLS } });
      } else if (method === 'tools/call') {
        const name = String(params?.name ?? '');
        const args = (params?.arguments as Record<string, unknown>) ?? {};
        try {
          const text = await mcpCall(name, args);
          send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } });
        } catch (err) {
          send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true } });
        }
      } else {
        send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
      }
    } catch (err) {
      send({ jsonrpc: '2.0', id, error: { code: -32603, message: err instanceof Error ? err.message : String(err) } });
    }
  }
}

// ─── setup: MCP registration and the two rules, explicit and reversible ──
//
// `setup mcp` registers the server for Claude Code in THIS project's
// .mcp.json (project scope) and for Codex in ~/.codex/config.toml (the
// only place Codex reads). `setup rules` appends a marked block to this
// project's CLAUDE.md and AGENTS.md; --remove takes it out. Nothing is
// written globally for Claude Code, nothing is written without being asked.

const RULES_BEGIN = '<!-- weft:begin -->';
const RULES_END = '<!-- weft:end -->';
const RULES_BLOCK = `${RULES_BEGIN}
## Weft (the why layer)
- Before editing a file, run \`weft why --check <path>\` (or the why_check tool). If it reports history, run \`weft why <path>\` and read what shaped the file before changing it.
- When asked why code is the way it is, query first — \`weft why <path>\`, \`weft find "<words>"\` — then read the code.
${RULES_END}
`;

/** How to start the server from a config file: the PATH command when
 *  installed, else node plus this very file. */
function mcpCommand(): { command: string; args: string[] } {
  const onPath = (process.env.PATH ?? '').split(path.delimiter).some((d) => { try { return !!d && statSync(path.join(d, 'weft')).isFile(); } catch { return false; } });
  return onPath ? { command: 'weft', args: ['mcp'] } : { command: process.execPath, args: [process.argv[1], 'mcp'] };
}

async function setupMcp(): Promise<string[]> {
  const notes: string[] = [];
  const cmd = mcpCommand();
  // Claude Code: project-scoped .mcp.json
  const mcpJson = path.join(process.cwd(), '.mcp.json');
  let cfg: { mcpServers?: Record<string, unknown> } = {};
  try { cfg = JSON.parse(await fsp.readFile(mcpJson, 'utf8')) as typeof cfg; } catch { /* new file */ }
  cfg.mcpServers = { ...(cfg.mcpServers ?? {}), weft: { command: cmd.command, args: cmd.args } };
  const droppedJson = legacyHome.dropLegacyMcpServers(cfg.mcpServers);
  await fsp.writeFile(mcpJson, `${JSON.stringify(cfg, null, 2)}\n`);
  notes.push(`claude-code: registered in ${mcpJson} (project scope)${droppedJson ? ', old entry removed' : ''}`);
  // Codex: ~/.codex/config.toml, a marked block, once
  const codexCfg = path.join(os.homedir(), '.codex', 'config.toml');
  let toml = '';
  try { toml = await fsp.readFile(codexCfg, 'utf8'); } catch { /* new file */ }
  const cleaned = legacyHome.dropLegacyMcpToml(toml);
  if (cleaned !== toml) {
    await fsp.writeFile(codexCfg, cleaned);
    notes.push(`codex: old server entry removed from ${codexCfg}`);
    toml = cleaned;
  }
  if (!/^\[mcp_servers\.weft\]/m.test(toml)) {
    const block = `\n# Weft — the why layer (added by \`weft setup mcp\`)\n[mcp_servers.weft]\ncommand = ${JSON.stringify(cmd.command)}\nargs = ${JSON.stringify(cmd.args)}\n`;
    await fsp.mkdir(path.dirname(codexCfg), { recursive: true });
    await fsp.writeFile(codexCfg, `${toml.replace(/\s*$/, '')}${toml.trim() ? '\n' : ''}${block}`);
    notes.push(`codex: registered in ${codexCfg}`);
  } else notes.push(`codex: already registered in ${codexCfg}`);
  return notes;
}

async function setupRules(remove: boolean): Promise<string[]> {
  const notes: string[] = [];
  for (const name of ['CLAUDE.md', 'AGENTS.md']) {
    const file = path.join(process.cwd(), name);
    let text = '';
    try { text = await fsp.readFile(file, 'utf8'); } catch { if (remove) { notes.push(`${name}: absent`); continue; } }
    const cleaned = legacyHome.dropLegacyRules(text);
    if (cleaned !== text) {
      text = cleaned;
      await fsp.writeFile(file, text);
      notes.push(`${name}: old rules block removed`);
    }
    const has = text.includes(RULES_BEGIN);
    if (remove) {
      if (!has) { notes.push(`${name}: no Weft block`); continue; }
      const stripped = text.replace(new RegExp(`\\n?${RULES_BEGIN}[\\s\\S]*?${RULES_END}\\n?`), '\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '\n');
      await fsp.writeFile(file, stripped);
      notes.push(`${name}: Weft block removed`);
    } else {
      if (has) { notes.push(`${name}: already has the Weft block`); continue; }
      await fsp.writeFile(file, `${text.replace(/\s*$/, '')}${text.trim() ? '\n\n' : ''}${RULES_BLOCK}`);
      notes.push(`${name}: Weft block added`);
    }
  }
  return notes;
}

/** Installs the host skill into this project through the shared installer:
 *  the packaged copy (staged at pack time) or, in a checkout, the repo's own.
 *  Dry run unless --apply; never overwrites an existing skill directory. */
function setupSkill(rest: string[]): void {
  const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const installer = [path.join(pkg, 'scripts/install-skill.mjs'), path.join(pkg, '../scripts/install-skill.mjs')].find((p) => existsSync(p));
  if (!installer) { console.error('skill installer not found in this package'); process.exit(1); }
  const opts = rest.slice(rest.indexOf('skill') + 1);
  if (!opts.includes('--project')) opts.unshift('--project', process.cwd());
  if (!opts.includes('--hosts')) opts.push('--hosts', 'codex', 'claude');
  const r = spawnSync(process.execPath, [installer, ...opts], { stdio: 'inherit' });
  process.exitCode = r.status ?? 1;
  const hosts = opts.slice(opts.indexOf('--hosts') + 1).filter((h) => !h.startsWith('--'));
  // stderr: stdout stays the installer's JSON manifest
  for (const note of setupAgentCommands(pkg, hosts, opts.includes('--apply'))) console.error(note);
}

/** The session-opening command each agent invokes by name — /weft in
 *  Claude Code, $weft in Codex — at the same paths the desktop app's
 *  "Connect" dialog installs them, so either installer sees the other's copy.
 *  Same content counts as installed; a different file there is replaced. */
function setupAgentCommands(pkg: string, hosts: string[], apply: boolean): string[] {
  const assets: Record<string, { srcs: string[]; dest: string; invoke: string }> = {
    claude: {
      srcs: [path.join(pkg, 'commands/claude-code-weft.md'), path.join(pkg, '../protocol/adapters/claude-code/weft.md')],
      dest: path.join(os.homedir(), '.claude', 'commands', 'weft.md'),
      invoke: '/weft in Claude Code',
    },
    codex: {
      srcs: [path.join(pkg, 'commands/codex-weft-SKILL.md'), path.join(pkg, '../protocol/adapters/codex/skills/weft/SKILL.md')],
      dest: path.join(os.homedir(), '.codex', 'skills', 'weft', 'SKILL.md'),
      invoke: '$weft in Codex',
    },
  };
  const notes: string[] = [];
  for (const host of hosts) {
    const a = assets[host];
    if (!a) continue;
    const src = a.srcs.find((p) => existsSync(p));
    if (!src) { notes.push(`${a.invoke}: command file not part of this installation`); continue; }
    const body = readFileSync(src, 'utf8');
    let cur: string | null = null;
    try { cur = readFileSync(a.dest, 'utf8'); } catch { /* absent */ }
    if (cur === body) { notes.push(`${a.invoke}: already installed (${a.dest})`); continue; }
    const verb = cur === null ? 'install' : 'update';
    if (!apply) { notes.push(`${a.invoke}: would ${verb} ${a.dest} (opens the current session in the canvas; add --apply)`); continue; }
    mkdirSync(path.dirname(a.dest), { recursive: true });
    writeFileSync(a.dest, body);
    notes.push(`${a.invoke}: ${verb === 'install' ? 'installed' : 'updated'} ${a.dest}`);
  }
  return notes;
}

// ─── serve: the canvas app on this machine ───────────────────────────
//
// The packaged app (staged into app/ at pack time) or, in a checkout, the
// repo's server.mjs and dist/. One loopback origin serves page and API.
// Canvases live in the browser's storage for that origin, so the port is
// fixed by default: a different port shows a different (empty) set.

const DEFAULT_PORT = 3001;

function appPaths(): { server: string; dist: string; envExample: string } | null {
  const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  if (existsSync(path.join(pkg, 'app/server.mjs'))) return { server: path.join(pkg, 'app/server.mjs'), dist: path.join(pkg, 'app/dist'), envExample: path.join(pkg, 'app/env.example') };
  if (existsSync(path.join(pkg, '../server.mjs'))) return { server: path.join(pkg, '../server.mjs'), dist: path.join(pkg, '../dist'), envExample: path.join(pkg, '../.env.example') };
  return null;
}

/** KEY=value lines, the same format server.mjs reads from its own .env. */
async function readEnvFile(file: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  try {
    for (const line of (await fsp.readFile(file, 'utf8')).split('\n')) {
      const m = line.match(/^\s*([\w.]+)\s*=\s*(.*?)\s*$/);
      if (m && m[2] !== '') out[m[1]] = m[2];
    }
  } catch { /* optional */ }
  return out;
}

async function probe(port: number): Promise<'weft' | 'other' | 'free'> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/models`, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return 'other';
    const page = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) });
    return page.ok && (await page.text()).includes('id="root"') ? 'weft' : 'other';
  } catch (err) {
    const code = (err as { cause?: { code?: string } })?.cause?.code;
    return code === 'ECONNREFUSED' ? 'free' : 'other';
  }
}

function openBrowser(url: string): void {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  try { spawn(cmd, args, { stdio: 'ignore', detached: true }).unref(); } catch { /* the URL is printed anyway */ }
}

async function modelHint(port: number, envFile: string, envExample: string): Promise<string | null> {
  try {
    const models = await (await fetch(`http://127.0.0.1:${port}/api/models`)).json() as { models?: unknown[] };
    if (models.models?.length) return null;
    return [
      'No model is configured on this machine yet. Either of these works:',
      '  - in the canvas, click "Connect a model" (top right) and paste a key or an OpenAI-compatible endpoint (kept in this browser)',
      `  - put keys in ${envFile} (template: ${envExample}), then restart weft serve`,
    ].join('\n');
  } catch { return null; }
}

function requireApp(): { server: string; dist: string; envExample: string } {
  const app = appPaths();
  if (!app) { console.error('the canvas app is not part of this installation'); process.exit(1); }
  if (!existsSync(path.join(app.dist, 'index.html'))) { console.error(`no built app at ${app.dist} — run npm run build in the repository`); process.exit(1); }
  return app;
}

const weftHome = (): string => process.env.WEFT_HOME ?? path.join(os.homedir(), '.weft');

async function serverEnv(port: number, dist: string): Promise<NodeJS.ProcessEnv> {
  return { ...(await readEnvFile(path.join(weftHome(), '.env'))), ...process.env, PORT: String(port), SERVE_DIST: dist, HOST: '127.0.0.1' };
}

const PORT_TAKEN = (port: number): string => `port ${port} is taken by another program (a development server without the built app counts too). Free it, or pass --port <n>\n(canvases are stored per address, so another port starts with an empty canvas list)`;
const backgroundFile = (): string => path.join(weftHome(), 'serve.json');

/** The server `weft open` leaves running: detached, its output in
 *  ~/.weft/serve.log, its pid in ~/.weft/serve.json for `weft stop`. */
async function startBackground(port: number): Promise<void> {
  const app = requireApp();
  await fsp.mkdir(weftHome(), { recursive: true });
  const logFile = path.join(weftHome(), 'serve.log');
  const out = await fsp.open(logFile, 'a');
  const child = spawn(process.execPath, [app.server], { env: await serverEnv(port, app.dist), stdio: ['ignore', out.fd, out.fd], detached: true });
  child.unref();
  await out.close();
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 150));
    if ((await probe(port)) === 'weft') {
      await fsp.writeFile(backgroundFile(), JSON.stringify({ pid: child.pid, port }));
      return;
    }
  }
  try { child.kill(); } catch { /* gone */ }
  console.error(`the canvas server did not start; see ${logFile}`);
  process.exit(1);
}

/** Opens one agent session (or a weft:// link from `weft why`) in the
 *  canvas in the browser, starting the local server in the background when
 *  none is running. The page reads the session file through that server. */
async function openInBrowser(ref: string, port: number): Promise<void> {
  const link = ref.startsWith('weft://') ? ref : `weft://open?session=${ref}`;
  if (!/^weft:\/\/open\?/.test(link) || (!ref.startsWith('weft://') && !/^[A-Za-z0-9_-]{8,}$/.test(ref))) {
    console.error('weft open takes a session id (8+ letters, digits, - or _) or a weft://open?… link');
    process.exit(2);
  }
  const state = await probe(port);
  if (state === 'other') { console.error(PORT_TAKEN(port)); process.exit(1); }
  if (state === 'free') {
    await startBackground(port);
    console.log(`started the Weft server in the background at http://localhost:${port}/ (stop it with: weft stop)`);
  }
  const url = `http://localhost:${port}/#open=${encodeURIComponent(link)}`;
  console.log(`opening ${url}`);
  openBrowser(url);
}

async function stopBackground(): Promise<void> {
  let rec: { pid?: number; port?: number };
  try { rec = JSON.parse(await fsp.readFile(backgroundFile(), 'utf8')); } catch { console.log('no background Weft server (weft stop only stops one that weft open started)'); return; }
  await fsp.rm(backgroundFile(), { force: true });
  if (!rec.pid || !rec.port || (await probe(rec.port)) !== 'weft') { console.log('the background Weft server is no longer running'); return; }
  try { process.kill(rec.pid, 'SIGTERM'); console.log(`stopped the background Weft server on port ${rec.port}`); } catch { console.log('the background Weft server is no longer running'); }
}

async function serveApp(port: number, open: boolean): Promise<void> {
  const app = requireApp();
  const url = `http://localhost:${port}/`;
  const state = await probe(port);
  if (state === 'weft') {
    console.log(`Weft is already running at ${url}`);
    if (open) openBrowser(url);
    return;
  }
  if (state === 'other') { console.error(PORT_TAKEN(port)); process.exit(1); }
  const envFile = path.join(weftHome(), '.env');
  const child = spawn(process.execPath, [app.server], { env: await serverEnv(port, app.dist), stdio: ['ignore', 'pipe', 'pipe'] });
  const log: string[] = [];
  const keep = (chunk: Buffer): void => { log.push(chunk.toString()); if (log.length > 200) log.shift(); };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  const exited = new Promise<number>((resolve) => child.on('exit', (code) => resolve(code ?? 1)));
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    if (child.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 150));
    ready = (await probe(port)) === 'weft';
  }
  if (!ready) {
    child.kill();
    console.error(`the canvas server did not start:\n${log.join('').trim()}`);
    process.exit(1);
  }
  console.log(`Weft is running at ${url}\nKeep this terminal open; Ctrl+C stops it.`);
  const hint = await modelHint(port, envFile, app.envExample);
  if (hint) console.log(`\n${hint}`);
  console.log('\nOpen your Claude Code or Codex sessions as graphs: "Or open your agent conversations as graphs" on the start page, or "All canvases & sessions…" in the canvas menu (top left).');
  console.log('Let Claude Code or Codex edit the canvas, and open the current session with /weft ($weft in Codex): run `weft setup skill --apply` in your project; for editing, also tick the box in the canvas\'s host handoff panel (bottom right) that allows local agents to edit it.');
  if (process.env.WEFT_SERVE_VERBOSE) { child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr); }
  if (open) openBrowser(url);
  const stop = (): void => { child.kill('SIGTERM'); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  const code = await exited;
  if (code !== 0 && !child.signalCode) {
    console.error(`the canvas server stopped (exit ${code}):\n${log.join('').trim()}`);
    process.exitCode = 1;
  }
}

async function setupStatus(): Promise<string[]> {
  const notes: string[] = [];
  try { const c = JSON.parse(await fsp.readFile(path.join(process.cwd(), '.mcp.json'), 'utf8')) as { mcpServers?: Record<string, unknown> }; notes.push(`claude-code mcp (project): ${c.mcpServers?.weft ? 'registered' : 'not registered'}`); } catch { notes.push('claude-code mcp (project): not registered'); }
  try { const t = await fsp.readFile(path.join(os.homedir(), '.codex', 'config.toml'), 'utf8'); notes.push(`codex mcp: ${/^\[mcp_servers\.weft\]/m.test(t) ? 'registered' : 'not registered'}`); } catch { notes.push('codex mcp: not registered'); }
  for (const name of ['CLAUDE.md', 'AGENTS.md']) {
    try { const t = await fsp.readFile(path.join(process.cwd(), name), 'utf8'); notes.push(`${name}: ${t.includes(RULES_BEGIN) ? 'rules present' : 'no rules'}`); } catch { notes.push(`${name}: absent`); }
  }
  return notes;
}

// ─── main ────────────────────────────────────────────────────────────

const USAGE = `Weft — the why layer

  weft serve [--port N] [--no-open]          open the canvas app in the browser (local server on 127.0.0.1, default port ${DEFAULT_PORT})
  weft open <session-id | weft://link> [--port N]
                                                   open a Claude Code / Codex / Pi session (or a why hit) in the canvas; starts the server in the background if needed
  weft stop                                  stop the background server weft open started
  weft graph <command> [options]            native graph / workspace file exchange; graph --help (no index or history access)
  weft index [--full] [--canvas <dir>]       build or refresh the index (--canvas: also read canvas backups in <dir>, remembered)
  weft why <path> [--include-read] [--all] [--limit N] [--json]
                                                   the turns that touched a file, and what they said
  weft why --check <path> [--fresh] [--json]  one line: is there history here? exit 0 yes, 1 no (cheap; refreshes only a stale index)
  weft find "<phrase>" [--in q|a|m] [--limit N] [--json]
                                                   the turns where those words were asked (Q), answered (A) or attached (M)
  weft recall <session> <n>                  one turn in full (session id or prefix); a memory entry by its memory id
  weft memories                              the memory files the index holds (Claude Code memory directories, Codex memories)
  weft suggest <term> [--limit N] [--json]   what a mistyped term could have meant: near words from the indexed text
  weft topics [--of <id>] [--json]           the topic table and its labels (named and labelled from the app)
  weft status                                what the index holds, and how much is evidence
  weft --version                             print the CLI version
  weft purge [--cache]                       delete everything this tool stored (--cache: only the interpretation and text caches)
  weft events <session-file> [--touches]     the canonical events of one source file, one JSON per line
  weft bundle publish --file <canvas.weft.json> --node <id> [--tag name]
                                                   compile one node's context into a portable bundle under ~/.weft/bundles/<id>/
                                                   (the same markdown the in-app "Copy context for a CLI session" puts on the clipboard)
  weft bundle pull <id|tag> [-o out.md]          print the bundle's opening message; write it to a file with -o
  weft bundle list [--json]                      every stored bundle, newest last
  weft bundle show <id|tag> [--json]             one bundle's graph anchor, budget, and content hash
  weft mcp                                   serve why_check / why_file / find / recall_turn over MCP (stdio, read-only)
  weft setup [mcp | rules [--remove]]        register the MCP server (this project + Codex), add/remove the two rules in this project's CLAUDE.md and AGENTS.md; bare: show status
  weft setup skill [--hosts codex claude dsh] [--apply]
                                                   install the canvas skill into this project (.agents/.claude/.dsh skills) and the session-opening
                                                   commands /weft (Claude Code) and $weft (Codex) for this user; dry run unless --apply
`;

async function main(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  const flag = (name: string): boolean => rest.includes(`--${name}`);
  const value = (name: string): string | undefined => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : undefined; };
  const shortValue = (name: string): string | undefined => { const i = rest.indexOf(`-${name}`); return i >= 0 ? rest[i + 1] : undefined; };
  const args = rest.filter((a, i) => !a.startsWith('--') && !(i > 0 && (rest[i - 1] === '--limit' || rest[i - 1] === '--canvas' || rest[i - 1] === '--in')));

  if (cmd === '--version' || cmd === '-v' || cmd === 'version') {
    console.log(CLI_VERSION);
    return;
  }
  if (cmd === 'index') {
    const r = await buildIndex(flag('full'), value('canvas'));
    const st = summarize(await loadFacts(), await loadCache());
    console.log(`indexed ${r.parsed} session${r.parsed === 1 ? '' : 's'} (${r.kept} unchanged, ${r.skipped} not sessions, ${r.removed} gone) in ${r.seconds.toFixed(1)}s`);
    if (indexLib.zstdSkipped) console.error(`${indexLib.zstdSkipped} DeepSeek Harness log${indexLib.zstdSkipped === 1 ? '' : 's'} skipped: this Node (${process.version}) has no zstd; 22.15 or newer reads them`);
    console.log(`${st.sessions} sessions in ${st.sources} files · ${st.turns} turns · ${artifactsLine(st.artifacts)} · ${HOME}`);
    return;
  }
  if (cmd === 'status') {
    const facts = await loadFacts();
    if (!facts.builtAt) { console.log('no index yet — run: weft index'); return; }
    const st = summarize(facts, await loadCache());
    const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : '–');
    console.log(`${st.sessions} sessions in ${st.sources} files · ${st.turns} turns · ${artifactsLine(st.artifacts)} · built ${facts.builtAt.slice(0, 16).replace('T', ' ')}`);
    console.log(`evidence: ${st.touches} touches · ${st.changes} edits/writes, ${st.withChangeHead} with an observed change head (${pct(st.withChangeHead, st.changes)} of changes, ${pct(st.withChangeHead, st.touches)} of touches) · ${st.withMention} answers name the file (${pct(st.withMention, st.touches)}, candidates only)`);
    if (st.memoryFiles) console.log(`memories: ${st.memoryFiles} file${st.memoryFiles === 1 ? '' : 's'} · ${st.memoryEntries} entr${st.memoryEntries === 1 ? 'y' : 'ies'} (Claude Code memory directories, Codex memories) · find and recall answer over them too`);
    console.log(`store: ${HOME} (0700) · fact-index.json + interpretation-cache.json + text-index.jsonl (0600)`);
    return;
  }
  if (cmd === 'suggest') {
    // what a mistyped search term could have meant, from the indexed text itself
    if (!args[0]) { console.error(USAGE); process.exit(2); }
    const r = await suggestJson(args[0], Number(value('limit') ?? 8) || 8);
    if (flag('json')) { console.log(JSON.stringify(r)); return; }
    if (r.known) console.log(`"${r.term}" occurs ${r.known} time${r.known === 1 ? '' : 's'} as written`);
    if (!r.suggestions.length) { console.log(r.known ? '' : `nothing within reach of "${r.term}"`); return; }
    for (const s of r.suggestions) console.log(`  ${s.term}  ×${s.count}  (${s.distance} edit${s.distance === 1 ? '' : 's'})`);
    return;
  }
  if (cmd === 'topics') {
    // the topic table and how much of the index carries labels; --of <id> lists a topic's turns
    const of = value('of');
    if (of) { const r = await byTopicJson([of], { limit: Number(value('limit') ?? 20) || 20 }); if (flag('json')) { console.log(JSON.stringify(r)); return; } console.log(`${r.total} turns`); for (const h of r.hits) console.log(`${(h.at ?? '').slice(0, 10)}  ${h.runner}  「${h.title.slice(0, 50)}」  #${h.turn}  ${Object.entries(h.topics).map(([k, p]) => `${k}=${p}`).join(' ')}`); return; }
    const r = await topicsJson();
    if (flag('json')) { console.log(JSON.stringify(r)); return; }
    if (!r.topics.length) { console.log('no topics yet — name them in the app (memory page), then label'); return; }
    for (const t of r.topics) console.log(`${t.id}  ${t.name}  ×${t.count}${t.description ? `  — ${t.description}` : ''}`);
    console.log(`labelled ${r.labeled} of ${r.turns} turns${r.status.running ? ` (running: ${r.status.done}/${r.status.total})` : ''}`);
    return;
  }
  if (cmd === 'memories') {
    // the memory files the index holds: a look at what the two agents wrote down
    const files = await memoriesJson();
    if (!files.length) { console.log('no memory files indexed (Claude Code keeps them under ~/.claude/projects/<project>/memory/, Codex under ~/.codex/memories/)'); return; }
    for (const m of files) console.log(`${m.id}  ${m.runner}  ${m.entries} entr${m.entries === 1 ? 'y' : 'ies'}  「${m.title}」${m.cwd ? `  ${m.cwd}` : ''}\n    ${m.file}`);
    return;
  }
  if (cmd === 'purge') {
    // --cache drops only the interpretation; the next index recomputes it
    const targets = flag('cache') ? [CACHE_FILE, TEXT_FILE, TEXT_LINES] : [FACT_FILE, CACHE_FILE, TEXT_FILE, TEXT_LINES, LEGACY_FILE, LOCK_FILE];
    let n = 0;
    for (const f of targets) {
      try { await fsp.rm(f); n++; } catch { /* absent */ }
    }
    // leftovers of interrupted writes
    for (const name of await fsp.readdir(HOME).catch(() => [] as string[])) {
      if (/\.tmp$/.test(name)) { await fsp.rm(path.join(HOME, name), { force: true }).catch(() => undefined); }
    }
    console.log(`removed ${n} file${n === 1 ? '' : 's'} from ${HOME}`);
    return;
  }
  if (cmd === 'why' && flag('check')) {
    if (!args[0]) { console.error(USAGE); process.exit(2); }
    const facts = await factsForCheck(flag('fresh'));
    if (!facts.builtAt) { console.error('no index yet — run: weft index'); process.exit(1); }
    const { path: file } = await resolveQuery(facts, args[0], flag('all'));
    const hits = file ? hitsFor(facts, file, true).hits : [];
    const r = renderCheck(facts, args[0], file, hits, flag('json'));
    console.log(r.text);
    process.exit(r.has ? 0 : 1);
  }
  if (cmd === 'why') {
    if (!args[0]) { console.error(USAGE); process.exit(2); }
    const facts = flag('no-refresh') ? await loadFacts() : await ensureFresh();
    if (!facts.builtAt) { console.error('no index yet — run: weft index'); process.exit(1); }
    const { path: file, candidates, elsewhere } = await resolveQuery(facts, args[0], flag('all'));
    if (!file) {
      if (candidates.length === 0) {
        console.log(elsewhere
          ? `why ${args[0]}  ·  no match in this workspace (${elsewhere} elsewhere, --all to include)`
          : `why ${args[0]}  ·  no session touched this file`);
        return;
      }
      console.log(`${candidates.length} files match "${args[0]}" — pick one:\n`);
      for (const c of candidates.slice(0, 20)) console.log(`  ${c}`);
      return;
    }
    const { hits, readsHidden } = hitsFor(facts, file, flag('include-read'));
    console.log(await renderWhy(facts, file, hits, readsHidden, await loadCache(), Number(value('limit') ?? 10) || 10, flag('json')));
    return;
  }
  if (cmd === 'mcp') return serveMcp();
  if (cmd === 'serve') {
    const port = Number(value('port') ?? process.env.WEFT_PORT ?? DEFAULT_PORT);
    if (!Number.isInteger(port) || port < 1 || port > 65535) { console.error('--port must be 1-65535'); process.exit(2); }
    return serveApp(port, !flag('no-open'));
  }
  if (cmd === 'open') {
    const port = Number(value('port') ?? process.env.WEFT_PORT ?? DEFAULT_PORT);
    if (!Number.isInteger(port) || port < 1 || port > 65535) { console.error('--port must be 1-65535'); process.exit(2); }
    const ref = rest.find((a, i) => !a.startsWith('--') && rest[i - 1] !== '--port');
    if (!ref) { console.error(USAGE); process.exit(2); }
    return openInBrowser(ref, port);
  }
  if (cmd === 'stop') return stopBackground();
  if (cmd === 'setup') {
    const what = args[0];
    if (what === 'skill') return setupSkill(rest);
    const notes = what === 'mcp' ? await setupMcp() : what === 'rules' ? await setupRules(flag('remove')) : await setupStatus();
    for (const n of notes) console.log(n);
    return;
  }
  if (cmd === 'events') {
    if (!args[0]) { console.error(USAGE); process.exit(2); }
    const r = await eventsOf(path.resolve(process.cwd(), args[0]));
    if (!r) { console.error('not a session file'); process.exit(1); }
    if (flag('touches')) { for (const t of deriveTouches(r.events)) console.log(JSON.stringify(t)); return; }
    console.log(JSON.stringify({ kind: 'adapter.manifest', ...r.manifest }));
    for (const e of r.events) console.log(JSON.stringify(e));
    return;
  }
  if (cmd === 'bundle') {
    const sub = args[0];
    const bundle = await import('./bundle');
    const { renderHandoffMarkdown } = bundle;
    if (sub === 'publish') {
      const file = value('file');
      const nodeId = value('node');
      const tag = value('tag') ?? null;
      if (!file || !nodeId) { console.error(USAGE); process.exit(2); }
      const { compileContextBundle } = await import('../../src/lib/context-bundle');
      const text = readFileSync(path.resolve(process.cwd(), file), 'utf8');
      const canvas = JSON.parse(text) as { name?: string; projectId?: string; nodes?: unknown[]; edges?: unknown[] };
      if (!Array.isArray(canvas.nodes) || !Array.isArray(canvas.edges)) {
        console.error(`not a Weft canvas: ${file} (expected {nodes:[], edges:[], ...})`); process.exit(1);
      }
      const nodes = canvas.nodes as Parameters<typeof compileContextBundle>[1];
      const edges = canvas.edges as Parameters<typeof compileContextBundle>[2];
      if (!nodes.some((n) => n.id === nodeId)) { console.error(`no node "${nodeId}" in ${file}`); process.exit(1); }
      const project = canvas.projectId ?? 'default';
      // stale judge is a UI concern; at rest the canvas already tells the truth
      const b = await compileContextBundle(nodeId, nodes, edges, {
        now: new Date().toISOString(),
        projectId: project,
      });
      const anchor = { project, node: nodeId, bundle: b.id, mode: 'branch' as const };
      const md = renderHandoffMarkdown(b, anchor);
      const json = JSON.stringify(b);
      const rec = await bundle.saveBundle({ id: b.id, json, markdown: md, tag });
      console.log(`${b.id}${tag ? `  (tag: ${tag})` : ''}`);
      console.log(`  ${rec.jsonPath}`);
      console.log(`  ${rec.mdPath}`);
      console.log(`  ~${b.budget.estimated_tokens} tokens · ${b.context.messages.length} messages · sha256:${b.integrity.content_hash.slice(7, 23)}…`);
      return;
    }
    if (sub === 'pull') {
      const ref = rest.find((a, i) => !a.startsWith('--') && i > 0 && rest[i - 1] === 'pull');
      if (!ref) { console.error(USAGE); process.exit(2); }
      const { id } = await bundle.resolveRef(ref);
      const md = await bundle.readBundleMarkdown(id);
      const out = shortValue('o') ?? value('output');
      if (out) {
        writeFileSync(path.resolve(process.cwd(), out), md, { mode: 0o600 });
        console.log(`${id} → ${out}`);
      } else {
        process.stdout.write(md);
      }
      return;
    }
    if (sub === 'list') {
      const rows = await bundle.listBundles();
      if (flag('json')) { console.log(JSON.stringify(rows, null, 2)); return; }
      if (rows.length === 0) { console.log('no bundles yet — publish one from a canvas .weft.json'); return; }
      for (const r of rows) {
        const tags = r.tags.length ? `  [${r.tags.join(' ')}]` : '';
        const when = (r.created_at ?? '').slice(0, 16).replace('T', ' ');
        console.log(`${r.id}  ${when}  ${r.project ?? ''}#${r.target_node ?? ''}  ~${r.estimated_tokens ?? '?'} tok${tags}`);
      }
      return;
    }
    if (sub === 'show') {
      const ref = rest.find((a, i) => !a.startsWith('--') && i > 0 && rest[i - 1] === 'show');
      if (!ref) { console.error(USAGE); process.exit(2); }
      const { id } = await bundle.resolveRef(ref);
      const json = JSON.parse(await bundle.readBundleJson(id)) as {
        id: string; created_at: string; graph: { project_id: string | null; target_node_id: string };
        budget: { estimated_tokens: number }; context: { messages: unknown[] };
        integrity: { content_hash: string };
      };
      if (flag('json')) { console.log(JSON.stringify(json, null, 2)); return; }
      console.log(`${json.id}  created ${json.created_at.slice(0, 16).replace('T', ' ')}`);
      console.log(`  graph: ${json.graph.project_id ?? 'default'}#${json.graph.target_node_id}`);
      console.log(`  ${json.context.messages.length} messages · ~${json.budget.estimated_tokens} tokens`);
      console.log(`  ${json.integrity.content_hash}`);
      return;
    }
    console.error(USAGE);
    process.exit(2);
  }
  if (cmd === 'find') {
    if (!args[0]) { console.error(USAGE); process.exit(2); }
    const facts = flag('no-refresh') ? await loadFacts() : await ensureFresh();
    if (!facts.builtAt) { console.error('no index yet — run: weft index'); process.exit(1); }
    const scope = value('in') === 'q' ? 'q' : value('in') === 'a' ? 'a' : value('in') === 'm' ? 'm' : 'all';
    console.log(renderFind(facts, args[0], await findHits(facts, args[0], scope), Number(value('limit') ?? 10) || 10, flag('json')));
    return;
  }
  if (cmd === 'recall') {
    if (!args[0] || args[1] === undefined) { console.error(USAGE); process.exit(2); }
    console.log(await renderRecall(await ensureFresh(), args[0], Number(args[1])));
    return;
  }
  console.log(USAGE);
  if (cmd && cmd !== 'help' && cmd !== '--help') process.exit(2);
}

await main(process.argv.slice(2));
}

const graphCommand = process.argv[2] === 'graph';
async function dispatch(): Promise<void> {
  if (graphCommand) {
    process.argv.splice(2, 1);
    await import('../../scripts/host-handoff');
    return;
  }
  await runIndexCli();
}

dispatch().catch((err: unknown) => {
  if (!graphCommand) {
    console.error(err instanceof Error ? err.message : String(err));
  } else {
    process.stderr.write(JSON.stringify({ ok: false, error: {
      code: (err as NodeJS.ErrnoException)?.code ?? 'ERROR',
      message: err instanceof Error ? err.message : String(err),
    } }) + '\n');
  }
  process.exitCode = 1;
});

