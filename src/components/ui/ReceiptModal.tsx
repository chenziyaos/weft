import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { ScrollText, X } from 'lucide-react';
import { useStore } from '../../store';
import { useT, fmt } from '../../i18n';
import { askContext } from '../../store/context-builder';
import { shownStaleIds } from '../../lib/stale-judge';
import { loadReceipt, type Receipt } from '../../lib/receipts';
import { requestRows, type RowKind } from '../../lib/request-view';
import RequestRows from './RequestRows';

// Kinds whose text is decided at send time, not by the graph: they cannot
// "change since" in the sense the graph means.
const SEND_TIME: ReadonlySet<RowKind> = new Set(['addition', 'memory', 'recall', 'ask']);

/** The request one answer version was generated from, with the rows that no
    longer read the same in this node's context today. */
export default function ReceiptModal({ nodeId, at, model, onClose }: { nodeId: string; at: string | undefined; /** who answered, when the request named no model (the server default) */ model?: string; onClose: () => void }) {
  const t = useT();
  const nodes = useStore((s) => s.nodes);
  const edges = useStore((s) => s.edges);
  const [receipt, setReceipt] = useState<Receipt | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void loadReceipt(nodeId, at).then((r) => { if (live) setReceipt(r); }).catch(() => { if (live) setReceipt(null); });
    return () => { live = false; };
  }, [nodeId, at]);

  const rows = useMemo(() => (receipt ? requestRows(receipt.additions, receipt.messages) : []), [receipt]);
  const changed = useMemo(() => {
    const out = new Set<number>();
    if (!receipt || !nodes.some((n) => n.id === nodeId)) return out;
    const st = useStore.getState();
    const now = new Set(askContext(nodeId, nodes, edges, shownStaleIds(st)).messages.map((m) => m.content));
    rows.forEach((r, i) => { if (!SEND_TIME.has(r.kind) && !now.has(r.content)) out.add(i); });
    return out;
  }, [receipt, rows, nodes, edges, nodeId]);

  const tokens = rows.reduce((n, r) => n + r.tokens, 0);
  return createPortal((
    <div className="fixed inset-0 z-[60] bg-ink/30 backdrop-blur-sm flex items-center justify-center p-6" onClick={onClose}>
      <div className="bg-card rounded-2xl shadow-2xl border border-line w-[680px] max-h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()} data-receipt-modal>
        <div className="flex items-center gap-2 px-5 py-3 border-b border-line shrink-0">
          <ScrollText size={15} strokeWidth={1.75} className="text-accent" />
          <span className="text-sm font-semibold text-ink">{t('receipt.title')}</span>
          {receipt && (
            <span className="text-2xs text-ink-faint truncate">
              {fmt(t('receipt.meta'), { at: new Date(receipt.at).toLocaleString(), model: receipt.model || model || '—', n: rows.length, tok: tokens })}
            </span>
          )}
          <div className="flex-1" />
          <button onClick={onClose} className="text-ink-faint hover:text-ink w-7 h-7 rounded-lg hover:bg-wash flex items-center justify-center transition-colors">
            <X size={15} strokeWidth={1.75} />
          </button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto py-1.5">
          {receipt === undefined && <p className="px-5 py-3 text-xs text-ink-faint">{t('receipt.loading')}</p>}
          {receipt === null && <p className="px-5 py-3 text-xs text-ink-faint" data-receipt-none>{t('receipt.none')}</p>}
          {receipt && (
            <>
              {(changed.size > 0 || receipt.incomplete) && (
                <p className="px-5 pb-1.5 text-2xs text-amber-600">
                  {[changed.size > 0 ? t('receipt.changedNote') : '', receipt.incomplete ? t('receipt.incomplete') : ''].filter(Boolean).join(' ')}
                </p>
              )}
              <RequestRows rows={rows} images={receipt.images.length} changed={changed} note={receipt.lane === 'agent' ? t('req.agentNote') : undefined} />
            </>
          )}
        </div>
      </div>
    </div>
  ), document.body);
}
