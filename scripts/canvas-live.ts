// Live canvas commands: talk to the canvas page through the local server's
// bridge (runtime/canvas-bridge.cjs). Only these canvas-* commands use the
// network, and only the loopback URL recorded in the bridge token file.
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { HostHandoffError } from '../src/lib/host-handoff';

type Bridge = { url: string; token: string };

function fail(code: string, message: string): never { throw new HostHandoffError(code, message); }

export function bridgeFile(): string {
  return join(process.env.WEFT_HOME || join(homedir(), '.weft'), 'canvas-bridge.json');
}

async function bridge(): Promise<Bridge> {
  const file = bridgeFile();
  let raw: string;
  try { raw = await readFile(file, 'utf8'); }
  catch { return fail('NO_SERVER', `No bridge token at ${file}. Start the canvas: weft serve (from source: npm run server), or the desktop app.`); }
  const value = JSON.parse(raw) as Partial<Bridge>;
  const url = new URL(String(value.url));
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) fail('NOT_LOOPBACK', `Bridge URL must be loopback, got ${url.hostname}`);
  if (typeof value.token !== 'string' || !value.token) fail('NO_SERVER', `Malformed bridge token file ${file}`);
  return { url: url.origin, token: value.token };
}

async function call(path: string, init: RequestInit = {}): Promise<unknown> {
  const b = await bridge();
  let res: Response;
  try {
    res = await fetch(`${b.url}${path}`, { ...init, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${b.token}`, ...init.headers } });
  } catch {
    return fail('NO_SERVER', `The local server at ${b.url} is not reachable. Start the canvas: weft serve (from source: npm run server), or the desktop app.`);
  }
  const body = await res.json().catch(() => null) as { ok?: boolean; result?: unknown; error?: { code?: string; message?: string } } | null;
  if (path === '/api/canvas/status') return body;
  if (!body?.ok) fail(body?.error?.code ?? `HTTP_${res.status}`, body?.error?.message ?? `Bridge request failed (${res.status})`);
  return body.result;
}

export function canvasStatus(): Promise<unknown> {
  return call('/api/canvas/status');
}

export function canvasRequest(kind: 'inspect' | 'edit' | 'compile' | 'apply-result', payload: Record<string, unknown>): Promise<unknown> {
  return call('/api/canvas/request', { method: 'POST', body: JSON.stringify({ kind, payload }) });
}
