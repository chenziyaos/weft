import { useStore } from '../store';
import { activeProjectName } from './export';
import { frameMembers } from './frames';
import { zipFiles } from './zip';
import { toast } from './ui-store';
import { t, fmt } from '../i18n';
import type { Attachment, ThoughtNode, ThoughtEdge } from '../types';

// Vault export: one Markdown file per node, YAML frontmatter, and every edge
// as a [[wikilink]], so the canvas opens as a linked note graph in Obsidian
// (or any wikilink-aware editor). Frames become groups on the index page.

const yaml = (v: string) => JSON.stringify(v);

/** Obsidian forbids these in names that wikilinks must resolve to. */
function noteName(raw: string): string {
  return raw.replace(/[\\/:*?"<>|#^[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60).trim();
}

function readingOrder(a: ThoughtNode, b: ThoughtNode): number {
  return a.position.y - b.position.y || a.position.x - b.position.x;
}

function attachmentText(a: Attachment): string {
  if (a.extractedText) return a.extractedText;
  return !a.contentInVault && a.type.startsWith('text/') ? a.content : '';
}

export function buildVault(nodes: ThoughtNode[], edges: ThoughtEdge[], project: string): { path: string; content: string }[] {
  const folder = noteName(project) || 'canvas';
  const frames = nodes.filter((n) => n.data.stepKind === 'frame').sort((a, b) => a.position.x - b.position.x || a.position.y - b.position.y);
  const notes = nodes.filter((n) => n.data.stepKind !== 'frame').sort(readingOrder);

  const names = new Map<string, string>();
  const taken = new Set<string>([folder.toLowerCase()]);
  for (const n of notes) {
    const base = noteName(n.data.linkTitle || n.data.question.split('\n')[0] || n.data.attachments?.[0]?.name || '') || n.id;
    let name = base;
    for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${base} (${i})`;
    taken.add(name.toLowerCase());
    names.set(n.id, name);
  }
  const link = (id: string) => (names.has(id) ? `[[${names.get(id)}]]` : null);

  const frameOf = new Map<string, string>();
  for (const f of frames) for (const m of frameMembers(f, notes)) if (!frameOf.has(m.id)) frameOf.set(m.id, f.data.question);

  const files = notes.map((n) => {
    const d = n.data;
    const kind = d.stepKind ?? 'thought';
    const incoming = edges.filter((e) => e.target === n.id);
    const outgoing = edges.filter((e) => e.source === n.id);
    const isRef = (e: ThoughtEdge) => !!(e.data?.isCrossLink || e.data?.isWatch);
    const list = (ids: string[]) => ids.map(link).filter(Boolean).map((l) => `- ${l}`);

    const fm = [
      '---',
      `weft_id: ${yaml(n.id)}`,
      `kind: ${kind}`,
      ...(d.model ? [`model: ${yaml(d.model)}`] : []),
      ...(d.createdAt ? [`created: ${d.createdAt}`] : []),
      ...(d.lastGeneratedAt ? [`generated: ${d.lastGeneratedAt}`] : []),
      ...(frameOf.has(n.id) ? [`frame: ${yaml(frameOf.get(n.id)!)}`] : []),
      ...(d.linkUrl ? [`source: ${yaml(d.linkUrl)}`] : []),
      ...(d.archived ? ['archived: true'] : []),
      'tags: [weft]',
      '---',
      '',
    ];

    const body: string[] = [];
    const atts = d.attachments ?? [];
    if (kind === 'note' || kind === 'file' || kind === 'link') {
      if (d.question) body.push(d.question, '');
      for (const a of atts) {
        const text = attachmentText(a);
        body.push(`> [!info] ${a.name}`, `> ${a.type} · ${Math.max(1, Math.round(a.size / 1024))} KB`, '', ...(text ? [text, ''] : []));
      }
    } else {
      if (atts.length) body.push(`> ${t('export.attachmentsLabel')} ${atts.map((a) => a.name).join(', ')}`, '');
      body.push(`> [!question]`, ...d.question.split('\n').map((l) => `> ${l}`), '');
      if (d.branchContext) body.push(`> [!quote] ${t('vault.branchFrom')}`, `> ${d.branchContext.replace(/\s+/g, ' ').slice(0, 300)}`, '');
      body.push(d.response || '_(no response)_', '');
      const refs = d.references ?? [];
      if (refs.length) body.push(`## ${t('vault.sources')}`, ...refs.map((r, i) => `${i + 1}. ${r.url ? `[${r.title || r.url}](${r.url})` : r.title}`), '');
    }

    const sections: [string, string[]][] = [
      [t('vault.parents'), list(incoming.filter((e) => !isRef(e)).map((e) => e.source))],
      [t('vault.references'), list(incoming.filter(isRef).map((e) => e.source))],
      [t('vault.children'), list(outgoing.filter((e) => !isRef(e)).map((e) => e.target))],
      [t('vault.citedBy'), list(outgoing.filter(isRef).map((e) => e.target))],
    ];
    for (const [title, items] of sections) if (items.length) body.push(`## ${title}`, ...items, '');

    return { path: `${folder}/${names.get(n.id)}.md`, content: [...fm, ...body].join('\n') };
  });

  const grouped = new Set<string>();
  const index = [
    '---', `title: ${yaml(project)}`, `exported: ${new Date().toISOString()}`, `nodes: ${notes.length}`, 'tags: [weft, weft-index]', '---', '',
    `# ${project}`, '',
  ];
  for (const f of frames) {
    const members = frameMembers(f, notes).filter((m) => frameOf.get(m.id) === f.data.question).sort(readingOrder);
    if (!members.length) continue;
    index.push(`## ${f.data.question}`, ...members.map((m) => `- ${link(m.id)}`), '');
    members.forEach((m) => grouped.add(m.id));
  }
  const rest = notes.filter((n) => !grouped.has(n.id));
  if (rest.length) index.push(...(frames.length ? [`## ${t('vault.ungrouped')}`] : []), ...rest.map((n) => `- ${link(n.id)}`), '');

  return [{ path: `${folder}/${folder}.md`, content: index.join('\n') }, ...files];
}

export function exportActiveVault(): void {
  const { nodes, edges } = useStore.getState();
  const project = activeProjectName();
  const files = buildVault(nodes, edges, project);
  if (files.length <= 1) return;
  const url = URL.createObjectURL(zipFiles(files));
  const a = Object.assign(document.createElement('a'), { href: url, download: `${noteName(project) || 'canvas'}.vault.zip` });
  a.click();
  URL.revokeObjectURL(url);
  toast('success', fmt(t('toast.exported'), { name: project }));
}
