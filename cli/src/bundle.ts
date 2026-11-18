// Bundle store — the on-disk, offline shape of a Context Bundle. Mirrors
// `~/.weft/fact-index.json` semantics: id-addressed, tagged via symlinks,
// recoverable byte-for-byte from `bundle.json`. Text goes out via
// `renderHandoffMarkdown`, so what `weft bundle pull` prints is exactly what
// the in-app `Copy context for a CLI session` puts on the clipboard — one
// projection, one truth.
//
// Storage layout (created by `publish`, consumed by `pull`/`show`/`list`):
//   ~/.weft/bundles/<cb_hash16>/{bundle.json,bundle.md}
//   ~/.weft/bundles/tags/<tag>            (symlink → ../<cb_hash16>)
// `tags/` is a *lookup aid*, never the source of truth.

import { promises as fsp, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// We cannot reuse the in-app helper directly: it imports Zustand stores.
// The rules below are quote-for-quote the same as
// src/lib/experiment-loop.ts:31 + renderHandoffMarkdown, minus React.
export interface ExperimentAnchor {
  project: string;
  node: string;
  bundle: string;
  mode: 'branch' | 'continue';
}

export interface BundleRecord { jsonPath: string; mdPath: string; id: string }

const ID_RE = /^cb_[0-9a-f]{16}$/;
const TAG_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

const HOME = (): string => process.env.WEFT_HOME ?? path.join(os.homedir(), '.weft');
export const BUNDLES_DIR = (): string => path.join(HOME(), 'bundles');
export const TAGS_DIR = (): string => path.join(BUNDLES_DIR(), 'tags');

export function isBundleId(ref: string): boolean { return ID_RE.test(ref); }
export function isValidTag(tag: string): boolean { return TAG_RE.test(tag) && !tag.includes('/'); }

async function ensureDir(p: string): Promise<void> { await fsp.mkdir(p, { recursive: true, mode: 0o700 }); }

async function symlinkTag(tagDir: string, tag: string, id: string): Promise<void> {
  const link = path.join(tagDir, tag);
  const target = path.join('..', id); // relative is what survives tar/rsync moves
  await fsp.rm(link, { force: true });
  try {
    await fsp.symlink(target, link);
  } catch (err) {
    // Windows without Developer Mode: fall back to a one-line JSON pointer.
    if ((err as NodeJS.ErrnoException).code !== 'EPERM' && (err as NodeJS.ErrnoException).code !== 'ENOSYS' && (err as NodeJS.ErrnoException).code !== 'EACCES') throw err;
    await fsp.writeFile(link, JSON.stringify({ id }) + '\n', { mode: 0o600 });
  }
}

async function resolveTag(tagDir: string, tag: string): Promise<string | null> {
  const p = path.join(tagDir, tag);
  if (!existsSync(p)) return null;
  const st = await fsp.lstat(p);
  if (st.isSymbolicLink()) {
    const target = await fsp.readlink(p);
    const id = path.basename(target);
    return isBundleId(id) ? id : null;
  }
  // windows fallback file
  try {
    const v = JSON.parse(await fsp.readFile(p, 'utf8')) as { id?: unknown };
    return typeof v.id === 'string' && isBundleId(v.id) ? v.id : null;
  } catch { return null; }
}

/** Resolve a ref — bare id or tag — to a bundle id. Throws on ambiguous or
 *  dangling refs; callers list tags when resolution fails with a hint. */
export async function resolveRef(ref: string): Promise<{ id: string; via: 'id' | 'tag' }> {
  if (isBundleId(ref)) {
    if (existsSync(path.join(BUNDLES_DIR(), ref, 'bundle.json'))) return { id: ref, via: 'id' };
    throw new Error(`bundle ${ref} not found under ${BUNDLES_DIR()}`);
  }
  const id = await resolveTag(TAGS_DIR(), ref);
  if (!id) throw new Error(`no bundle named "${ref}" — list with: weft bundle list`);
  return { id, via: 'tag' };
}

export async function bundleRecord(id: string): Promise<BundleRecord> {
  const dir = path.join(BUNDLES_DIR(), id);
  return { jsonPath: path.join(dir, 'bundle.json'), mdPath: path.join(dir, 'bundle.md'), id };
}

export interface SaveBundleInput { id: string; json: string; markdown: string; tag?: string | null }
export async function saveBundle(input: SaveBundleInput): Promise<BundleRecord> {
  if (!isBundleId(input.id)) throw new Error(`bundle id must match ${ID_RE}, got ${input.id}`);
  const rec = await bundleRecord(input.id);
  await ensureDir(path.dirname(rec.jsonPath));
  await fsp.writeFile(rec.jsonPath, input.json, { mode: 0o600 });
  await fsp.writeFile(rec.mdPath, input.markdown, { mode: 0o600 });
  if (input.tag) {
    if (!isValidTag(input.tag)) throw new Error(`invalid tag "${input.tag}" — letters/digits, '.', '_', '-', ≤64 chars, no slashes`);
    await ensureDir(TAGS_DIR());
    await symlinkTag(TAGS_DIR(), input.tag, rec.id);
  }
  return rec;
}

export interface ListEntry { id: string; tags: string[]; created_at?: string; project?: string | null; target_node?: string; estimated_tokens?: number; content_hash?: string }

export async function listBundles(): Promise<ListEntry[]> {
  const dir = BUNDLES_DIR();
  if (!existsSync(dir)) return [];
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const tagToId = new Map<string, string[]>();
  const tagDir = TAGS_DIR();
  if (existsSync(tagDir)) {
    for (const t of await fsp.readdir(tagDir)) {
      const id = await resolveTag(tagDir, t);
      if (!id) continue;
      tagToId.set(id, [...(tagToId.get(id) ?? []), t]);
    }
  }
  const out: ListEntry[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || !isBundleId(e.name)) continue;
    const rec = await bundleRecord(e.name);
    let meta: Partial<{ created_at: string; graph: { project_id: string | null; target_node_id: string }; budget: { estimated_tokens: number }; integrity: { content_hash: string } }> = {};
    try { meta = JSON.parse(await fsp.readFile(rec.jsonPath, 'utf8')) as typeof meta; } catch { /* tolerate */ }
    out.push({
      id: e.name,
      tags: tagToId.get(e.name)?.sort() ?? [],
      created_at: meta.created_at,
      project: meta.graph?.project_id ?? null,
      target_node: meta.graph?.target_node_id,
      estimated_tokens: meta.budget?.estimated_tokens,
      content_hash: meta.integrity?.content_hash,
    });
  }
  out.sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? ''));
  return out;
}

export async function readBundleMarkdown(id: string): Promise<string> {
  return fsp.readFile((await bundleRecord(id)).mdPath, 'utf8');
}
export async function readBundleJson(id: string): Promise<string> {
  return fsp.readFile((await bundleRecord(id)).jsonPath, 'utf8');
}

// English-only twin of src/lib/experiment-loop.ts:renderHandoffMarkdown —
// the UI picks translations via i18n; the CLI projection stays English so a
// bundle shared across machines does not depend on the receiving user's
// locale. Keys are inlined (not imported from src/i18n) so the bundle can
// stay CommonMark text and the CLI bundle does not pull i18n machinery.
export function renderHandoffMarkdown(
  bundle: { context: { messages: { source: { layer: string }; role: string; content: { text: string }[] }[] }; id: string },
  anchor: ExperimentAnchor,
): string {
  const out: string[] = [];
  out.push('The following is existing context compiled from my thought graph (Weft), the working basis for this session. Read it fully, confirm your understanding, then wait for my experiment instructions.');
  out.push('');
  for (const item of bundle.context.messages) {
    const text = item.content[0].text;
    switch (item.source.layer) {
      case 'system':
        out.push(`**Role constraint:** ${text}`);
        break;
      case 'chain':
        out.push(item.role === 'assistant' ? `**A:** ${text}` : `**Q:** ${text}`);
        break;
      default:
        out.push(text);
    }
    out.push('');
  }
  out.push('---');
  out.push('That is all existing context. The anchor line below carries this session\'s yield back to the thought graph afterwards — leave it as is (no action needed).');
  out.push('');
  out.push(`[Weft anchor: project=${anchor.project} node=${anchor.node} bundle=${anchor.bundle}${anchor.mode === 'continue' ? ' mode=continue' : ''}]`);
  return out.join('\n');
}
