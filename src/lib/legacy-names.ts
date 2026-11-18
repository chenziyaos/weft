// Names the product shipped under before Weft. Only data migration may use
// them: brand-migration.ts (browser storage), import of old backup files, and
// runtime/legacy-home.cjs (on-disk data). No other code spells them.

export const LEGACY_NAMES = ['thoughtpath', 'thoughtdag'] as const;
const ALT = LEGACY_NAMES.join('|');

/** The current key for a storage key written under a legacy prefix. */
export function rebrandKey(key: string): string | null {
  for (const old of LEGACY_NAMES) {
    if (key === old) return 'weft';
    if (key.startsWith(old) && /[.:]/.test(key[old.length])) return 'weft' + key.slice(old.length);
  }
  return null;
}

const QUOTED = new RegExp(`(\\\\*")(?:${ALT})(?=[.:"\\\\-])`, 'g');
const LEADING = new RegExp(`^(?:${ALT})(?=[.:-]|$)`);
const URIS = new RegExp(`\\b(?:${ALT})(?=://|:attachment/)`, 'g');

/** Rewrites identifiers inside a stored string: format/schema ids, runner
 *  ids and event ids (any JSON string value that starts with a legacy name,
 *  at any escaping depth), plus deep links and attachment URIs anywhere in
 *  text. Prose that merely mentions the old name mid-sentence is left alone. */
export function rebrandText(s: string): string {
  return s.replace(QUOTED, '$1weft').replace(URIS, 'weft').replace(LEADING, 'weft');
}

/** Deep-rewrites plain JSON-like values; structured-clone objects that are
 *  not plain (Blob, FileSystemHandle, ArrayBuffer…) pass through untouched. */
export function rebrandValue<T>(value: T): T {
  if (typeof value === 'string') return rebrandText(value) as T;
  if (Array.isArray(value)) return value.map(rebrandValue) as T;
  if (value && typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return value;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = rebrandValue(v);
    return out as T;
  }
  return value;
}

/** Canvas backup suffix, current or legacy. */
export const CANVAS_FILE_SUFFIX = new RegExp(`\\.(?:weft|${ALT})\\.json$`, 'i');

export const stripCanvasSuffix = (name: string): string => name.replace(CANVAS_FILE_SUFFIX, '');
