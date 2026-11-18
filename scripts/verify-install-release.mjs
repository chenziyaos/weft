#!/usr/bin/env node
// Runtime acceptance only: spawn public CLIs; never import product internals.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, mkdtemp, readdir, lstat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const evidence = resolve(process.argv[2] || join(root, `evidence-install-release-${Date.now()}`));
await mkdir(evidence, { recursive: true });
const run = await mkdtemp(join(evidence, 'run-'));
const project = join(run, 'existing-project');
const home = join(run, 'external-home');
await mkdir(project);
await mkdir(home);
const env = { PATH: process.env.PATH || '/usr/bin:/bin', HOME: home,
  XDG_CONFIG_HOME: join(home, '.config'), CODEX_HOME: join(home, '.codex'),
  CLAUDE_CONFIG_DIR: join(home, '.claude'), DSH_HOME: join(home, '.dsh'),
  LANG: 'C.UTF-8', NO_COLOR: '1' };
const checks = [];
const commands = [];
const installed = [];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const save = async (name, value) => writeFile(join(run, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
function check(name, ok, details = {}) {
  checks.push({ name, status: ok ? 'PASS' : 'FAIL', ...details });
  if (!ok) throw new Error(name);
}
async function snapshot(path) {
  const entries = [];
  async function walk(dir, prefix = '') {
    for (const name of (await readdir(dir)).sort()) {
      const relative = prefix ? `${prefix}/${name}` : name;
      const full = join(dir, name);
      const stat = await lstat(full);
      if (stat.isSymbolicLink()) throw new Error(`Unexpected symlink: ${full}`);
      if (stat.isDirectory()) {
        entries.push({ path: relative, type: 'directory', mode: stat.mode });
        await walk(full, relative);
      } else {
        const bytes = await readFile(full);
        entries.push({ path: relative, type: 'file', bytes: bytes.length, sha256: sha256(bytes), mode: stat.mode, mtimeMs: stat.mtimeMs });
      }
    }
  }
  await walk(path);
  return entries;
}
async function command(label, executable, args, expected = 0) {
  const result = spawnSync(executable, args, { cwd: project, env, encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
  const record = { label, executable, args, cwd: project, status: result.status, signal: result.signal,
    error: result.error?.message, stdout: result.stdout || '', stderr: result.stderr || '' };
  commands.push(record);
  await save(`${String(commands.length).padStart(2, '0')}-${label}.json`, record);
  check(`${label}: exit ${expected}`, result.status === expected && !result.signal && !result.error);
  return record;
}
async function cli(label, script, args, expected = 0, writes = false) {
  // Enforce no writes for dry-run/help/inspect. Apply's ancestor mkdir calls
  // need ordinary Node; isolate HOME and compare project/config snapshots.
  const flags = writes ? [] : ['--permission', '--allow-fs-read=*'];
  return command(label, process.execPath, [...flags, script, ...args], expected);
}
const installer = join(root, 'scripts/install-skill.mjs');
const hosts = { codex: '.agents', claude: '.claude', dsh: '.dsh' };
const sourcePaths = {
  'SKILL.md': join(root, 'skill/weft-canvas/SKILL.md'),
  LICENSE: join(root, 'LICENSE'),
  'scripts/host-handoff.mjs': join(root, 'host-dist/host-handoff.mjs'),
  'scripts/weft.mjs': join(root, 'host-dist/weft.mjs'),
};
let sourceManifest, baselineHome, lockChanges;
try {
  const pkg = await json(join(root, 'package.json'));
  const lock = await json(join(root, 'package-lock.json'));
  check('release metadata matches package.json', lock.version === pkg.version && lock.packages[''].version === pkg.version && isDeepStrictEqual(lock.packages[''].bin, pkg.bin), { version: pkg.version, bin: pkg.bin });
  const beforePath = join(evidence, 'package-lock.before.json');
  let beforeText;
  try { beforeText = await readFile(beforePath, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (beforeText !== undefined) {
    const before = JSON.parse(beforeText);
    const expected = structuredClone(before);
    expected.version = pkg.version;
    expected.packages[''].version = pkg.version;
    expected.packages[''].bin = pkg.bin;
    check('only root version, package root version and bin changed', isDeepStrictEqual(lock, expected));
    const actualText = await readFile(join(root, 'package-lock.json'), 'utf8');
    const expectedText = beforeText
      .replace('  "version": "0.1.0",', '  "version": "0.2.0",')
      .replace('      "version": "0.1.0",', '      "version": "0.2.0",')
      .replace('      "devDependencies": {', '      "bin": {\n        "weft": "cli/dist/weft.mjs"\n      },\n      "devDependencies": {');
    check('lock text is exactly two replacements plus bin insertion', actualText === expectedText);
    lockChanges = [
      { path: '/version', before: before.version, after: lock.version },
      { path: '/packages//version', before: before.packages[''].version, after: lock.packages[''].version },
      { path: '/packages//bin', before: before.packages[''].bin ?? null, after: lock.packages[''].bin },
    ];
    const diff = spawnSync('diff', ['-u', beforePath, join(root, 'package-lock.json')], { encoding: 'utf8' });
    await writeFile(join(run, 'package-lock.diff'), diff.stdout || '', { flag: 'wx' });
    await save('lock-changes.json', lockChanges);
  }
  sourceManifest = await Promise.all(Object.entries(sourcePaths).map(async ([path, source]) => {
    const bytes = await readFile(source);
    return { path, source, bytes: bytes.length, sha256: sha256(bytes) };
  }));
  await save('current-source-manifest.json', sourceManifest);
  const protectedFiles = ['package.json', 'package-lock.json', 'scripts/install-skill.mjs', ...Object.values(sourcePaths).map(path => path.slice(root.length + 1))];
  const protectedBefore = await Promise.all(protectedFiles.map(async path => ({ path, sha256: sha256(await readFile(join(root, path))) })));
  await save('protected-files-before.json', protectedBefore);
  const hostPresence = {};
  for (const host of Object.keys(hosts)) {
    const result = spawnSync('/bin/sh', ['-c', `command -v ${host}`], { env, cwd: project, encoding: 'utf8' });
    hostPresence[host] = { command: `command -v ${host}`, status: result.status, stdout: result.stdout, stderr: result.stderr,
      acceptance: 'NOT_VERIFIED', reason: 'Host discovery/execution is out of scope; no host installed or launched.' };
  }
  await save('host-availability.json', hostPresence);
  for (const [path, content] of Object.entries({ '.codex/config.toml': '# acceptance sentinel\n', '.claude/settings.json': '{"acceptanceSentinel":true}\n', '.dsh/config.json': '{"acceptanceSentinel":true}\n' })) {
    await mkdir(dirname(join(home, path)), { recursive: true });
    await writeFile(join(home, path), content, { flag: 'wx' });
  }
  baselineHome = await snapshot(home);
  await save('external-config-before.json', baselineHome);
  // Synthetic user-created project identity, not an ID claimed from a real canvas export.
  const graph = { version: 1, name: 'Install release acceptance', projectId: 'install-release-fixture',
    exportedAt: '2026-10-10T00:00:00.000Z', nodes: [{ id: 'root', type: 'thought', position: { x: 0, y: 0 },
      data: { question: 'Can this installed CLI initialize and inspect a local workspace?', response: '', responses: [],
        responseIndex: 0, isCollapsed: false, isEditing: false, isEditingResponse: false, isLoading: false,
        tokenCount: 0, highlights: [], highlightMode: 'off', attachments: [], excludedAttachmentIds: [],
        includedAttachmentIds: [], roleMode: 'inherit', isRoot: true, isBranch: false } }], edges: [] };
  const graphPath = join(project, 'input.weft.json');
  await writeFile(graphPath, JSON.stringify(graph, null, 2) + '\n', { flag: 'wx' });
  const beforeDry = await snapshot(project);
  await save('project-before-dry-run.json', beforeDry);
  await cli('installer-help', installer, ['--help']);
  const args = ['--project', project, '--hosts', ...Object.keys(hosts)];
  const dry = JSON.parse((await cli('dry-run', installer, args)).stdout);
  const afterDry = await snapshot(project);
  await save('project-after-dry-run.json', afterDry);
  check('dry-run creates no directories and changes no files', isDeepStrictEqual(beforeDry, afterDry) && afterDry.every(item => item.type !== 'directory'));
  const expectedManifest = sourceManifest.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }));
  const sorted = manifest => [...manifest].sort((a, b) => a.path.localeCompare(b.path));
  check('dry-run manifest matches current sources', dry.ok === true && dry.dryRun === true && dry.configsChanged === false && isDeepStrictEqual(sorted(dry.manifest), sorted(expectedManifest)));
  for (const hostDir of Object.values(hosts)) {
    await mkdir(join(project, hostDir, 'skills', 'unrelated'), { recursive: true });
    await writeFile(join(project, hostDir, 'acceptance-config.json'), '{"keep":true}\n', { flag: 'wx' });
    await writeFile(join(project, hostDir, 'skills/unrelated/sentinel.txt'), 'keep existing skill\n', { flag: 'wx' });
  }
  const beforeApply = await snapshot(project);
  await save('project-before-apply.json', beforeApply);
  const apply = JSON.parse((await cli('apply-all-hosts', installer, [...args, '--apply'], 0, true)).stdout);
  check('apply manifest and destinations match dry-run', apply.ok === true && apply.dryRun === false && apply.configsChanged === false && isDeepStrictEqual(apply.destinations, dry.destinations) && isDeepStrictEqual(sorted(apply.manifest), sorted(expectedManifest)));
  const isInstalled = path => Object.values(hosts).some(dir => path === `${dir}/skills/weft-canvas` || path.startsWith(`${dir}/skills/weft-canvas/`));
  const afterApply = await snapshot(project);
  await save('project-after-apply.json', afterApply);
  check('apply preserves existing configs and unrelated project files', isDeepStrictEqual(beforeApply, afterApply.filter(item => !isInstalled(item.path))));
  for (const [host, dir] of Object.entries(hosts)) {
    const location = join(project, dir, 'skills/weft-canvas');
    const tree = await snapshot(location);
    check(`${host}: exactly four installed payload files`, isDeepStrictEqual(tree.filter(item => item.type === 'file').map(item => item.path).sort(), Object.keys(sourcePaths).sort()) && isDeepStrictEqual(tree.filter(item => item.type === 'directory').map(item => item.path), ['scripts']));
    for (const entry of expectedManifest) {
      const bytes = await readFile(join(location, entry.path));
      const actual = { host, path: join(location, entry.path), bytes: bytes.length, sha256: sha256(bytes) };
      installed.push(actual);
      check(`${host}: ${entry.path} bytes/hash/content match`, actual.bytes === entry.bytes && actual.sha256 === entry.sha256 && bytes.equals(await readFile(sourcePaths[entry.path])), actual);
    }
    const beforeRepeat = await snapshot(project);
    const refused = JSON.parse((await cli(`reject-existing-${host}`, installer, ['--project', project, '--hosts', host, '--apply'], 1, true)).stderr);
    check(`${host}: existing installation refuses without mutation`, refused.error?.code === 'OUTPUT_EXISTS' && isDeepStrictEqual(beforeRepeat, await snapshot(project)));
    const cliPath = join(location, 'scripts/weft.mjs');
    const help = await cli(`${host}-cli-help`, cliPath, ['--help']);
    check(`${host}: installed CLI advertises workspace commands`, help.stdout.includes('workspace-init') && help.stdout.includes('workspace-inspect'));
    await cli(`${host}-handoff-help`, join(location, 'scripts/host-handoff.mjs'), ['--help']);
    const workspacePath = join(project, `${host}.workspace.json`);
    const init = JSON.parse((await cli(`${host}-workspace-init`, cliPath, ['workspace-init', '--graph', graphPath, '--out', workspacePath], 0, true)).stdout);
    const inspection = JSON.parse((await cli(`${host}-workspace-inspect`, cliPath, ['workspace-inspect', '--workspace', workspacePath])).stdout);
    const workspace = await json(workspacePath);
    check(`${host}: init/inspect preserve fixture identity and revision`, init.ok === true && init.revision === 0 && inspection.ok === true && inspection.revision === 0 && workspace.revision === 0 && workspace.graph.projectId === graph.projectId && workspace.graph.nodes[0].id === 'root' && inspection.isolationVerified === false, { inspection });
  }
  const beforeProbes = await snapshot(project);
  const missing = JSON.parse((await cli('reject-missing-project', installer, ['--project', join(project, 'missing'), '--hosts', 'codex', '--apply'], 1, true)).stderr);
  check('missing project is refused, not created', missing.error?.code === 'ENOENT' && isDeepStrictEqual(beforeProbes, await snapshot(project)));
  const duplicate = JSON.parse((await cli('reject-duplicate-host', installer, ['--project', project, '--hosts', 'codex', 'codex'], 1)).stderr);
  check('duplicate host gives USAGE without mutation', duplicate.error?.code === 'USAGE' && isDeepStrictEqual(beforeProbes, await snapshot(project)));
  const afterHome = await snapshot(home);
  await save('external-config-after.json', afterHome);
  check('isolated external host configs unchanged', isDeepStrictEqual(baselineHome, afterHome));
  const protectedAfter = await Promise.all(protectedFiles.map(async path => ({ path, sha256: sha256(await readFile(join(root, path))) })));
  await save('protected-files-after.json', protectedAfter);
  check('source payloads, installer and package metadata unchanged during acceptance', isDeepStrictEqual(protectedBefore, protectedAfter));
} catch (error) {
  if (!checks.some(item => item.status === 'FAIL')) checks.push({ name: 'acceptance execution', status: 'FAIL', error: error.stack || String(error) });
} finally {
  await save('installed-manifest.json', installed);
  const summary = { verdict: checks.some(item => item.status === 'FAIL') ? 'FAIL' : 'PASS',
    counts: { pass: checks.filter(item => item.status === 'PASS').length, fail: checks.filter(item => item.status === 'FAIL').length,
      publicNodeCommands: commands.length, installedFilesVerified: installed.length, hostDiscoveryNotVerified: 3 },
    evidence: run, project, sourceManifest, lockChanges, checks,
    boundaries: { hostDiscovery: 'NOT_VERIFIED', hostExecution: 'NOT_VERIFIED', canvasImport: 'NOT_VERIFIED',
      realHomeConfigs: 'Not read. Child HOME isolated; external config sentinels and project snapshots compared. Read-only Node permissions on dry-run/help/inspect.',
      network: 'No network/model/listener commands invoked.', tests: 'Not run', typecheck: 'Not run', productImports: 'None', dependenciesInstalled: false } };
  await save('summary.json', summary);
  process.stdout.write(JSON.stringify({ verdict: summary.verdict, counts: summary.counts, evidence: run }, null, 2) + '\n');
  process.exitCode = summary.verdict === 'PASS' ? 0 : 1;
}
