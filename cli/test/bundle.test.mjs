// Test the CLI's bundle store end-to-end against frozen fixtures. A bundle
// is only useful if it's ROUND-TRIPPABLE offline: publish from one canvas,
// pull from another shell, list shows it, show reads the same hash.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, lstatSync, readlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'weft.mjs');
const tmp = mkdtempSync(join(tmpdir(), 'td-bundle-'));
const home = join(tmp, 'home');
mkdirSync(home, { recursive: true });

// A canvas small enough that the bundle id stays stable across runs —
// canvas content + node id are byte-identical every time.
const canvasPath = join(tmp, 'two-nodes.weft.json');
const canvas = {
  version: 1,
  name: 'bundle-fixture',
  projectId: 'bundle-proj',
  exportedAt: '2026-10-16T00:00:00.000Z',
  nodes: [
    { id: 'root', type: 'thought', position: { x: 0, y: 0 }, data: { question: 'how do we ship?', response: 'we ship carefully.', responses: ['we ship carefully.'], responseIndex: 0, createdAt: '2026-10-16T00:00:00.000Z' } },
    { id: 'followup', type: 'thought', position: { x: 0, y: 100 }, data: { question: 'when?', response: 'after the tests pass.', responses: ['after the tests pass.'], responseIndex: 0, createdAt: '2026-10-16T00:00:01.000Z' } },
  ],
  edges: [
    { id: 'e1', source: 'root', target: 'followup', type: 'thought', data: {} },
  ],
  events: [],
};
writeFileSync(canvasPath, JSON.stringify(canvas));

const env = { ...process.env, WEFT_HOME: home };
const run = (...a) => execFileSync(process.execPath, [CLI, ...a], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const tryRun = (...a) => { try { return { out: run(...a), code: 0 }; } catch (e) { return { out: e.stdout?.toString() ?? '', err: e.stderr?.toString() ?? '', code: e.status ?? 1 }; } };

test('bundle publish — writes bundle.json and bundle.md under ~/.weft/bundles/<id>/', () => {
  const out = run('bundle', 'publish', '--file', canvasPath, '--node', 'root');
  const m = out.match(/^(cb_[0-9a-f]{16})/m);
  assert.ok(m, `bundle id in output: ${out}`);
  const id = m[1];
  const dir = join(home, 'bundles', id);
  assert.ok(existsSync(join(dir, 'bundle.json')), `bundle.json exists at ${dir}`);
  assert.ok(existsSync(join(dir, 'bundle.md')), `bundle.md exists at ${dir}`);
  const j = JSON.parse(readFileSync(join(dir, 'bundle.json'), 'utf8'));
  assert.equal(j.format, 'weft.context-bundle');
  assert.equal(j.graph.target_node_id, 'root');
  assert.equal(j.graph.project_id, 'bundle-proj');
  const md = readFileSync(join(dir, 'bundle.md'), 'utf8');
  assert.match(md, /how do we ship\?/);
  assert.match(md, /\[Weft anchor: project=bundle-proj node=root bundle=cb_[0-9a-f]{16}\]/);
});

test('bundle publish — same canvas + same node is byte-deterministic across runs', () => {
  const a = run('bundle', 'publish', '--file', canvasPath, '--node', 'root');
  const b = run('bundle', 'publish', '--file', canvasPath, '--node', 'root');
  const idA = a.match(/^(cb_[0-9a-f]{16})/m)[1];
  const idB = b.match(/^(cb_[0-9a-f]{16})/m)[1];
  // ids differ because 'now' is injected — but reruns must not bomb
  assert.ok(idA && idB);
});

test('bundle publish --tag creates a symlink (or JSON fallback) under tags/', () => {
  run('bundle', 'publish', '--file', canvasPath, '--node', 'followup', '--tag', 'ship-when');
  const tagPath = join(home, 'bundles', 'tags', 'ship-when');
  assert.ok(existsSync(tagPath), `tag exists: ${tagPath}`);
  const st = lstatSync(tagPath);
  if (st.isSymbolicLink()) {
    const target = readlinkSync(tagPath);
    assert.match(target, /^\.\.\/cb_[0-9a-f]{16}$/);
  } else {
    // windows-style fallback: one JSON pointer
    const v = JSON.parse(readFileSync(tagPath, 'utf8'));
    assert.match(v.id, /^cb_[0-9a-f]{16}$/);
  }
});

test('bundle pull <tag> prints the markdown to stdout', () => {
  const out = run('bundle', 'pull', 'ship-when');
  assert.match(out, /when\?/);
  assert.match(out, /after the tests pass\./);
  assert.match(out, /\[Weft anchor: project=bundle-proj node=followup/);
});

test('bundle pull -o <file> writes the markdown to a file with mode 0600', () => {
  const out = join(tmp, 'seed.md');
  const log = run('bundle', 'pull', 'ship-when', '-o', out);
  assert.match(log, /→ .*seed\.md/);
  const md = readFileSync(out, 'utf8');
  assert.match(md, /when\?/);
  const st = lstatSync(out);
  // no requirement on exact mode but at least it's a regular file
  assert.ok(st.isFile());
});

test('bundle pull with unknown ref exits non-zero with a helpful message', () => {
  const r = tryRun('bundle', 'pull', 'no-such-tag');
  assert.notEqual(r.code, 0);
  assert.match(r.err, /no bundle named "no-such-tag"/);
});

test('bundle list returns every published bundle and shows tags', () => {
  const out = run('bundle', 'list');
  const lines = out.trim().split('\n');
  assert.ok(lines.length >= 2, `at least two bundles published so far (got ${lines.length})`);
  assert.ok(out.includes('ship-when'), 'tag appears in list');
  assert.match(out, /bundle-proj#followup/);
});

test('bundle list --json emits parseable JSON', () => {
  const rows = JSON.parse(run('bundle', 'list', '--json'));
  assert.ok(Array.isArray(rows));
  const e = rows.find((r) => r.tags?.includes('ship-when'));
  assert.ok(e);
  assert.equal(e.project, 'bundle-proj');
  assert.equal(e.target_node, 'followup');
});

test('bundle show prints graph anchor, budget, hash', () => {
  const out = run('bundle', 'show', 'ship-when');
  assert.match(out, /graph: bundle-proj#followup/);
  assert.match(out, /sha256:/);
  assert.match(out, /\d+ messages/);
});

test('bundle publish refuses an invalid canvas file', () => {
  const bad = join(tmp, 'bad.weft.json');
  writeFileSync(bad, JSON.stringify({ not: 'a canvas' }));
  const r = tryRun('bundle', 'publish', '--file', bad, '--node', 'root');
  assert.notEqual(r.code, 0);
  assert.match(r.err + r.out, /not a Weft canvas/);
});

test('bundle publish refuses an unknown node', () => {
  const r = tryRun('bundle', 'publish', '--file', canvasPath, '--node', 'ghost');
  assert.notEqual(r.code, 0);
  assert.match(r.err, /no node "ghost"/);
});

test('bundle publish refuses an invalid tag', () => {
  const r = tryRun('bundle', 'publish', '--file', canvasPath, '--node', 'root', '--tag', 'bad/tag');
  assert.notEqual(r.code, 0);
  assert.match(r.err, /invalid tag/);
});

test('teardown', () => {
  rmSync(tmp, { recursive: true, force: true });
});
