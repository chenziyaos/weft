import type { Attachment } from '../types';

// 纯函数供浏览器和 Node 共用；不要从此模块引入文件读取器或 UI 状态。

/**
 * djb2 over a string, returned as base36. Full-payload content hashes are
 * how two attachments with the SAME name and size but different bytes are
 * told apart (the fixture uses two equal-length PNGs whose pixels differ).
 */
export function contentHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** Cache payload hashes per attachment object identity: hashing every large
 *  base64 blob on every context build would be quadratic. New object
 *  identities produced by edits simply rehash — the cache can never serve
 *  stale content for a mutated attachment. */
const hashCache = new WeakMap<Attachment, string>();

export function attachmentPayloadHash(att: Attachment): string {
  let h = hashCache.get(att);
  if (h === undefined) {
    h = contentHash([att.type, att.content ?? '', att.extractedText ?? '', att.renderMode ?? 'full'].join('|'));
    hashCache.set(att, h);
  }
  return h;
}

export function attachmentFingerprint(att: Attachment): string {
  // identity = name + size + a hash of the ENTIRE payload (not the first
  // 100 characters): two distinct images of equal length must not dedupe
  // against each other, and a same-name replacement must not look identical.
  return `${att.name}|${att.size}|${attachmentPayloadHash(att)}`;
}
