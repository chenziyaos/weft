import { createStore, del, entries, get, set } from 'idb-keyval';
import { rebrandKey, rebrandText, rebrandValue } from './legacy-names';
import { isViewerMode } from './viewer';

// One-time move of browser data written under the product's previous names.
// localStorage moves synchronously at import — ui-store reads its keys at
// module load — so main.tsx imports this module before anything else.

function migrateLocalStorage(): void {
  let ls: Storage;
  try { ls = window.localStorage; } catch { return; }
  const moves: [string, string][] = [];
  for (let i = 0; i < ls.length; i++) {
    const k = ls.key(i);
    const next = k ? rebrandKey(k) : null;
    if (k && next) moves.push([k, next]);
  }
  for (const [from, to] of moves) {
    try {
      const v = ls.getItem(from);
      if (v == null || ls.getItem(to) != null) continue;
      ls.setItem(to, rebrandText(v));
      ls.removeItem(from);
    } catch { /* quota: leave the old key for the next start */ }
  }
}

async function migrateIndexedDb(): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  const store = createStore('keyval-store', 'keyval');
  for (const [k, v] of await entries(store)) {
    if (typeof k !== 'string') continue;
    const next = rebrandKey(k);
    if (!next || (await get(next, store)) !== undefined) continue;
    await set(next, rebrandValue(v), store);
    await del(k, store);
  }
}

if (!isViewerMode) migrateLocalStorage();

/** Resolves once old IndexedDB keys have moved; every boot path that reads
 *  persisted canvases awaits it. A failure leaves old keys in place. */
export const legacyStorageMigrated: Promise<void> = isViewerMode
  ? Promise.resolve()
  : migrateIndexedDb().catch((err) => {
    console.warn('[weft] legacy storage migration failed:', err);
  });
