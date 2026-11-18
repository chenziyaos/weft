#!/usr/bin/env node
// Runtime-only verification: synthetic files, public CLI subprocesses, no product imports.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = path.join(root, 'evidence/weft-workspace-cli');
fs.mkdirSync(base, { recursive: true });
const run = fs.mkdtempSync(path.join(base, 'run-'));
const home = path.join(run, 'empty-home');
const cwd = path.join(run, 'empty-cwd');
const buildHome = path.join(run, 'build-home');
for (const dir of [home, cwd, buildHome]) fs.mkdirSync(dir);
const commandFile = path.join(run, 'commands.jsonl');
fs.writeFileSync(commandFile, '', { flag: 'wx' });
const checks = [];
const commands = [];
const flows = {};
const abs = name => path.join(run, name);
const put = (name, value) => {
  const file = abs(name);
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  return file;
};
function fingerprint(file) {
  if (!fs.existsSync(file)) return null;
  const fd = fs.openSync(file, 'r');
  const hash = createHash('sha256');
  const buffer = Buffer.alloc(64 * 1024);
  let bytes = 0, count;
  try { while ((count = fs.readSync(fd, buffer, 0, buffer.length, null))) { hash.update(buffer.subarray(0, count)); bytes += count; } }
  finally { fs.closeSync(fd); }
  return { bytes, sha256: hash.digest('hex') };
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function check(name, ok, observed = {}) { checks.push({ name, pass: !!ok, observed }); }
const trackedSources = ['src/lib/graph-workspace.ts', 'src/lib/host-handoff.ts', 'scripts/host-handoff.ts', 'cli/src/main.ts', 'package.json'];
const sourcesBefore = Object.fromEntries(trackedSources.map(f => [f, fingerprint(path.join(root, f))]));
put('scope.json', {
  synthetic: true, description: 'All graph, question, quote, attachment and answer content is fabricated for local CLI verification. No model output.',
  project: root, sourcesBefore, noTests: true, noTypecheck: true, noProductImports: true,
  publicEntries: ['host-dist/weft.mjs', 'cli/dist/weft.mjs graph'],
  gitScope: 'Project is untracked in enclosing research repository; zero attributable product commits. Named files define scope.',
});
// This preload guards only the process boundary; it never imports product code.
const guardLog = abs('network-process-guard.jsonl');
const guard = put('offline-guard.cjs', `
const fs = require('node:fs');
const log = entry => fs.appendFileSync(process.env.VERIFY_GUARD_LOG, JSON.stringify({pid:process.pid,...entry})+'\\n');
const deny = name => function(){ log({event:'denied',name}); throw new Error('VERIFICATION_OFFLINE_GUARD: '+name); };
const net = require('node:net');
net.Socket.prototype.connect = deny('net.connect'); net.Server.prototype.listen = deny('net.listen');
for (const name of ['node:http','node:https']) { const m=require(name); m.request=deny(name+'.request'); m.get=deny(name+'.get'); }
require('node:tls').connect=deny('tls.connect');
const udp=require('node:dgram'); udp.createSocket=deny('dgram.createSocket');
const h2=require('node:http2'); h2.connect=deny('http2.connect'); h2.createServer=deny('http2.createServer'); h2.createSecureServer=deny('http2.createSecureServer');
const dns=require('node:dns'); for(const k of ['lookup','resolve','resolve4','resolve6','reverse']) { dns[k]=deny('dns.'+k); dns.promises[k]=deny('dns.promises.'+k); }
const cp=require('node:child_process'); for(const k of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']) cp[k]=deny('child_process.'+k);
require('node:worker_threads').Worker=deny('Worker');
globalThis.fetch=deny('fetch'); globalThis.WebSocket=deny('WebSocket');
require('node:module').syncBuiltinESMExports();
log({event:'ready'});
`);
const env = {
  PATH: process.env.PATH, HOME: home, USERPROFILE: home,
  XDG_CONFIG_HOME: path.join(home, 'config'), XDG_CACHE_HOME: path.join(home, 'cache'), XDG_DATA_HOME: path.join(home, 'data'),
  LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'UTC', NO_COLOR: '1',
  VERIFY_GUARD_LOG: guardLog,
};
function execute(label, executable, args, { build = false, inputs = [], out, expected = 'success', codes = [] } = {}) {
  const id = String(commands.length + 1).padStart(3, '0');
  const before = Object.fromEntries(inputs.map(f => [f, fingerprint(f)]));
  const outBefore = out ? fingerprint(out) : null;
  const startedAt = new Date().toISOString();
  const result = spawnSync(executable, args, {
    cwd: build ? root : cwd, env: build ? { ...env, HOME: buildHome, npm_config_cache: path.join(buildHome, 'cache'), npm_config_update_notifier: 'false', npm_config_audit: 'false' } : env,
    encoding: 'utf8', timeout: build ? 120000 : 20000, maxBuffer: 4 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = put(`${id}-${label}.stdout.txt`, result.stdout ?? '');
  const stderr = put(`${id}-${label}.stderr.txt`, result.stderr ?? '');
  let json, error;
  try { json = JSON.parse(result.stdout); } catch {}
  try { error = JSON.parse(result.stderr)?.error; } catch {}
  const after = Object.fromEntries(inputs.map(f => [f, fingerprint(f)]));
  const outAfter = out ? fingerprint(out) : null;
  const expectedExit = expected === 'success' ? result.status === 0 : Number.isInteger(result.status) && result.status > 0 && !!error && (!codes.length || codes.includes(error.code));
  const entry = {
    id, label, executable, args, cwd: build ? root : cwd, isolatedHome: build ? buildHome : home,
    startedAt, finishedAt: new Date().toISOString(), status: result.status, signal: result.signal,
    processError: result.error?.message ?? null, expected, codes, error, stdout, stderr,
    inputsBefore: before, inputsAfter: after, out: out ?? null, outBefore, outAfter,
  };
  commands.push(entry); fs.appendFileSync(commandFile, JSON.stringify(entry) + '\n');
  check(`${label}: exit/result`, expectedExit && !result.error && !result.signal, { status: result.status, error, expected, codes });
  if (inputs.length) check(`${label}: input bytes unchanged`, same(before, after), { before, after });
  if (out) check(`${label}: exclusive output`, expected === 'success' ? outBefore === null && outAfter !== null : same(outBefore, outAfter), { outBefore, outAfter });
  return { ...entry, json, text: result.stdout ?? '' };
}
const entries = { host: ['host-dist/weft.mjs'], unified: ['cli/dist/weft.mjs', 'graph'] };
function cli(surface, label, args, options = {}) {
  const [entry, ...prefix] = entries[surface];
  return execute(`${surface}-${label}`, process.execPath, ['--require', guard, path.join(root, entry), ...prefix, ...args], options);
}
const load = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const node = id => ({
  id, type: 'thought', position: { x: 0, y: 0 },
  data: { stepKind: 'prompt', question: 'SYNTHETIC root question', response: 'SYNTHETIC root answer v0', responses: ['SYNTHETIC root answer v0'], responseIndex: 0,
    questions: ['SYNTHETIC root question'], isCollapsed: false, isEditing: false, isEditingResponse: false, isLoading: false,
    tokenCount: 0, highlights: [], highlightMode: 'tag', attachments: [], excludedAttachmentIds: [], includedAttachmentIds: [], roleMode: 'inherit', isRoot: true, isBranch: false },
});
const graph = { version: 1, name: 'SYNTHETIC workspace CLI fixture; not user data', projectId: 'synthetic-workspace-cli', nodes: [node('step-1')], edges: [] };
const graphFile = put('synthetic-native.json', graph);
const attachment = { id: 'synthetic-attachment', name: 'synthetic.txt', type: 'text/plain', content: 'SYNTHETIC attachment bytes', size: 26, addedAt: '2026-01-01T00:00:00.000Z' };
attachment.size = Buffer.byteLength(attachment.content);
const operations = [
  { op: 'add-node', id: 'prompt', kind: 'prompt', question: 'SYNTHETIC added prompt' },
  { op: 'add-node', id: 'note', kind: 'note', text: 'SYNTHETIC note material' },
  { op: 'add-node', id: 'file', kind: 'file', text: 'SYNTHETIC file material' },
  { op: 'branch', id: 'branch', source: 'step-1', question: 'SYNTHETIC branch question', quote: 'SYNTHETIC quoted passage; data only' },
  { op: 'add-attachment', id: 'branch', attachment },
  { op: 'add-attachment', id: 'file', attachment: { ...attachment, id: 'synthetic-file-attachment', name: 'synthetic-file.txt' } },
  { op: 'connect', id: 'root-prompt', source: 'step-1', target: 'prompt' },
  { op: 'connect', id: 'file-branch', source: 'file', target: 'branch' },
  { op: 'reference', id: 'note-reference', source: 'note', target: 'branch' },
];
const operationsFile = put('synthetic-operations.json', operations);
const answer1 = put('synthetic-answer-v1.txt', 'SYNTHETIC MANUALLY AUTHORED ANSWER v1. No inference was requested.\n');
const answer2 = put('synthetic-answer-v2.txt', 'SYNTHETIC MANUALLY AUTHORED ANSWER v2. No inference was requested.\n');
function workflow(surface) {
  const file = name => abs(`${surface}-${name}.json`);
  const init = file('workspace-0'), edited = file('workspace-1'), applied = file('workspace-2');
  const handoff = file('handoff-1'), result = file('result-1'), exported = file('export-1');
  const help = cli(surface, 'help', ['--help']);
  cli(surface, 'native-inspect', ['inspect', '--graph', graphFile], { inputs: [graphFile] });
  cli(surface, 'init', ['workspace-init', '--graph', graphFile, '--out', init], { inputs: [graphFile], out: init });
  const i0 = cli(surface, 'inspect-0', ['workspace-inspect', '--workspace', init], { inputs: [init] });
  const editArgs = (workspace, ops, revision, request, out) => ['workspace-edit', '--workspace', workspace, '--operations', ops, '--expected-revision', String(revision), '--request-id', request, '--out', out];
  const applyArgs = (workspace, res, revision, request, out) => ['workspace-apply', '--workspace', workspace, '--result', res, '--expected-revision', String(revision), '--request-id', request, '--out', out];
  cli(surface, 'edit-batch', editArgs(init, operationsFile, 0, 'synthetic-edit', edited), { inputs: [init, operationsFile], out: edited });
  const i1 = cli(surface, 'inspect-1', ['workspace-inspect', '--workspace', edited], { inputs: [edited] });
  const w0 = load(init), w1 = load(edited), r1 = w1.operations[0];
  check(`${surface}: identity and initial hash`, w0.projectId === graph.projectId && w0.graph.projectId === graph.projectId && w0.revision === 0 && w0.version === 1 && w0.operations.length === 0 && i0.json?.currentGraphHash === w0.baseHash);
  check(`${surface}: batch receipt hash chain`, w1.id === w0.id && w1.revision === 1 && w1.operations.length === 1 && r1.baseRevision === 0 && r1.revision === 1 && r1.requestId === 'synthetic-edit' && r1.beforeHash === w0.baseHash && r1.afterHash === i1.json?.currentGraphHash && r1.afterHash !== r1.beforeHash && /^sha256:[a-f0-9]{64}$/.test(r1.requestHash), r1);
  const branch = w1.graph.nodes.find(n => n.id === 'branch');
  check(`${surface}: native edit fields`, w1.graph.nodes.length === 5 && w1.graph.edges.length === 4 && branch.data.branchContext === operations[3].quote && branch.data.response === '' && branch.data.attachments[0].content === attachment.content && w1.graph.nodes.find(n => n.id === 'note').data.stepKind === 'note' && w1.graph.edges.find(e => e.id === 'note-reference').data.isCrossLink === true && same(w1.graph.nodes[0].data.responses, graph.nodes[0].data.responses));
  cli(surface, 'compile', ['workspace-compile', '--workspace', edited, '--target', 'branch', '--host', 'synthetic-manual', '--out', handoff], { inputs: [edited], out: handoff });
  const h = load(handoff);
  check(`${surface}: compile is data only`, h.format === 'weft.host-handoff' && h.version === 1 && h.target === 'branch' && h.graph.projectId === graph.projectId && h.isolationVerified === false && h.graph.nodes.find(n => n.id === 'branch').data.responses.length === 0 && JSON.stringify(h.messages).includes(attachment.content) && JSON.stringify(h.messages).includes(operations[3].quote));
  cli(surface, 'result', ['result', '--handoff', handoff, '--answer', answer1, '--host', 'synthetic-manual', '--run-id', 'synthetic-run-1', '--mode', 'current-session', '--out', result], { inputs: [handoff, answer1], out: result });
  cli(surface, 'apply', applyArgs(edited, result, 1, 'synthetic-apply', applied), { inputs: [edited, result], out: applied });
  const i2 = cli(surface, 'inspect-2', ['workspace-inspect', '--workspace', applied], { inputs: [applied] });
  const w2 = load(applied), d2 = w2.graph.nodes.find(n => n.id === 'branch').data, hostResult = load(result), r2 = w2.operations[1];
  check(`${surface}: apply versions and receipts`, w2.revision === 2 && w2.id === w0.id && d2.response === fs.readFileSync(answer1, 'utf8') && d2.responses.length === 1 && d2.responseIndex === 0 && d2.hostReceipts.length === 1 && d2.hostReceipts[0].resultId === hostResult.id && d2.hostReceipts[0].handoffId === h.id && d2.hostReceipts[0].isolationVerified === false && r2.beforeHash === r1.afterHash && r2.afterHash === i2.json?.currentGraphHash && r2.afterHash !== r2.beforeHash && r2.baseRevision === 1 && r2.operation.kind === 'host-result');
  cli(surface, 'export', ['workspace-export', '--workspace', applied, '--out', exported], { inputs: [applied], out: exported });
  check(`${surface}: native export matches persisted graph`, same(load(exported), w2.graph) && load(exported).projectId === graph.projectId && load(exported).version === graph.version);
  cli(surface, 'export-inspect', ['inspect', '--graph', exported], { inputs: [exported] });
  const restarted = cli(surface, 'restart-inspect', ['workspace-inspect', '--workspace', applied], { inputs: [applied, exported, result] });
  check(`${surface}: restart restores without execution`, same(restarted.json, i2.json) && same(load(applied), w2));
  const replay = file('edit-retry');
  cli(surface, 'same-request-original-base', editArgs(edited, operationsFile, r1.baseRevision, 'synthetic-edit', replay), { inputs: [edited, operationsFile], out: replay });
  check(`${surface}: edit idempotency byte exact`, same(fingerprint(replay), fingerprint(edited)));
  const applyReplay = file('apply-retry');
  cli(surface, 'same-apply-original-base', applyArgs(applied, result, r2.baseRevision, 'synthetic-apply', applyReplay), { inputs: [applied, result], out: applyReplay });
  check(`${surface}: apply idempotency byte exact`, same(fingerprint(applyReplay), fingerprint(applied)));
  const rejectEdit = (label, ops, code, options = {}) => {
    const opsFile = typeof ops === 'string' ? ops : put(`${surface}-probe-${label}.json`, ops);
    const out = options.out ?? file(`rejected-${label}`);
    return cli(surface, label, editArgs(options.workspace ?? edited, opsFile, options.revision ?? 1, options.request ?? `probe-${label}`, out), { inputs: [options.workspace ?? edited, opsFile], out, expected: 'reject', codes: [code] });
  };
  rejectEdit('wrong-revision', [{ op: 'set-question', id: 'prompt', text: 'SYNTHETIC changed' }], 'REVISION_CONFLICT', { revision: 99 });
  rejectEdit('retry-wrong-base', operationsFile, 'REVISION_CONFLICT', { request: 'synthetic-edit' });
  rejectEdit('request-conflict', [{ op: 'set-question', id: 'prompt', text: 'SYNTHETIC changed' }], 'IDEMPOTENCY_CONFLICT', { request: 'synthetic-edit', revision: 0 });
  const goodFirst = { op: 'add-node', id: 'must-not-partially-commit', text: 'SYNTHETIC rollback probe' };
  rejectEdit('bad-op', [goodFirst, { op: 'execute-model', id: 'bad' }], 'INVALID_OPERATION');
  rejectEdit('duplicate-node', [goodFirst, { op: 'add-node', id: 'step-1' }], 'DUPLICATE_ID');
  rejectEdit('duplicate-edge', [goodFirst, { op: 'connect', id: 'root-prompt', source: 'step-1', target: 'prompt' }], 'DUPLICATE_ID');
  rejectEdit('dangling-edge', [goodFirst, { op: 'connect', id: 'dangling', source: 'missing', target: 'prompt' }], 'NODE_NOT_FOUND');
  rejectEdit('structural-cycle', [goodFirst, { op: 'connect', id: 'cycle', source: 'branch', target: 'step-1' }], 'GRAPH_CYCLE');
  rejectEdit('invalid-attachment', [goodFirst, { op: 'add-attachment', id: 'branch', attachment: { ...attachment, id: 'invalid', size: -1 } }], 'INVALID_ATTACHMENT');
  rejectEdit('duplicate-attachment', [{ op: 'add-attachment', id: 'branch', attachment }], 'DUPLICATE_ID');
  rejectEdit('unhydrated-attachment', [{ op: 'add-attachment', id: 'branch', attachment: { ...attachment, id: 'vault', content: '', contentInVault: true } }], 'UNHYDRATED_ATTACHMENT');
  for (const key of ['__proto__', 'constructor', 'prototype']) rejectEdit(`unsafe-${key}`, JSON.parse(`[{"op":"set-question","id":"prompt","text":"SYNTHETIC","${key}":{"x":true}}]`), 'INVALID_KEY');
  rejectEdit('answer-injection', [{ op: 'add-node', id: 'injection', response: 'SYNTHETIC forbidden answer' }], 'UNKNOWN_FIELD');
  const goodOps = put(`${surface}-probe-good-ops.json`, [{ op: 'set-question', id: 'prompt', text: 'SYNTHETIC changed' }]);
  const existing = put(`${surface}-existing-output.json`, { synthetic: true, sentinel: 'must remain unchanged' });
  rejectEdit('output-exists', goodOps, 'OUTPUT_EXISTS', { out: existing });
  rejectEdit('same-workspace-path', goodOps, 'INPUT_OVERWRITE', { out: edited });
  rejectEdit('same-operations-path', goodOps, 'INPUT_OVERWRITE', { out: goodOps });
  rejectEdit('oversized-input', oversized, 'TOO_LARGE');
  rejectEdit('operation-count-limit', Array.from({ length: 501 }, (_, i) => ({ op: 'add-node', id: `synth-${i}` })), 'INVALID_OPERATIONS');
  const consumed = file('rejected-old-result');
  cli(surface, 'old-result-new-request', applyArgs(applied, result, 2, 'synthetic-replay-new-id', consumed), { inputs: [applied, result], out: consumed, expected: 'reject', codes: ['REPLAY'] });
  const changed = file('workspace-changed');
  cli(surface, 'edit-after-compile', editArgs(edited, goodOps, 1, 'synthetic-post-compile', changed), { inputs: [edited, goodOps], out: changed });
  // `prompt` is a sibling of the target: editing it leaves the target's input intact.
  const unrelated = file('applied-after-unrelated-edit');
  cli(surface, 'result-after-unrelated-edit', applyArgs(changed, result, 2, 'synthetic-unrelated', unrelated), { inputs: [changed, result], out: unrelated });
  const inputOps = put(`${surface}-probe-target-question.json`, [{ op: 'set-question', id: 'branch', text: 'SYNTHETIC changed target question' }]);
  const inputChanged = file('workspace-target-changed');
  cli(surface, 'edit-target-after-compile', editArgs(edited, inputOps, 1, 'synthetic-post-compile-target', inputChanged), { inputs: [edited, inputOps], out: inputChanged });
  const stale = file('rejected-stale-result');
  cli(surface, 'stale-result', applyArgs(inputChanged, result, 2, 'synthetic-stale', stale), { inputs: [inputChanged, result], out: stale, expected: 'reject', codes: ['STALE_RESULT'] });
  // Copy actual help examples verbatim: success is the documented expectation.
  const examples = help.text.split('\n').map(s => s.trim()).filter(s => s.startsWith('[{'));
  check(`${surface}: help has runnable examples`, examples.length >= 2, { examples });
  for (const [index, example] of examples.entries()) {
    const ops = put(`${surface}-help-example-${index}.json`, example + '\n');
    const out = file(`help-example-${index}-output`);
    cli(surface, `documented-example-${index}`, editArgs(init, ops, 0, `synthetic-help-${index}`, out), { inputs: [init, ops], out });
  }
  const correct = put(`${surface}-actual-op-examples.json`, [{ op: 'set-question', id: 'step-1', text: 'SYNTHETIC actual question' }, { op: 'move-node', id: 'step-1', x: 120, y: 80 }]);
  const actual = file('actual-op-output');
  cli(surface, 'actual-op-examples', editArgs(init, correct, 0, 'synthetic-actual-ops', actual), { inputs: [init, correct], out: actual });
  check(`${surface}: actual op syntax works`, load(actual).graph.nodes[0].position.x === 120 && load(actual).graph.nodes[0].data.question === 'SYNTHETIC actual question');
  // Compile and write another manually authored answer to prove version append.
  const h2 = file('handoff-2'), res2 = file('result-2'), w3File = file('workspace-3');
  cli(surface, 'compile-v2', ['workspace-compile', '--workspace', applied, '--target', 'branch', '--host', 'synthetic-manual', '--out', h2], { inputs: [applied], out: h2 });
  cli(surface, 'result-v2', ['result', '--handoff', h2, '--answer', answer2, '--host', 'synthetic-manual', '--run-id', 'synthetic-run-2', '--mode', 'current-session', '--out', res2], { inputs: [h2, answer2], out: res2 });
  cli(surface, 'apply-v2', applyArgs(applied, res2, 2, 'synthetic-apply-v2', w3File), { inputs: [applied, res2], out: w3File });
  const w3 = load(w3File), d3 = w3.graph.nodes.find(n => n.id === 'branch').data;
  check(`${surface}: versions appended not overwritten`, w3.revision === 3 && same(d3.responses, [fs.readFileSync(answer1, 'utf8'), fs.readFileSync(answer2, 'utf8')]) && d3.responseIndex === 1 && d3.hostReceipts.length === 2 && d3.hostReceipts[0].resultId === hostResult.id && d3.questions.length === 2 && w3.operations[2].beforeHash === r2.afterHash);
  cli(surface, 'restart-final', ['workspace-inspect', '--workspace', w3File], { inputs: [w3File] });
  const finalExport = file('export-final');
  cli(surface, 'export-final', ['workspace-export', '--workspace', w3File, '--out', finalExport], { inputs: [w3File], out: finalExport });
  flows[surface] = { init, edited, applied, final: w3File, finalExport, workspaceId: w3.id, graphID: w3.projectId, versions: d3.responses.length, receipts: w3.operations, inspections: [i0.json, i1.json, i2.json] };
}
// Sparse 32 MiB + 1 fixture: stat rejects it before allocating/parsing payload.
const oversized = abs('synthetic-oversized-32MiB-plus-1.json');
const bigFd = fs.openSync(oversized, 'wx');
fs.ftruncateSync(bigFd, 32 * 1024 * 1024 + 1); fs.closeSync(bigFd);
put('oversized-fixture.json', { synthetic: true, file: oversized, bytes: 32 * 1024 * 1024 + 1, sparse: true, reason: 'Exercise stat size gate without large heap allocation.' });
let fatal = null;
try {
  execute('build-host', 'npm', ['run', 'host:build'], { build: true });
  execute('build-cli', 'npm', ['run', 'cli:build'], { build: true });
  for (const surface of Object.keys(entries)) {
    try { workflow(surface); }
    catch (error) { check(`${surface}: workflow completion`, false, { error: error.stack }); }
  }
  for (const surface of Object.keys(entries)) {
    const invalid = structuredClone(graph); invalid.edges.push({ id: 'synthetic-dangling', source: 'step-1', target: 'missing' });
    const input = put(`${surface}-synthetic-native-dangling.json`, invalid), out = abs(`${surface}-native-dangling-output.json`);
    cli(surface, 'native-dangling-edge', ['workspace-init', '--graph', input, '--out', out], { inputs: [input], out, expected: 'reject', codes: ['DANGLING_EDGE'] });
  }
} catch (error) { fatal = error.stack; check('harness completion', false, { fatal }); }
const guardEvents = fs.existsSync(guardLog) ? fs.readFileSync(guardLog, 'utf8').trim().split('\n').filter(Boolean).map(s => JSON.parse(s)) : [];
check('runtime network/listener/subprocess guards loaded', guardEvents.filter(e => e.event === 'ready').length === commands.filter(c => !c.label.startsWith('build-')).length, { ready: guardEvents.filter(e => e.event === 'ready').length });
check('no network/listener/model/subprocess attempts', guardEvents.every(e => e.event === 'ready'), { denied: guardEvents.filter(e => e.event !== 'ready') });
check('isolated HOME stays empty: no index or host configuration created', fs.readdirSync(home).length === 0, { entries: fs.readdirSync(home), home });
check('isolated runtime cwd stays empty', fs.readdirSync(cwd).length === 0, { entries: fs.readdirSync(cwd), cwd });
const sourcesAfter = Object.fromEntries(trackedSources.map(f => [f, fingerprint(path.join(root, f))]));
check('product sources unchanged by verification', same(sourcesBefore, sourcesAfter), { sourcesBefore, sourcesAfter });
check('original synthetic graph unchanged', same(load(graphFile), graph));
const summary = {
  verdict: checks.every(c => c.pass) ? 'PASS' : 'FAIL', synthetic: true, run, project: root,
  passed: checks.filter(c => c.pass).length, failed: checks.filter(c => !c.pass).length, total: checks.length,
  commands: commands.length, expectedRejectionCommands: commands.filter(c => c.expected === 'reject').length,
  fatal, flows, checks, failures: checks.filter(c => !c.pass),
  boundaries: { noModelInference: true, noTests: true, noTypecheck: true, noProductImports: true, isolatedHomeOnly: true, runtimeNetworkAndListenersBlocked: true },
};
put('summary.json', summary);
process.stdout.write(JSON.stringify({ verdict: summary.verdict, passed: summary.passed, failed: summary.failed, total: summary.total, commands: summary.commands, evidence: run, failures: summary.failures.map(c => c.name) }, null, 2) + '\n');
process.exitCode = summary.failed ? 1 : 0;
