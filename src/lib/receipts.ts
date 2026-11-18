import { get as idbGet, getMany, setMany, set as idbSet } from 'idb-keyval';
import type { ContextMessage, ImageAttachment, ToolPrefs } from './api';
import { sha256Hex } from './context-bundle';
import { systemAdditions, type Lane } from './request-view';

// The receipt of one answer version: the request exactly as it left, kept
// so the answer can still show what it read after its upstream has moved
// on. Message texts are content-addressed (`ctx-blob:<sha256>`): the same
// ancestor turn or PDF text read by fifty answers is stored once. Images
// are kept as type + digest only; their bytes stay on the nodes.
//
// Local to this browser profile, like the canvas itself; exports and
// shares do not carry receipts.

const RECEIPT = 'gen-receipt:';
const BLOB = 'ctx-blob:';
const known = new Set<string>();

interface StoredReceipt {
  v: 1;
  model: string;
  lane: Lane;
  tools: ToolPrefs;
  /** blob hashes: the lane's system additions, then the messages in order */
  additions: string[];
  messages: { role: ContextMessage['role']; h: string }[];
  images: { type: string; sha: string }[];
}

export interface Receipt {
  at: string;
  model: string;
  lane: Lane;
  tools: ToolPrefs;
  additions: string[];
  messages: ContextMessage[];
  images: { type: string; sha: string }[];
  /** Some message texts could not be read back (storage cleared). */
  incomplete: boolean;
}

export interface DispatchPayload {
  messages: ContextMessage[];
  images: ImageAttachment[];
  model: string;
  toolPrefs: ToolPrefs;
  lane: Lane;
}

const receiptKey = (nodeId: string, at: string) => `${RECEIPT}${nodeId}@${at}`;

async function intern(texts: string[]): Promise<string[]> {
  const hashes = await Promise.all(texts.map((t) => sha256Hex(t)));
  const fresh = new Map<string, string>();
  hashes.forEach((h, i) => { if (!known.has(h)) fresh.set(h, texts[i]); });
  if (fresh.size) {
    const ids = [...fresh.keys()];
    const present = await getMany(ids.map((h) => BLOB + h));
    const missing = ids.filter((_, i) => present[i] === undefined);
    if (missing.length) await setMany(missing.map((h) => [BLOB + h, fresh.get(h)!]));
    ids.forEach((h) => known.add(h));
  }
  return hashes;
}

/** Keep the request behind the answer version generated at `at`. */
export async function saveReceipt(nodeId: string, at: string, p: DispatchPayload): Promise<void> {
  const additions = systemAdditions(p.lane, p.toolPrefs, new Date(at));
  const [addHashes, msgHashes, images] = await Promise.all([
    intern(additions),
    intern(p.messages.map((m) => m.content)),
    Promise.all(p.images.map(async (img) => ({ type: img.mimeType, sha: await sha256Hex(img.data ?? '') }))),
  ]);
  const record: StoredReceipt = {
    v: 1, model: p.model, lane: p.lane, tools: { web: !!p.toolPrefs.web, scholar: !!p.toolPrefs.scholar, mcp: !!p.toolPrefs.mcp },
    additions: addHashes,
    messages: p.messages.map((m, i) => ({ role: m.role, h: msgHashes[i] })),
    images,
  };
  await idbSet(receiptKey(nodeId, at), record);
}

/** The request behind one answer version, or null when none was kept
    (generated before receipts existed, or in another browser). */
export async function loadReceipt(nodeId: string, at: string | undefined): Promise<Receipt | null> {
  if (!at) return null;
  const rec = await idbGet<StoredReceipt>(receiptKey(nodeId, at));
  if (!rec || rec.v !== 1) return null;
  const all = [...rec.additions, ...rec.messages.map((m) => m.h)];
  const texts = await getMany<string>(all.map((h) => BLOB + h));
  const incomplete = texts.some((x) => x === undefined);
  const additions = texts.slice(0, rec.additions.length).map((x) => x ?? '');
  const messages = rec.messages.map((m, i) => ({ role: m.role, content: texts[rec.additions.length + i] ?? '' }));
  return { at, model: rec.model, lane: rec.lane, tools: rec.tools, additions, messages, images: rec.images, incomplete };
}
