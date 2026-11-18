'use strict';
// Live canvas bridge: relays requests from a local agent (the `weft canvas`
// CLI) to the canvas page that opted in, and the page's reply back. The page
// does all graph work with the same validated core as workspace files; this
// relay only routes, so it never sees or changes a graph itself.
//
// Trust: the CLI side needs the bearer token from the 0600 token file, so a
// web page cannot drive it even with a no-CORS request. The page side relies
// on the server's localhost-only CORS (JSON bodies need a preflight) and
// loopback binding.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const KINDS = new Set(['inspect', 'edit', 'compile', 'apply-result']);
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;

function tokenFile() {
  return path.join(process.env.WEFT_HOME || path.join(os.homedir(), '.weft'), 'canvas-bridge.json');
}

function createCanvasBridge({ port, log = () => {} }) {
  const token = crypto.randomBytes(32).toString('hex');
  const file = tokenFile();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ url: `http://127.0.0.1:${port}`, token, pid: process.pid, startedAt: new Date().toISOString() }), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    log(`canvas bridge: cannot write ${file}: ${err.message}`);
  }

  /** The newest page that opened the stream; a newer tab replaces it. */
  let listener = null;
  const pending = new Map();

  function authorized(req) {
    const header = String(req.headers.authorization || '');
    const given = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : '');
    const want = Buffer.from(token);
    return given.length === want.length && crypto.timingSafeEqual(given, want);
  }
  function settle(id, body) {
    const p = pending.get(id);
    if (!p) return false;
    pending.delete(id);
    clearTimeout(p.timer);
    p.res.status(body.ok ? 200 : 409).json(body);
    return true;
  }
  function failAll(code, message) {
    for (const id of [...pending.keys()]) settle(id, { ok: false, error: { code, message } });
  }

  function stream(req, res) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(': open\n\n');
    if (listener) {
      listener.res.end();
      failAll('CANVAS_REPLACED', 'Another canvas page opened the bridge');
    }
    const me = { res, projectId: String(req.query.projectId || ''), since: new Date().toISOString() };
    listener = me;
    const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
    req.on('close', () => {
      clearInterval(ping);
      if (listener === me) {
        listener = null;
        failAll('CANVAS_CLOSED', 'The canvas page closed the bridge');
      }
    });
  }

  function request(req, res) {
    if (!authorized(req)) return res.status(401).json({ ok: false, error: { code: 'UNAUTHORIZED', message: `Missing or wrong bridge token (see ${file})` } });
    const { kind, payload } = req.body ?? {};
    if (!KINDS.has(kind)) return res.status(400).json({ ok: false, error: { code: 'INVALID_REQUEST', message: `kind must be one of ${[...KINDS].join(', ')}` } });
    if (!listener) return res.status(503).json({ ok: false, error: { code: 'NO_CANVAS', message: 'No canvas has the live bridge open. In the canvas, open Host handoff and turn on "Let local agents edit this canvas".' } });
    const timeout = Math.min(Number(req.body.timeoutMs) || DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    const id = crypto.randomUUID();
    const timer = setTimeout(() => settle(id, { ok: false, error: { code: 'CANVAS_TIMEOUT', message: `The canvas did not answer within ${timeout} ms` } }), timeout);
    pending.set(id, { res, timer });
    res.on('close', () => { if (pending.get(id)?.res === res && !res.writableEnded) { clearTimeout(timer); pending.delete(id); } });
    listener.res.write(`event: request\ndata: ${JSON.stringify({ id, kind, payload: payload ?? {} })}\n\n`);
    log(`canvas bridge: ${kind} → page`);
  }

  function reply(req, res) {
    const { id, ok, result, error } = req.body ?? {};
    if (typeof id !== 'string') return res.status(400).json({ error: 'id required' });
    const delivered = settle(id, ok ? { ok: true, result } : { ok: false, error: error ?? { code: 'CANVAS_ERROR', message: 'Unknown canvas error' } });
    res.status(delivered ? 204 : 410).end();
  }

  function status(req, res) {
    res.json({ listening: !!listener, projectId: listener?.projectId || null, since: listener?.since || null, tokenFile: file });
  }

  return {
    tokenFile: file,
    mount(app) {
      app.get('/api/canvas/stream', stream);
      app.get('/api/canvas/status', status);
      app.post('/api/canvas/request', request);
      app.post('/api/canvas/reply', reply);
    },
  };
}

module.exports = { createCanvasBridge, tokenFile };
