import { useState } from 'react';
import { createPortal } from 'react-dom';
import { Eye, Layers, Split, X } from 'lucide-react';
import { useStore } from '../store';
import { effectiveRoles } from '../lib/role-templates';
import { useUiStore } from '../lib/ui-store';
import { useI18n, useT, fmt } from '../i18n';
import { useModels } from '../lib/use-models';
import { isAgentModel } from '../lib/agents/agent-runtime';

// Perspectives dialog: N roles, ONE mechanism, three run policies.
//   once   → each role answers the question once, blind to its siblings
//            (the rule-in/rule-out candidate pool)
//   follow → each role becomes a reviewer on a sliding watch edge that
//            auto-reruns whenever the thread grows (the old "attach
//            evaluator" is exactly this with N=1)
//   models → each picked model answers the question once on its own
//            branch; optionally one synthesis node is wired from all of them
// Roles come from the template library (toggle chips) and/or free-form
// lines ("Name: prompt"). Used from the panel and from fan-out
// placeholder nodes instantiated out of paradigms.
export default function FanOutModal({
  parentId,
  initialQuestion,
  initialRoles,
  onClose,
}: {
  parentId: string;
  initialQuestion: string;
  initialRoles?: { name: string; prompt: string }[];
  onClose: () => void;
}) {
  const fanOut = useStore((s) => s.fanOut);
  const t = useT();
  const lang = useI18n((s) => s.lang);
  const [mode, setMode] = useState<'once' | 'follow' | 'models'>('once');
  const [pickedModels, setPickedModels] = useState<string[]>([]);
  const [synthesize, setSynthesize] = useState(true);
  const modelData = useModels();
  const apiModels = (modelData?.models ?? []).filter((m) => !isAgentModel(m.id));
  const [rounds, setRounds] = useState(1);
  const [question, setQuestion] = useState(initialQuestion);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [customText, setCustomText] = useState(
    (initialRoles ?? []).map((r) => `${r.name}: ${r.prompt}`).join('\n')
  );

  const switchMode = (m: 'once' | 'follow' | 'models') => {
    setMode(m);
    // Each mode has its natural task: the shared question vs a standing critique
    setQuestion(m === 'follow' ? t('fanout.critiqueInstruction') : initialQuestion);
  };

  const customRoles = customText
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const idx = line.indexOf(':');
      return idx > 0
        ? { name: line.slice(0, idx).trim(), prompt: line.slice(idx + 1).trim() }
        : { name: line.slice(0, 24), prompt: line };
    });

  const roleLib = useUiStore((s) => s.roleLib);
  const library = effectiveRoles(lang, roleLib);
  const templateRoles = library.filter((tpl) => picked.has(tpl.id)).map((tpl) => ({
    name: tpl.name,
    prompt: tpl.prompt,
  }));

  const roles = mode === 'models'
    ? pickedModels.map((id) => ({ name: id.split('/').pop() ?? id, prompt: '', model: id }))
    : [...templateRoles, ...customRoles];
  const minRoles = mode === 'models' ? 2 : 1;

  const run = () => {
    if (!question.trim() || roles.length < minRoles) return;
    void fanOut(parentId, question.trim(), roles, {
      follow: mode === 'follow',
      rounds,
      ...(mode === 'models' && synthesize ? { synthesis: t('fanout.synthesisPrompt') } : {}),
    });
    onClose();
  };

  const toggleModel = (id: string) => setPickedModels((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  return createPortal((
    <div className="fixed inset-0 z-50 bg-ink/30 backdrop-blur-sm flex items-center justify-center p-6" onClick={onClose}>
      <div className="bg-card border border-line rounded-2xl shadow-2xl w-full max-w-lg flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="px-6 py-4 border-b border-line flex items-start justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-ink flex items-center gap-2">
              <Split size={16} strokeWidth={1.75} className="text-warm" /> {t('fanout.title')}
            </h2>
            <p className="text-xs text-ink-muted mt-1 leading-relaxed">{t('fanout.subtitle')}</p>
          </div>
          <button onClick={onClose} className="text-ink-faint hover:text-ink transition-colors shrink-0 mt-0.5">
            <X size={16} strokeWidth={1.75} />
          </button>
        </div>

        <div className="px-6 py-4 space-y-4 overflow-y-auto">
          {/* Run policy: answer once (candidates) vs keep reviewing (watchers) */}
          <div>
            <div className="flex gap-1.5">
              {([
                { m: 'once' as const, icon: <Split size={14} strokeWidth={1.75} />, label: t('fanout.modeOnce') },
                { m: 'follow' as const, icon: <Eye size={14} strokeWidth={1.75} />, label: t('fanout.modeFollow') },
                { m: 'models' as const, icon: <Layers size={14} strokeWidth={1.75} />, label: t('fanout.modeModels') },
              ]).map(({ m, icon, label }) => (
                <button
                  key={m}
                  onClick={() => switchMode(m)}
                  className={`text-xs px-3 py-2 rounded-lg transition-colors flex items-center gap-1.5 ${
                    mode === m
                      ? (m === 'follow' ? 'bg-watch/10 text-watch font-medium ring-1 ring-watch/30' : m === 'models' ? 'bg-accent/10 text-accent font-medium ring-1 ring-accent/30' : 'bg-warm/15 text-warm font-medium ring-1 ring-warm/30')
                      : 'bg-wash text-ink-muted hover:bg-line'
                  }`}
                >
                  {icon} {label}
                </button>
              ))}
            </div>
            <p className="text-2xs text-ink-faint mt-1.5 leading-relaxed">
              {t(mode === 'once' ? 'fanout.modeOnceHint' : mode === 'follow' ? 'fanout.modeFollowHint' : 'fanout.modeModelsHint')}
            </p>
            {mode === 'follow' && (
              <div className="mt-2 flex items-center gap-2">
                <span className="text-2xs text-ink-muted">{t('fanout.rounds')}</span>
                {[1, 2, 3].map((r) => (
                  <button
                    key={r}
                    onClick={() => setRounds(r)}
                    className={`text-2xs w-7 h-6 rounded-md transition-colors ${
                      rounds === r ? 'bg-watch/10 text-watch font-medium ring-1 ring-watch/30' : 'bg-wash text-ink-muted hover:bg-line'
                    }`}
                  >
                    {r}×
                  </button>
                ))}
                <span className="text-2xs text-ink-faint">{t('fanout.roundsHint')}</span>
              </div>
            )}
          </div>

          <div>
            <label className="text-2xs text-ink-faint uppercase tracking-wider font-medium block mb-1.5">{t(mode === 'follow' ? 'fanout.instruction' : 'fanout.question')}</label>
            <textarea
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              rows={2}
              className="w-full text-sm border border-line rounded-lg px-3 py-2 focus:outline-none focus:ring-1 focus:ring-accent bg-surface resize-none leading-relaxed"
            />
          </div>

          {mode === 'models' && (
            <div data-fanout-models>
              <label className="text-2xs text-ink-faint uppercase tracking-wider font-medium block mb-1.5">{t('fanout.models')}</label>
              {apiModels.length === 0 ? (
                <p className="text-2xs text-ink-muted">{t('fanout.modelsEmpty')}</p>
              ) : (
                <div className="flex flex-wrap gap-1.5 max-h-40 overflow-y-auto">
                  {apiModels.map((m) => {
                    const on = pickedModels.includes(m.id);
                    return (
                      <button key={m.id} onClick={() => toggleModel(m.id)} title={m.name}
                        className={`text-2xs px-2.5 py-1.5 rounded-full transition-colors font-mono ${on ? 'bg-accent/15 text-accent font-medium ring-1 ring-accent/30' : 'bg-wash hover:bg-line text-ink-muted'}`}>
                        {m.id.split('/').pop()}
                      </button>
                    );
                  })}
                </div>
              )}
              <p className="text-2xs text-ink-faint mt-1.5">{t('fanout.modelsHint')}</p>
              <label className="mt-3 flex items-start gap-2 cursor-pointer select-none">
                <input type="checkbox" checked={synthesize} onChange={(e) => setSynthesize(e.target.checked)} className="mt-0.5 accent-accent" data-fanout-synthesize />
                <span>
                  <span className="text-xs text-ink">{t('fanout.synthesize')}</span>
                  <span className="block text-2xs text-ink-faint leading-relaxed">{t('fanout.synthesizeHint')}</span>
                </span>
              </label>
            </div>
          )}

          {mode !== 'models' && (<>
          <div>
            <label className="text-2xs text-ink-faint uppercase tracking-wider font-medium block mb-1.5">{t('fanout.templates')}</label>
            <div className="flex flex-wrap gap-1.5">
              {library.map((tpl) => (
                <button
                  key={tpl.id}
                  onClick={() => setPicked((prev) => {
                    const next = new Set(prev);
                    if (next.has(tpl.id)) next.delete(tpl.id);
                    else next.add(tpl.id);
                    return next;
                  })}
                  className={`text-2xs px-2.5 py-1.5 rounded-full transition-colors ${
                    picked.has(tpl.id) ? 'bg-warm/15 text-warm font-medium' : 'bg-wash hover:bg-line text-ink-muted'
                  }`}
                >
                  {tpl.name}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="text-2xs text-ink-faint uppercase tracking-wider font-medium block mb-1.5">{t('fanout.custom')}</label>
            <textarea
              value={customText}
              onChange={(e) => setCustomText(e.target.value)}
              rows={4}
              placeholder={t('fanout.customPlaceholder')}
              className="w-full text-xs border border-line rounded-lg px-3 py-2 focus:outline-none focus:ring-1 focus:ring-accent bg-surface resize-y leading-relaxed font-mono"
            />
          </div>
          </>)}
        </div>

        <div className="px-6 py-4 border-t border-line flex justify-end gap-2">
          <button onClick={onClose} className="text-xs text-ink-muted hover:text-ink px-4 py-2 rounded-lg hover:bg-wash transition-colors">
            {t('common.cancel')}
          </button>
          <button
            onClick={run}
            disabled={!question.trim() || roles.length < minRoles}
            data-fanout-run
            className={`text-xs text-white px-5 py-2 rounded-lg transition-colors disabled:opacity-30 ${
              mode === 'follow' ? 'bg-watch/90 hover:bg-watch' : mode === 'models' ? 'bg-accent hover:bg-accent/90' : 'bg-warm hover:bg-warm/90'
            }`}
          >
            {fmt(t(mode === 'follow' ? 'fanout.confirmFollow' : mode === 'models' ? 'fanout.confirmModels' : 'fanout.confirm'), { n: roles.length })}
          </button>
        </div>
      </div>
    </div>
  ), document.body);
}
