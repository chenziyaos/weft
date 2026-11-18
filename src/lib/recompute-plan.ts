import type { ThoughtNode, ThoughtEdge } from '../types';
import { partitionContext } from './graph';

const NON_GENERATING = new Set(['note', 'file', 'link', 'frame']);

export interface RecomputePlan {
  /** Every affected node, in an order where each comes after what it reads. */
  plan: string[];
  /** Affected nodes in a recompute cycle (a reference loop): no honest order exists. */
  blocked: string[];
  /** For each generating node, the nodes it reads (mainline, quote sources, trails). */
  dependsOn: Map<string, string[]>;
}

/**
 * Recompute plan, ONE WAVE, from what actually flows.
 * Direct content changes (an upstream node's stored answer/question, image
 * pixels, the branch passage) are already caught per-node by the exact
 * fingerprint comparison — they arrive here as `stale`. The flood only adds
 * the SOLID conversation continuation: when a turn refreshes, the turns
 * structurally after it re-run even though their stored inputs do not yet
 * contain the new answer. Reference boundaries never propagate speculatively
 * — an external node is pulled in only when it is itself an originally stale
 * quote SOURCE, which is how a reference loop surfaces as blocked.
 */
export function recomputePlan(nodes: ThoughtNode[], edges: ThoughtEdge[], stale: string[]): RecomputePlan {
  type Dep = { id: string; ch: 'solid' | 'ref-source' | 'trail' };
  const dependencies = new Map<string, Dep[]>();
  for (const n of nodes.filter(n => !n.data.archived && !NON_GENERATING.has(n.data.stepKind ?? ''))) {
    const p = partitionContext(n.id, nodes, edges);
    dependencies.set(n.id, [
      ...p.mainline.filter(x => x.id !== n.id && !x.data.archived).map(x => ({ id: x.id, ch: 'solid' as const })),
      ...p.references.filter(r => !r.source.data.archived).flatMap(r => [
        { id: r.source.id, ch: 'ref-source' as const },
        // chain nodes render only as a one-line question trail (quote) or a
        // transcript (full), but a fresh change on them is already reflected
        // in the exact fingerprint — the flood never forwards them blindly
        ...r.chain.filter(x => !x.data.archived).map(x => ({ id: x.id, ch: 'trail' as const })),
      ]),
    ]);
  }
  const originalStale = new Set(stale);
  const affected = new Set(stale);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, deps] of dependencies) {
      if (affected.has(id)) continue;
      const reachable = deps.some((dep) =>
        dep.ch === 'solid' ? affected.has(dep.id)
        : dep.ch === 'ref-source' ? originalStale.has(dep.id)
        : false);
      if (reachable) { affected.add(id); changed = true; }
    }
  }
  const plan: string[] = [];
  const remaining = new Set(affected);
  while (remaining.size) {
    const ready = [...remaining].filter(id => !(dependencies.get(id) ?? []).some(d => remaining.has(d.id)));
    if (!ready.length) break;
    for (const id of ready) { plan.push(id); remaining.delete(id); }
  }
  const dependsOn = new Map([...dependencies].map(([id, deps]) => [id, deps.map(d => d.id)]));
  return { plan, blocked: [...remaining], dependsOn };
}
