// Sibling answers judged together: after a multi-model fan-out, the decision
// model reads every branch's answer against the shared question and says how
// well each one answers it and which answers it best. The verdict is written
// on the cards as a hint. It enters no context and decides nothing on its own:
// a decision model can rate a flawed answer acceptable.
import type { StoreApi } from 'zustand';
import type { StoreState } from './types';
import type { JudgeScore } from '../types';
import { decideAnswers, judgeAvailable } from '../lib/judge';
import { contentHash } from '../lib/attachment-fingerprint';

type Set = StoreApi<StoreState>['setState'];
type Get = StoreApi<StoreState>['getState'];

const running = new Map<string, Promise<void>>();

/** Judge the answers of `ids` against `question`; ids without a finished answer are left out. */
export async function scoreBranches(set: Set, get: Get, ids: string[], question: string, group: string): Promise<void> {
  if (!judgeAvailable()) return;
  const prev = running.get(group);
  if (prev) await prev.catch(() => undefined);
  const job = (async () => {
    const members = ids
      .map((id) => get().nodes.find((n) => n.id === id))
      .filter((n): n is NonNullable<typeof n> => !!n && !n.data.isLoading && !n.data.generationFailed && !!n.data.response?.trim());
    if (members.length < 2) return;
    const answers = members.map((n) => ({ id: n.id, text: n.data.response }));
    const fps = Object.fromEntries(answers.map((a) => [a.id, contentHash(a.text)]));
    let r: Awaited<ReturnType<typeof decideAnswers>>;
    try { r = await decideAnswers(question, answers); } catch { return; }
    const order = [...answers].sort((a, b) => (r.verdicts[b.id]?.best ?? 0) - (r.verdicts[a.id]?.best ?? 0));
    const at = new Date().toISOString();
    set((s) => ({
      nodes: s.nodes.map((n) => {
        const v = r.verdicts[n.id];
        // an answer replaced while the judge was reading is not the one it judged
        if (!v || contentHash(n.data.response ?? '') !== fps[n.id]) return n;
        const score: JudgeScore = {
          group, question: question.slice(0, 2000), fp: fps[n.id],
          adequate: v.adequate, quality: v.quality, levels: v.levels,
          best: v.best, rank: order.findIndex((a) => a.id === n.id) + 1, peers: answers.length,
          model: r.model, calibrated: r.calibrated, at,
        };
        return { ...n, data: { ...n.data, judgeScore: score } };
      }),
    }));
  })();
  running.set(group, job);
  try { await job; } finally { if (running.get(group) === job) running.delete(group); }
}

/** One member of a judged set was answered again: judge the set anew. */
export function rescoreGroupOf(set: Set, get: Get, nodeId: string): void {
  const score = get().nodes.find((n) => n.id === nodeId)?.data.judgeScore;
  if (!score) return;
  const ids = get().nodes.filter((n) => n.data.judgeScore?.group === score.group && !n.data.archived).map((n) => n.id);
  void scoreBranches(set, get, ids, score.question, score.group);
}

/** The card shows a verdict only for the answer it was given on. */
export function shownScore(data: { judgeScore?: JudgeScore; response?: string; isLoading?: boolean }): JudgeScore | null {
  const s = data.judgeScore;
  if (!s || data.isLoading || !data.response) return null;
  return contentHash(data.response) === s.fp ? s : null;
}
