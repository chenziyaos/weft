#!/usr/bin/env node
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rm } from 'node:fs/promises';
import { dirname, join, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LIMIT = 32 * 1024 * 1024;
const HOSTS = { codex: '.agents', claude: '.claude', dsh: '.dsh' };
const SKILL = 'weft-canvas';
// Earlier versions installed this skill as skills/weft, the name the /weft and
// $weft session commands use; such a directory is reported, never touched.
const LEGACY = 'weft';
const HELP = `Install the Weft manual native-graph handoff skill (Node >= 20)

  node scripts/install-skill.mjs --project EXISTING_PATH --hosts codex claude dsh
  node scripts/install-skill.mjs --project EXISTING_PATH --hosts codex claude --apply

Default: dry-run, no filesystem changes. --apply writes only new weft-canvas
skill directories under .agents/skills, .claude/skills or .dsh/skills.
An older install of this skill under the name weft is reported with the
command that removes it; it is not removed.
Refuses existing same-name directories, symlinks and oversized source files.
The project MUST already exist. No configs or existing skills are modified.
Requires skill/weft-canvas/SKILL.md, LICENSE and prebuilt
host-dist/host-handoff.mjs and host-dist/weft.mjs (npm run host:build).
Prints a SHA-256/byte manifest of only these four payload files, in both modes.
This installer does not build, fetch, scan history or modify host configs.
`;
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
async function checkPath(path, allowMissing = false) {
  const absolute = resolve(path), root = parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split('/').filter(Boolean)) {
    current = join(current, part);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) fail('SYMLINK', `Refusing symlink ${current}`);
      if (current !== absolute && !stat.isDirectory()) fail('NOT_DIRECTORY', `Not a directory: ${current}`);
    } catch (error) {
      if (allowMissing && error.code === 'ENOENT') return absolute;
      throw error;
    }
  }
  return absolute;
}
async function exists(path) {
  try { await lstat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
async function source(path) {
  await checkPath(path);
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await fd.stat();
    if (!stat.isFile() || stat.size > LIMIT) fail('INVALID_SOURCE', `Source must be a regular file <= ${LIMIT} bytes: ${path}`);
    const buffer = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await fd.read(buffer, offset, buffer.length - offset, null);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const after = await fd.stat();
    if (offset !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) fail('INPUT_CHANGED', `Source changed: ${path}`);
    return buffer.subarray(0, offset);
  } finally { await fd.close(); }
}
async function writeNew(path, bytes) {
  const fd = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await fd.writeFile(bytes); await fd.sync(); } finally { await fd.close(); }
}
async function ensureDirectories(path) {
  await checkPath(path, true);
  const root = parse(resolve(path)).root;
  let current = root;
  for (const part of resolve(path).slice(root.length).split('/').filter(Boolean)) {
    current = join(current, part);
    try { await mkdir(current); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('SYMLINK', `Unsafe directory: ${current}`);
  }
}
async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) { process.stdout.write(HELP); return; }
  let project, apply = false, sawApply = false, selected;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--project' && project === undefined) {
      project = argv[++i];
      if (!project || project.startsWith('--')) fail('USAGE', '--project requires an existing directory');
    } else if (argv[i] === '--apply' && !sawApply) { apply = true; sawApply = true; }
    else if (argv[i] === '--hosts' && selected === undefined) {
      selected = [];
      while (argv[i + 1] && !argv[i + 1].startsWith('--')) selected.push(argv[++i]);
      if (!selected.length) fail('USAGE', '--hosts requires codex, claude and/or dsh');
    } else fail('USAGE', `Unknown or duplicate option: ${argv[i]}`);
  }
  if (!project || !selected?.length) fail('USAGE', '--project and --hosts are required');
  if (new Set(selected).size !== selected.length || selected.some(h => !Object.hasOwn(HOSTS, h))) fail('USAGE', 'Hosts must be distinct choices from codex, claude, dsh');
  project = await checkPath(project);
  if (!(await lstat(project)).isDirectory()) fail('NOT_DIRECTORY', 'Project must be an existing directory');
  project = await realpath(project);
  const files = [
    { source: join(ROOT, `skill/${SKILL}/SKILL.md`), destination: 'SKILL.md' },
    { source: join(ROOT, 'host-dist/host-handoff.mjs'), destination: 'scripts/host-handoff.mjs' },
    { source: join(ROOT, 'host-dist/weft.mjs'), destination: 'scripts/weft.mjs' },
    { source: join(ROOT, 'LICENSE'), destination: 'LICENSE' },
  ];
  const payloads = await Promise.all(files.map(file => source(file.source)));
  // Hash exactly the buffers copied below; never enumerate unrelated project files.
  const manifest = files.map((file, i) => ({
    path: file.destination,
    sha256: createHash('sha256').update(payloads[i]).digest('hex'),
    bytes: payloads[i].byteLength,
  }));
  const destinations = selected.map(host => ({ host, path: join(project, HOSTS[host], 'skills', SKILL) }));
  // the canvas skill under its old name: it alone ships scripts/host-handoff.mjs
  const legacy = [];
  for (const host of selected) {
    const old = join(project, HOSTS[host], 'skills', LEGACY);
    if (await exists(join(old, 'scripts/host-handoff.mjs'))) legacy.push(old);
  }
  for (const old of legacy) process.stderr.write(`An older copy of this skill is installed as "weft" at ${old}; it shares its name with the /weft session command. Remove it: rm -r '${old}'\n`);
  for (const target of destinations) {
    await checkPath(target.path, true);
    if (await exists(target.path)) fail('OUTPUT_EXISTS', `Skill already exists: ${target.path}`);
  }
  if (!apply) {
    process.stdout.write(JSON.stringify({ ok: true, dryRun: true, project, destinations, files, manifest, legacy, configsChanged: false }, null, 2) + '\n');
    return;
  }
  const created = [];
  try {
    for (const target of destinations) {
      await ensureDirectories(dirname(target.path));
      // mkdir without recursive/existence fallback exclusively reserves the name.
      await mkdir(target.path, { mode: 0o700 }); created.push(target.path);
      await mkdir(join(target.path, 'scripts'), { mode: 0o700 });
      await checkPath(target.path);
      for (let i = 0; i < files.length; i++) await writeNew(join(target.path, files[i].destination), payloads[i]);
    }
  } catch (error) {
    // Roll back ONLY directories this invocation exclusively created.
    for (const path of created.reverse()) {
      try { await checkPath(path); await rm(path, { recursive: true, force: true }); } catch { /* Never follow a replaced symlink during cleanup. */ }
    }
    throw error;
  }
  process.stdout.write(JSON.stringify({ ok: true, dryRun: false, project, destinations, manifest, legacy, configsChanged: false }, null, 2) + '\n');
}
main().catch(error => {
  process.stderr.write(JSON.stringify({ ok: false, error: { code: error.code ?? 'ERROR', message: error.message ?? String(error) } }) + '\n');
  process.exitCode = 1;
});
