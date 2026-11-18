import { useStore } from '../store';
import { useProjects } from '../store/projects';
import { inlineVaultedContent } from './attachment-vault';
import type { GraphSnapshot } from './host-handoff';

export type LiveSource = ReturnType<typeof captureSource>;

/** The live canvas as array references; compare with sourceIsCurrent before publishing. */
export function captureSource() {
  const { nodes, edges, events } = useStore.getState();
  const { activeId, projects, switching } = useProjects.getState();
  const project = projects.find((p) => p.id === activeId);
  return { nodes, edges, events, instantiatedFrom: project?.instantiatedFrom,
    projectId: activeId ?? undefined, name: project?.name ?? 'canvas', switching };
}

export function sourceIsCurrent(source: LiveSource): boolean {
  const now = captureSource();
  return !now.switching && now.nodes === source.nodes && now.edges === source.edges
    && now.events === source.events && now.instantiatedFrom === source.instantiatedFrom
    && now.projectId === source.projectId && now.name === source.name;
}

export async function hydrate(source: LiveSource): Promise<GraphSnapshot> {
  // Work on a detached copy: a rejected result must never mutate the live store.
  const nodes = await inlineVaultedContent(structuredClone(source.nodes));
  for (let i = 0; i < source.nodes.length; i++) {
    for (const attachment of source.nodes[i].data.attachments ?? []) {
      if (attachment.contentInVault && !nodes[i].data.attachments?.find((a) => a.id === attachment.id)?.content) {
        throw new Error(`材料缺失：${attachment.name}。请重新导入完整图文件后再交接。`);
      }
    }
  }
  return { version: 1, name: source.name, projectId: source.projectId,
    events: structuredClone(source.events ?? []), instantiatedFrom: structuredClone(source.instantiatedFrom),
    nodes, edges: structuredClone(source.edges) };
}
