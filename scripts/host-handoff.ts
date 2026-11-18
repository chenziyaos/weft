#!/usr/bin/env node
// Bundle this entry as host-dist/host-handoff.mjs (Node >= 20).
// No inference, history discovery, or writes to the input snapshot. Only the
// canvas-* commands use HTTP, to the loopback bridge of the local server.
import { constants } from 'node:fs';
import { lstat, open, link, unlink, realpath } from 'node:fs/promises';
import { dirname, resolve, parse, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  createHandoff, createHostResult, applyHostResult, getHandoffStatus,
  validateGraph, HostHandoffError, HOST_MAX_BYTES,
  type GraphSnapshot, type HostHandoff, type HostResult,
} from '../src/lib/host-handoff';
import {
  createWorkspace, validateWorkspace, inspectWorkspace, editWorkspace, applyWorkspaceResult,
  type WorkspaceBundle,
} from '../src/lib/graph-workspace';
import { canvasRequest, canvasStatus, bridgeFile } from './canvas-live';

const HELP = `Weft native graph host handoff (Node >= 20)

  node host-dist/host-handoff.mjs inspect --graph FILE
  node host-dist/host-handoff.mjs compile --graph FILE --target ID --host HOST --out FILE [--allow-stale] [--max-bytes N]
  node host-dist/host-handoff.mjs result --handoff FILE --answer FILE --host HOST --run-id ID --mode fresh-session|isolated-subagent|current-session --out FILE
  node host-dist/host-handoff.mjs apply --graph FILE --result FILE --out FILE

Unified entry: weft graph <command> [options]
Graph-only bundle: node host-dist/weft.mjs <command> [options]

  workspace-init --graph FILE --out FILE
  workspace-inspect --workspace FILE
  workspace-edit --workspace FILE --operations FILE --expected-revision N --request-id ID --out FILE
  workspace-compile --workspace FILE --target ID --host HOST --out FILE [--allow-stale]
  workspace-apply --workspace FILE --result FILE --expected-revision N --request-id ID --out FILE
  workspace-export --workspace FILE --out FILE

Workspace outputs are new files, never in-place updates. Use the returned revision
for the next edit/apply; request IDs identify retries. Compile emits the existing
host-handoff format, result remains unchanged, export emits a native graph.
workspace-inspect prints the workspace inspection as JSON. Use --help with any
command to see this reference. Legal workspace operations:
  add-node, branch, reference, connect, set-question, add-attachment,
  remove-node, remove-edge, move-node, archive-node.
Operations FILE is a JSON array, for example:
  [{"op":"set-question","id":"step-1","text":"What should we verify?"}]
  [{"op":"move-node","id":"step-1","x":120,"y":80}]
No shell commands, patch code, model calls or file paths are executed as operations.

Live canvas (the open canvas page, through the local server's bridge; turn on
"Let local agents edit this canvas" in the canvas's Host handoff panel first):
  canvas-status
  canvas-inspect [--project ID]
  canvas-edit --operations FILE --request-id ID [--expected-hash HASH] [--project ID]
  canvas-compile --target ID --host HOST --out FILE [--allow-stale] [--project ID]
  canvas-apply --result FILE --request-id ID [--expected-hash HASH] [--project ID]
canvas-edit takes the same operations as workspace-edit and applies them to the
open canvas with the same validation; the change is undoable there and logged.
Pass the hash from canvas-inspect as --expected-hash so an edit made meanwhile on
the canvas is refused (REVISION_CONFLICT) instead of built upon. Reusing a
request ID with the same payload replays the first reply. Bridge token: ${bridgeFile()}

Inputs must be regular files; symlinks (including parent components) are rejected.
Default ceiling: ${HOST_MAX_BYTES} bytes. Graph ceiling: 500 nodes / 4000 edges.
Outputs MUST NOT exist: temporary file + exclusive atomic hard-link commit.
There is no --force; inputs are never modified. Inspect prints JSON, mutations
print a JSON output receipt; all errors are JSON on stderr with nonzero exit.

Compile uses native graph context with target old response removed, explicit
branch/exclude/include settings and actual image pixels. Review messages AND
images; the embedded complete graph can contain private unrelated material.
No generation-stage ambient memory/recall/search/tools are included. This is
manual file exchange, not a full generation request; canvas-* is the live path.
Use your host itself to answer, then record its output with result and apply.
Host, run ID and mode are declarations only; isolationVerified remains false.
Hash checks detect mutation, not authorship: these files are not signed.
`;
function fail(code: string, message: string): never { throw new HostHandoffError(code, message); }
const allowed: Record<string, string[]> = {
  inspect: ['graph'], compile: ['graph', 'target', 'host', 'out', 'allow-stale', 'max-bytes'],
  result: ['handoff', 'answer', 'host', 'run-id', 'mode', 'out'], apply: ['graph', 'result', 'out'],
  'workspace-init': ['graph', 'out'],
  'workspace-inspect': ['workspace'],
  'workspace-edit': ['workspace', 'operations', 'expected-revision', 'request-id', 'out'],
  'workspace-compile': ['workspace', 'target', 'host', 'out', 'allow-stale'],
  'workspace-apply': ['workspace', 'result', 'expected-revision', 'request-id', 'out'],
  'workspace-export': ['workspace', 'out'],
  'canvas-status': [],
  'canvas-inspect': ['project'],
  'canvas-edit': ['operations', 'request-id', 'expected-hash', 'project'],
  'canvas-compile': ['target', 'host', 'out', 'allow-stale', 'project'],
  'canvas-apply': ['result', 'request-id', 'expected-hash', 'project'],
};
const OPTIONAL = new Set(['allow-stale', 'max-bytes', 'expected-hash', 'project']);
function args(argv: string[]) {
  const [command, ...rest] = argv;
  if (!command || command === 'help' || command === '--help' || command === '-h') return null;
  if (!allowed[command]) fail('USAGE', `Unknown command ${command}; use --help`);
  if (rest.length === 1 && ['--help', '-h'].includes(rest[0])) return null;
  const options: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i].startsWith('--') ? rest[i].slice(2) : '';
    if (!allowed[command].includes(key) || key in options) fail('USAGE', `Unknown or duplicate option ${rest[i]}`);
    if (key === 'allow-stale') options[key] = 'true';
    else {
      const value = rest[++i];
      if (!value || value.startsWith('--')) fail('USAGE', `Missing value for --${key}`);
      options[key] = value;
    }
  }
  for (const key of allowed[command].filter(k => !OPTIONAL.has(k))) if (!options[key]) fail('USAGE', `Missing --${key}`);
  return { command, options };
}
async function safePath(file: string, finalMayBeMissing = false): Promise<string> {
  const absolute = resolve(file);
  const root = parse(absolute).root;
  const pieces = absolute.slice(root.length).split('/').filter(Boolean);
  let current = root;
  for (let i = 0; i < pieces.length; i++) {
    current = join(current, pieces[i]);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) fail('SYMLINK', `Symlinks are not allowed: ${current}`);
      if (i < pieces.length - 1 && !stat.isDirectory()) fail('NOT_DIRECTORY', `Not a directory: ${current}`);
    } catch (error) {
      if (finalMayBeMissing && i === pieces.length - 1 && (error as NodeJS.ErrnoException).code === 'ENOENT') return absolute;
      throw error;
    }
  }
  return absolute;
}
async function read(file: string, limit = HOST_MAX_BYTES): Promise<string> {
  const path = await safePath(file);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) fail('NOT_FILE', `Not a regular file: ${path}`);
    if (stat.size > limit) fail('TOO_LARGE', `Input exceeds ${limit} bytes: ${path}`);
    // Bounded allocation/read also catches a file growing after stat.
    const buffer = Buffer.alloc(Math.min(stat.size + 1, limit + 1));
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > stat.size || offset > limit) fail('INPUT_CHANGED', `Input grew while reading: ${path}`);
    const after = await handle.stat();
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || offset !== stat.size) fail('INPUT_CHANGED', `Input changed while reading: ${path}`);
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, offset));
  } finally { await handle.close(); }
}
async function readJson<T>(file: string): Promise<T> {
  const source = await read(file);
  try { return JSON.parse(source) as T; }
  catch { return fail('INVALID_JSON', `Invalid JSON in ${file}`); }
}
async function writeExclusive(file: string, value: unknown, inputs: string[]): Promise<string> {
  const path = await safePath(file, true);
  if (inputs.some(input => resolve(input) === path)) fail('INPUT_OVERWRITE', 'Output must differ from every input');
  try { await lstat(path); fail('OUTPUT_EXISTS', `Refusing to overwrite ${path}`); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const parent = await realpath(dirname(path));
  const temp = join(parent, `.host-handoff-${randomUUID()}.tmp`);
  const bytes = JSON.stringify(value, null, 2) + '\n';
  if (Buffer.byteLength(bytes) > HOST_MAX_BYTES) fail('TOO_LARGE', 'Serialized output exceeds byte ceiling');
  let created = false;
  try {
    const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    created = true;
    try { await handle.writeFile(bytes, 'utf8'); await handle.sync(); } finally { await handle.close(); }
    await safePath(dirname(path));
    // link() is atomic and fails if the destination appeared concurrently.
    await link(temp, path);
  } finally { if (created) await unlink(temp); }
  return path;
}
function expectedRevision(value: string): number {
  if (!/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value))) {
    fail('USAGE', '--expected-revision must be a nonnegative safe integer');
  }
  return Number(value);
}

async function main() {
  const parsed = args(process.argv.slice(2));
  if (!parsed) { process.stdout.write(HELP); return; }
  const { command, options: o } = parsed;
  let output: unknown;
  let workspaceReceipt: { revision: number; requestId: string | null; currentGraphHash?: string } | undefined;
  const inputs: string[] = [];
  if (command.startsWith('canvas-')) {
    const scope = { ...(o.project ? { projectId: o.project } : {}), ...(o['expected-hash'] ? { expectedHash: o['expected-hash'] } : {}) };
    let result: unknown;
    if (command === 'canvas-status') result = await canvasStatus();
    else if (command === 'canvas-inspect') result = await canvasRequest('inspect', scope);
    else if (command === 'canvas-edit') {
      const operations = await readJson<unknown>(o.operations);
      result = await canvasRequest('edit', { ...scope, operations, requestId: o['request-id'] });
    } else if (command === 'canvas-apply') {
      const hostResult = await readJson<HostResult>(o.result);
      result = await canvasRequest('apply-result', { ...scope, result: hostResult, requestId: o['request-id'] });
    } else {
      const handoff = await canvasRequest('compile', { ...scope, target: o.target, host: o.host, allowStale: o['allow-stale'] === 'true' });
      const path = await writeExclusive(o.out, handoff, []);
      process.stdout.write(JSON.stringify({ ok: true, command, out: path, isolationVerified: false }) + '\n');
      return;
    }
    process.stdout.write(JSON.stringify({ ok: true, command, ...(result && typeof result === 'object' ? result : { result }) }, null, 2) + '\n');
    return;
  }
  if (command.startsWith('workspace-')) {
    let workspace: WorkspaceBundle;
    if (command === 'workspace-init') {
      const graph = await readJson<unknown>(o.graph); inputs.push(o.graph);
      validateGraph(graph);
      workspace = await createWorkspace(graph);
      output = workspace;
    } else {
      const value = await readJson<unknown>(o.workspace); inputs.push(o.workspace);
      const validated: unknown = await validateWorkspace(value);
      workspace = (validated ?? value) as WorkspaceBundle;
      if (command === 'workspace-edit' || command === 'workspace-apply') {
        const revision = expectedRevision(o['expected-revision']);
        const requestId = o['request-id'];
        if (!requestId.trim()) fail('USAGE', '--request-id must be nonempty');
        if (command === 'workspace-edit') {
          const operations = await readJson<unknown>(o.operations); inputs.push(o.operations);
          workspace = await editWorkspace(workspace, operations, revision, requestId);
        } else {
          const result = await readJson<HostResult>(o.result); inputs.push(o.result);
          workspace = await applyWorkspaceResult(workspace, result, revision, requestId);
        }
        output = workspace;
      } else if (command === 'workspace-compile') {
        output = await createHandoff(workspace.graph, o.target, { host: o.host, allowStale: o['allow-stale'] === 'true' });
      } else if (command === 'workspace-export') {
        validateGraph(workspace.graph);
        output = workspace.graph;
      }
    }
    const inspection = await inspectWorkspace(workspace);
    const currentGraphHash = inspection && typeof inspection === 'object' && 'currentGraphHash' in inspection
      && typeof inspection.currentGraphHash === 'string' ? inspection.currentGraphHash : undefined;
    workspaceReceipt = { revision: workspace.revision, requestId: o['request-id'] ?? null, ...(currentGraphHash === undefined ? {} : { currentGraphHash }) };
    if (command === 'workspace-inspect') output = { ...inspection, ok: true, command, ...workspaceReceipt, isolationVerified: false };
  } else if (command === 'inspect' || command === 'compile' || command === 'apply') {
    const graph = await readJson<GraphSnapshot>(o.graph); inputs.push(o.graph);
    validateGraph(graph);
    if (command === 'inspect') {
      output = { format: 'weft.host-inspection', version: 1, name: graph.name, projectId: graph.projectId, nodes: graph.nodes.length, edges: graph.edges.length, ...getHandoffStatus(graph), isolationVerified: false };
    } else if (command === 'compile') {
      const maxBytes = o['max-bytes'] === undefined ? undefined : Number(o['max-bytes']);
      output = await createHandoff(graph, o.target, { host: o.host, allowStale: o['allow-stale'] === 'true', maxBytes });
    } else {
      const result = await readJson<HostResult>(o.result); inputs.push(o.result);
      output = await applyHostResult(graph, result);
    }
  } else {
    const handoff = await readJson<HostHandoff>(o.handoff);
    const answer = await read(o.answer); inputs.push(o.handoff, o.answer);
    output = await createHostResult(handoff, answer, o.host, o['run-id'], o.mode);
  }
  if (command === 'inspect' || command === 'workspace-inspect') process.stdout.write(JSON.stringify(output, null, 2) + '\n');
  else {
    const path = await writeExclusive(o.out, output, inputs);
    process.stdout.write(JSON.stringify({ ok: true, command, out: path, ...workspaceReceipt, isolationVerified: false }) + '\n');
  }
}
main().catch((error: unknown) => {
  const code = error instanceof HostHandoffError ? error.code : (error as NodeJS.ErrnoException)?.code ?? 'ERROR';
  process.stderr.write(JSON.stringify({ ok: false, error: { code, message: error instanceof Error ? error.message : String(error) } }) + '\n');
  process.exitCode = 1;
});
