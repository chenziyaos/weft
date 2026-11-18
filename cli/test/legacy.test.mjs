// Data and config written under the product's previous name move once to
// the Weft locations; nothing old is read afterwards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'weft.mjs');
const tmp = mkdtempSync(join(tmpdir(), 'td-legacy-'));
const home = join(tmp, 'fakehome'); const proj = join(tmp, 'proj');
const old = join(home, '.thoughtpath');
mkdirSync(join(old, 'canvases'), { recursive: true });
mkdirSync(join(old, 'workspaces', 'w1', '.thoughtpath'), { recursive: true });
mkdirSync(proj, { recursive: true });
writeFileSync(join(old, 'canvases', 'p1.thoughtpath.json'), JSON.stringify({ runner: 'thoughtpath', note: 'see thoughtpath://open?canvas=p1, a thoughtpath remark' }));
writeFileSync(join(old, 'config.json'), JSON.stringify({ canvasRoots: ['/x'] }));
writeFileSync(join(old, 'workspaces', 'w1', '.thoughtpath', 'guard.json'), '{"mode":"allow","allow":[]}');
mkdirSync(join(home, '.codex'), { recursive: true });
writeFileSync(join(home, '.codex', 'config.toml'), 'model = "gpt"\n\n# ThoughtPath — the why layer (added by `thoughtpath setup mcp`)\n[mcp_servers.thoughtpath]\ncommand = "thoughtpath"\nargs = ["mcp"]\n\n[mcp_servers.other]\ncommand = "o"\n');
writeFileSync(join(proj, '.mcp.json'), JSON.stringify({ mcpServers: { thoughtpath: { command: 'thoughtpath', args: ['mcp'] }, other: { command: 'o' } } }));
writeFileSync(join(proj, 'CLAUDE.md'), '# Mine\n\n<!-- thoughtpath:begin -->\n## ThoughtPath\n- old rule\n<!-- thoughtpath:end -->\n');
const env = { ...process.env, HOME: home };
delete env.WEFT_HOME;
const run = (...a) => execFileSync(process.execPath, [CLI, ...a], { env, cwd: proj, encoding: 'utf8' });

test('the old home moves to ~/.weft with canvas records renamed and ids rewritten', () => {
  run('status');
  assert.ok(!existsSync(old));
  const canvas = JSON.parse(readFileSync(join(home, '.weft', 'canvases', 'p1.weft.json'), 'utf8'));
  assert.equal(canvas.runner, 'weft');
  assert.equal(canvas.note, 'see weft://open?canvas=p1, a thoughtpath remark', 'prose is left alone');
  assert.deepEqual(JSON.parse(readFileSync(join(home, '.weft', 'config.json'), 'utf8')), { canvasRoots: ['/x'] });
  assert.ok(existsSync(join(home, '.weft', 'workspaces', 'w1', '.weft', 'guard.json')));
});

test('an explicit WEFT_HOME never adopts the old home', () => {
  mkdirSync(join(home, '.thoughtpath'), { recursive: true });
  execFileSync(process.execPath, [CLI, 'status'], { env: { ...env, WEFT_HOME: join(tmp, 'own') }, cwd: proj, encoding: 'utf8' });
  assert.ok(existsSync(join(home, '.thoughtpath')));
  rmSync(join(home, '.thoughtpath'), { recursive: true });
});

test('setup drops the old MCP entries and rules block while registering the new ones', () => {
  run('setup', 'mcp');
  const toml = readFileSync(join(home, '.codex', 'config.toml'), 'utf8');
  assert.ok(!/thoughtpath|ThoughtPath/.test(toml));
  assert.match(toml, /\[mcp_servers\.other\]/); assert.match(toml, /\[mcp_servers\.weft\]/);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(proj, '.mcp.json'), 'utf8')).mcpServers).sort(), ['other', 'weft']);
  run('setup', 'rules');
  const claude = readFileSync(join(proj, 'CLAUDE.md'), 'utf8');
  assert.ok(!claude.includes('thoughtpath'));
  assert.match(claude, /^# Mine\n\n<!-- weft:begin -->/);
  rmSync(tmp, { recursive: true, force: true });
});
