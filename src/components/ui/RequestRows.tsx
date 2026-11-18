import { useState } from 'react';
import { ClipboardCopy } from 'lucide-react';
import { useT, fmt } from '../../i18n';
import { copyText } from '../../lib/export';
import { requestText, type RequestRow, type RowKind } from '../../lib/request-view';

const KIND_STYLES: Partial<Record<RowKind, string>> = {
  addition: 'bg-wash text-ink-faint',
  role: 'bg-accent/10 text-accent',
  answer: 'bg-line/60 text-ink-muted',
  ask: 'bg-accent/15 text-accent',
  memory: 'bg-warm/10 text-warm',
  recall: 'bg-warm/10 text-warm',
};

function useKindLabels(): Record<RowKind, string> {
  const t = useT();
  return {
    addition: t('req.kind.addition'), role: t('req.kind.role'), material: t('req.kind.material'),
    reference: t('req.kind.reference'), question: t('req.kind.question'), answer: t('req.kind.answer'),
    passage: t('req.kind.passage'), memory: t('req.kind.memory'), recall: t('req.kind.recall'), ask: t('req.kind.ask'),
  };
}

/** A request, row by row: each row opens to its full text. `changed` marks
    rows (by index) that no longer read the same today. */
export default function RequestRows({ rows, images, changed, note }: {
  rows: RequestRow[];
  images?: number;
  changed?: ReadonlySet<number>;
  note?: string;
}) {
  const t = useT();
  const labels = useKindLabels();
  // open rows are remembered by kind and text, not position: a row appearing
  // above (a setting switched while the list is open) must not shift them
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const keyOf = (r: RequestRow) => `${r.kind}\u0000${r.content}`;
  const toggle = (k: string) => setOpen((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  return (
    <div data-request-rows>
      {rows.map((r, i) => (
        <div key={i} className="border-b border-line/50 last:border-0" data-request-row={r.kind} data-pending={r.pending ? '' : undefined} data-changed={changed?.has(i) ? '' : undefined}>
          <button
            onClick={() => !r.pending && toggle(keyOf(r))}
            className="w-full flex items-start gap-2 px-3 py-1.5 text-xs text-left hover:bg-wash/60 transition-colors"
            title={r.pending ? undefined : t('req.expandTitle')}
          >
            <span className={`shrink-0 px-1.5 py-0.5 rounded text-2xs ${KIND_STYLES[r.kind] ?? 'bg-wash text-ink-muted'}`}>{labels[r.kind]}</span>
            <span className={`flex-1 min-w-0 leading-snug break-words ${r.pending ? 'text-ink-faint italic' : 'text-ink-muted'}`}>
              {r.pending ? t('req.recallPending') : open.has(keyOf(r)) ? null : `${r.content.replace(/\s+/g, ' ').slice(0, 90)}${r.content.length > 90 ? '…' : ''}`}
            </span>
            {changed?.has(i) && <span className="shrink-0 text-2xs text-amber-600">{t('receipt.changed')}</span>}
            {!r.pending && <span className="shrink-0 text-2xs text-ink-faint font-mono">{r.tokens}</span>}
          </button>
          {open.has(keyOf(r)) && (
            <pre className="mx-3 mb-2 px-2.5 py-2 text-2xs leading-relaxed text-ink-muted bg-wash rounded-lg whitespace-pre-wrap break-words max-h-64 overflow-y-auto font-sans" data-request-full>
              {r.content}
            </pre>
          )}
        </div>
      ))}
      <div className="flex items-center gap-2 px-3 py-1.5 text-2xs text-ink-faint">
        {images ? <span>{fmt(t('req.images'), { n: images })}</span> : null}
        {note && <span className="flex-1 min-w-0">{note}</span>}
        <span className="flex-1" />
        <button
          onClick={() => void copyText(requestText(rows, labels, t('req.recallPending')))}
          className="inline-flex items-center gap-1 hover:text-accent transition-colors"
          data-copy-request
        >
          <ClipboardCopy size={12} strokeWidth={1.75} /> {t('req.copyAll')}
        </button>
      </div>
    </div>
  );
}
