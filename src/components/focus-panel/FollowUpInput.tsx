import { useState, useRef, useEffect, useMemo } from 'react';
import { ChevronUp, GitBranch, Paperclip, Send, X } from 'lucide-react';
import { useStore } from '../../store';
import { shownStaleIds } from '../../lib/stale-judge';
import { isImeComposing } from '../../utils';
import { useUiStore } from '../../lib/ui-store';
import { previewAsk } from '../../lib/request-view';
import RequestRows from '../ui/RequestRows';
import { useShallow } from 'zustand/react/shallow';
import { processFile, FILE_INPUT_ACCEPT } from '../../lib/attachments';
import SearchToggles from '../ui/SearchToggles';
import type { Attachment } from '../../types';
import { countTokens } from '../../utils';
import { useT, fmt } from '../../i18n';
import MentionSurface from '../ui/NodeMention';
import { useMentions } from '../../lib/mentions';
import { contextLengthFor } from '../../lib/runtime-providers';

// past this a request no longer fits most models, window known or not
const UNKNOWN_WINDOW_WARN = 200_000;


export default function FollowUpInput({
  nodeId,
  branchContext,
  onClearBranchContext,
}: {
  nodeId: string;
  /** Selected response text staged as context: submitting creates an orange explore branch. */
  branchContext: string;
  onClearBranchContext: () => void;
}) {
  const addQuestion = useStore((s) => s.addQuestion);
  const nodes = useStore((s) => s.nodes);
  const edges = useStore((s) => s.edges);
  const t = useT();

  // Draft survives node switches (the component remounts per node) and
  // panel close/reopen; cleared on submit.
  const draftKey = `follow:${nodeId}`;
  const [continueInput, setContinueInputState] = useState(() => useUiStore.getState().drafts[draftKey] ?? '');
  const setContinueInput = (v: string) => {
    setContinueInputState(v);
    useUiStore.getState().setDraft(draftKey, v);
  };
  const [continueInheritAttachments, setContinueInheritAttachments] = useState(true);
  const mention = useMentions(nodeId);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [pendingAttachments, setPendingAttachments] = useState<Attachment[]>([]);
  const continueRef = useRef<HTMLTextAreaElement>(null);
  const autoGrow = (el: HTMLTextAreaElement) => {
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  };
  const fileRef = useRef<HTMLInputElement>(null);

  const addFiles = async (files: FileList | File[]) => {
    for (const file of Array.from(files)) {
      await processFile(file, {
        add: (att) => setPendingAttachments((prev) => [...prev, att]),
        update: (attId, patch) => setPendingAttachments((prev) => prev.map((a) => (a.id === attId ? { ...a, ...patch } : a))),
      });
    }
  };

  // What sending this follow-up puts on the wire — the node addQuestion would
  // create, compiled the way it compiles it, with the lane's system additions
  // and the memory/recall blocks — so the preview is the request. Everything
  // but the draft text is memoized; the draft only fills the last row.
  const staleAll = useStore((s) => s.staleIds);
  const staleFps = useStore((s) => s.staleFps);
  const staleVerdicts = useStore((s) => s.staleVerdicts);
  const staleIds = useMemo(() => shownStaleIds({ staleIds: staleAll, staleFps, staleVerdicts }), [staleAll, staleFps, staleVerdicts]);
  const ui = useUiStore(useShallow((s) => [s.webSearchEnabled, s.scholarSearchEnabled, s.mcpEnabled, s.recallEnabled, s.recallOverride, s.memoryEnabled, s.profile, s.selectedModel]));
  const mentionKey = mention.mentions.map((x) => x.nodeId).join(',');
  const base = useMemo(() => previewAsk(useStore.getState(), '', {
    parentId: nodeId,
    branchContext: branchContext || undefined,
    excludeAllInheritedAttachments: !continueInheritAttachments,
    initialAttachments: pendingAttachments.length > 0 ? pendingAttachments : undefined,
    mentions: mentionKey ? mentionKey.split(',') : undefined,
  }, staleIds),
  // eslint-disable-next-line react-hooks/exhaustive-deps -- nodes/edges/ui are the inputs previewAsk reads from the stores
  [nodeId, nodes, edges, staleIds, branchContext, continueInheritAttachments, pendingAttachments, mentionKey, ui]);
  const draft = continueInput.trim();
  const rows = useMemo(() => base.rows.map((r, i) => (i === base.rows.length - 1 && r.kind === 'ask'
    ? { ...r, content: draft || t('req.askPlaceholder'), tokens: draft ? countTokens(draft) : 0 }
    : r)), [base, draft, t]);
  const preview = useMemo(() => {
    const sum = (kinds: string[]) => rows.filter((r) => kinds.includes(r.kind)).reduce((n, r) => n + r.tokens, 0);
    const layerTokens = { material: sum(['material']), reference: sum(['reference']), chain: sum(['question', 'answer', 'passage']) };
    const background = layerTokens.material + layerTokens.reference;
    const notes = [
      base.wired > 0 ? fmt(t('req.mentionWired'), { n: base.wired }) : '',
      base.lane === 'agent' ? t('req.agentNote') : '',
      rows.filter((r) => r.kind === 'addition').length > 1 ? t('req.toolNote') : '',
    ].filter(Boolean);
    return {
      layerTokens,
      // Background outweighing the live conversation is worth an amber flag
      backgroundHeavy: background > 1000 && background > layerTokens.chain,
      totalTokens: rows.reduce((n, r) => n + r.tokens, 0),
      fileCount: rows.filter((r) => /^\[(PDF|File): /.test(r.content)).length + base.images.length,
      note: notes.join(' '),
    };
  }, [rows, base, t]);
  const selectedModel = useUiStore((s) => s.selectedModel);
  const nextModel = useStore((s) => s.nodes.find((n) => n.id === nodeId)?.data.model) ?? selectedModel;
  const windowLimit = nextModel ? contextLengthFor(nextModel) : undefined;
  const overWindow = preview.totalTokens >= (windowLimit ?? UNKNOWN_WINDOW_WARN)
    ? { model: nextModel ?? '', limit: windowLimit }
    : null;
  // Anchor the estimate to the provider's measured prompt_tokens when the
  // last generation on this node ran with the same wiring (same fingerprint).
  // Different wiring → back to pure estimate, to avoid misleading anchors.
  const measured = useMemo(() => {
    const node = nodes.find((n) => n.id === nodeId);
    if (!node) return null;
    const usages = node.data.generatedUsages;
    const lastIdx = (usages?.length ?? 0) - 1;
    if (!usages || lastIdx < 0) return null;
    const last = usages[lastIdx];
    if (!last?.prompt_tokens) return null;
    return last.prompt_tokens;
  }, [nodes, nodeId]);

  // Auto-focus continue input when switching nodes or staging selected text
  useEffect(() => {
    const t = setTimeout(() => {
      if (continueRef.current) {
        continueRef.current.focus();
        autoGrow(continueRef.current); // restored drafts need their height back
      }
    }, 100);
    return () => clearTimeout(t);
     
  }, [nodeId, branchContext]);

  const submit = () => {
    if (!continueInput.trim()) return;
    addQuestion(continueInput.trim(), {
      parentId: nodeId,
      branchContext: branchContext || undefined,
      excludeAllInheritedAttachments: !continueInheritAttachments,
      initialAttachments: pendingAttachments.length > 0 ? pendingAttachments : undefined,
      mentions: mention.mentions.map((x) => x.nodeId),
    });
    mention.clear();
    setContinueInput('');
    setPendingAttachments([]);
    setPreviewOpen(false);
    onClearBranchContext();
  };

  return (
    <div className="relative shrink-0 px-3 pb-3 pt-1">
      {/* Context preview popover */}
      {previewOpen && (
        <div className="absolute bottom-full left-3 right-3 mb-1.5 bg-card border border-line rounded-xl shadow-lg max-h-[60vh] overflow-y-auto py-1.5 animate-fade-in z-30">
          <div className="px-3 py-1.5 border-b border-line">
            <span className="text-2xs text-ink-faint font-medium">{t('followup.contextTitle')}</span>
            <span className={`text-2xs ml-2 ${preview.backgroundHeavy ? 'text-amber-600' : 'text-ink-faint'}`}>
              {fmt(t('followup.layerSummary'), { a: preview.layerTokens.material, b: preview.layerTokens.reference, c: preview.layerTokens.chain })}
            </span>
            {preview.backgroundHeavy && (
              <p className="text-2xs text-amber-600 mt-0.5">{t('followup.layerWarning')}</p>
            )}
          </div>
          <RequestRows rows={rows} images={base.images.length} note={preview.note} />
        </div>
      )}

      <div className="panel-card px-3.5 pt-2 pb-2.5">
      {/* Context summary line */}
      <button
        onClick={() => setPreviewOpen((v) => !v)}
        className="flex items-center gap-1 text-2xs text-ink-faint hover:text-ink-muted transition-colors mb-1.5"
        title={t('followup.previewTitle')}
      >
        <ChevronUp size={12} strokeWidth={1.75} className={`transition-transform ${previewOpen ? 'rotate-180' : ''}`} />
        {measured
          ? fmt(t('followup.willSendMeasured'), { n: preview.totalTokens, m: rows.length, m2: measured.toLocaleString() })
          : fmt(t('followup.willSend'), { n: preview.totalTokens, m: rows.length })}{preview.fileCount > 0 ? fmt(t('followup.files'), { k: preview.fileCount }) : ''}
      </button>
      {overWindow && (
        <p className="text-2xs text-amber-700 bg-amber-500/10 rounded-lg px-2.5 py-1.5 mb-1.5 leading-relaxed" data-context-over>
          {overWindow.limit
            ? fmt(t('followup.overWindow'), { model: overWindow.model, limit: overWindow.limit.toLocaleString() })
            : fmt(t('followup.overMost'), { limit: UNKNOWN_WINDOW_WARN.toLocaleString() })}
        </p>
      )}

      {/* Selected text staged as branch context — submit explores from it */}
      {branchContext && (
        <div className="text-xs pl-3 py-1.5 pr-2 mb-1.5 border-l-2 border-warm bg-warm/10 rounded-r text-ink-muted flex items-start gap-1.5">
          <span className="text-warm font-medium shrink-0"><GitBranch size={13} strokeWidth={1.75} className="inline" /> {t('node.exploringFrom')}</span>
          <span className="flex-1 min-w-0 truncate">&ldquo;{branchContext.slice(0, 90)}{branchContext.length > 90 ? '…' : ''}&rdquo;</span>
          <button onClick={onClearBranchContext} className="text-ink-faint hover:text-red-500 transition-colors shrink-0">
            <X size={13} strokeWidth={2} />
          </button>
        </div>
      )}

      {/* Attachments staged for the NEXT follow-up node */}
      {pendingAttachments.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-1.5">
          {pendingAttachments.map((att) => (
            <span key={att.id} className="inline-flex items-center gap-1 text-2xs bg-wash text-ink-muted px-2 py-1 rounded-full">
              <Paperclip size={11} strokeWidth={1.75} />
              <span className="max-w-[140px] truncate">{att.name}</span>
              {att.isExtracting && <span className="text-ink-faint">…</span>}
              <button onClick={() => setPendingAttachments((prev) => prev.filter((a) => a.id !== att.id))} className="text-ink-faint hover:text-red-500 transition-colors">
                <X size={11} strokeWidth={2} />
              </button>
            </span>
          ))}
        </div>
      )}

      <MentionSurface m={mention} text={continueInput} setText={setContinueInput} />
      <div
        className="flex items-end gap-2 bg-wash rounded-xl px-4 py-2.5 transition-shadow focus-within:ring-1 focus-within:ring-accent/40"
        onDrop={(e) => { e.preventDefault(); e.stopPropagation(); void addFiles(e.dataTransfer.files); }}
        onDragOver={(e) => e.preventDefault()}
      >
        <textarea
          ref={(el) => { continueRef.current = el; mention.bindAnchor(el); }}
          rows={1}
          value={continueInput}
          onChange={(e) => { setContinueInput(e.target.value); mention.track(e.target.value, e.target.selectionStart ?? e.target.value.length); autoGrow(e.target); }}
          onKeyDown={(e) => {
            if (mention.invokeKey(e)) return; // @-picker owns the key
            // Enter sends, Shift+Enter breaks the line; an IME-confirming
            // Enter (picking a pinyin candidate) never submits.
            if (e.key === 'Enter' && !e.shiftKey && !isImeComposing(e)) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={t('common.followUp')}
          className="flex-1 bg-transparent text-sm text-ink placeholder-ink-faint focus:outline-none resize-none leading-relaxed max-h-[160px] overflow-y-auto"
          onPaste={(e) => {
            // TEXT WINS: Office copies carry text plus a bitmap of the
            // selection — only image-only clipboards become attachments.
            if (e.clipboardData?.getData('text/plain').trim()) return;
            const files = Array.from(e.clipboardData?.files ?? []);
            if (files.length > 0) { e.preventDefault(); void addFiles(files); }
          }}
        />
        <input ref={fileRef} type="file" accept={FILE_INPUT_ACCEPT} multiple className="hidden"
          onChange={(e) => { if (e.target.files) void addFiles(e.target.files); e.target.value = ''; }} />
        <SearchToggles />
        <button
          onClick={() => fileRef.current?.click()}
          title={t('followup.attach')}
          className="text-ink-faint hover:text-accent transition-colors shrink-0 rounded-full w-8 h-8 flex items-center justify-center hover:bg-line"
        >
          <Paperclip size={16} strokeWidth={1.75} />
        </button>
        <button
          onClick={submit}
          disabled={!continueInput.trim()}
          className="text-ink-faint hover:text-accent disabled:opacity-30 disabled:hover:text-ink-faint transition-colors shrink-0 rounded-full w-7 h-7 flex items-center justify-center hover:bg-line"
        >
          <Send size={18} strokeWidth={1.75} />
        </button>
      </div>
      <div className="flex gap-4 mt-1.5 px-1">
        <label className="flex items-center gap-2 text-xs text-ink-muted cursor-pointer select-none">
          <input type="checkbox" checked={continueInheritAttachments} onChange={(e) => setContinueInheritAttachments(e.target.checked)} className="rounded border-line text-accent focus:ring-accent w-3 h-3" />
          {t('followup.inheritAttachments')}
        </label>
      </div>
      </div>
    </div>
  );
}
