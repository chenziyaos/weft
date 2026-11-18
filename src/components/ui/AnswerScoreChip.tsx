import { useMemo } from 'react';
import { shownScore } from '../../store/branch-score';
import { ANSWER_ADEQUATE_BAR } from '../../lib/judge';
import type { ThoughtData } from '../../types';
import { useT, fmt } from '../../i18n';

// The decision model's verdict on this answer among its sibling answers, as
// one chip in the answer's footer. The hover spells out every number; the
// chip itself says only best / possibly off / the quality level.
export default function AnswerScoreChip({ data }: { data: ThoughtData }) {
  const t = useT();
  const s = useMemo(() => shownScore(data), [data]);
  if (!s) return null;
  const pct = (p: number) => Math.round(p * 100);
  const q = s.quality.toFixed(1);
  const weak = s.adequate < ANSWER_ADEQUATE_BAR;
  const top = !weak && s.rank === 1 && s.peers > 1;
  const label = weak ? t('score.weak') : top ? fmt(t('score.best'), { q }) : fmt(t('score.level'), { q });
  const title = [
    fmt(t('score.titleHead'), { m: s.model || 'judge' }) + (s.calibrated ? '' : ` · ${t('judge.uncalibrated')}`),
    fmt(t('score.titleAdequate'), { p: pct(s.adequate) }),
    fmt(t('score.titleQuality'), { q, p0: pct(s.levels[0] ?? 0), p1: pct(s.levels[1] ?? 0), p2: pct(s.levels[2] ?? 0), p3: pct(s.levels[3] ?? 0) }),
    fmt(t('score.titleBest'), { n: s.peers, p: pct(s.best), r: s.rank }),
    t('score.titleNote'),
  ].join('\n');
  const cls = weak ? 'text-red-500 bg-red-500/10' : top ? 'text-accent bg-accent/10' : 'text-ink-muted bg-wash';
  return (
    <span className={`text-2xs font-mono px-1.5 py-0.5 rounded-full ml-1 shrink-0 cursor-help ${cls}`} title={title} data-answer-score={weak ? 'weak' : top ? 'best' : 'ok'} data-answer-rank={s.rank}>
      {label}
    </span>
  );
}
