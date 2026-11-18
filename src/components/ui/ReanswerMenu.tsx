import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronsUp } from 'lucide-react';
import { useModels, describeModel } from '../../lib/use-models';
import { isAgentModel } from '../../lib/agents/agent-runtime';
import { useStore } from '../../store';
import { useT } from '../../i18n';

// Answer this turn again with another model: same context, the new answer
// appended as a version beside the first, which stays. Agent turns never get
// this: running them again would run their edits and commands twice.

// Names that read as a vendor's larger tier come first, the small fast tiers last.
const strength = (id: string): number => {
  const s = id.toLowerCase();
  if (/flash|mini|lite|nano|haiku|air|small|tiny/.test(s)) return 0;
  if (/max|pro|opus|ultra|terra|large|k3/.test(s)) return 2;
  return 1;
};

export default function ReanswerMenu({ nodeId, current }: { nodeId: string; current?: string | null }) {
  const t = useT();
  const models = useModels();
  const rerunNode = useStore((s) => s.rerunNode);
  const [open, setOpen] = useState<{ left: number; top: number } | null>(null);
  const root = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { const el = e.target as Node; if (!root.current?.contains(el) && !menu.current?.contains(el)) setOpen(null); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(null); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', key); };
  }, [open]);
  const choices = (models?.models ?? [])
    .filter((m) => !isAgentModel(m.id) && m.id !== current)
    .map((m, i) => ({ m, i, s: strength(m.id) }))
    .sort((a, b) => b.s - a.s || a.i - b.i);
  if (choices.length === 0) return null;
  const pick = (id: string) => { setOpen(null); void rerunNode(nodeId, { model: id }); };
  return (
    <>
      <button
        ref={root}
        type="button"
        // a portal on the body, placed by the button's rect: inside the card it would sit under the next card
        onClick={(e) => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); setOpen((v) => (v ? null : { left: Math.max(8, Math.min(r.left, window.innerWidth - 280)), top: Math.min(r.bottom + 6, window.innerHeight - 320) })); }}
        className="rounded-full w-6 h-6 flex items-center justify-center hover:text-accent hover:bg-wash transition-colors"
        title={t('reanswer.button')}
        aria-expanded={!!open}
        data-reanswer
      >
        <ChevronsUp size={14} strokeWidth={1.75} />
      </button>
      {open && createPortal(
        <div ref={menu} style={{ position: 'fixed', left: open.left, top: open.top }} className="w-[272px] rounded-xl border border-line bg-card shadow-lg p-2 z-[90] text-xs" data-reanswer-menu onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}>
          <div className="px-1.5 pt-0.5 pb-1.5 text-ink font-medium">{t('reanswer.title')}</div>
          <div className="px-1.5 pb-2 text-2xs text-ink-faint leading-relaxed">{t('reanswer.hint')}</div>
          <div className="max-h-[220px] overflow-y-auto space-y-0.5">
            {choices.map(({ m, s }) => (
              <button key={m.id} type="button" onClick={() => pick(m.id)} className="w-full text-left px-1.5 py-1 rounded-md hover:bg-wash flex items-center gap-2" data-reanswer-model={m.id}>
                <span className="font-mono text-ink truncate flex-1">{describeModel(m.id)}</span>
                {s === 2 && <span className="text-2xs text-accent shrink-0">{t('reanswer.stronger')}</span>}
              </button>
            ))}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
