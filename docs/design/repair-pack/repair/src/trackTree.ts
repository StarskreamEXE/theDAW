/** Arrangement hierarchy only. Audio outputTo/sends stay in the existing routing graph. */
export interface TreeTrack { id: string; parentId: string | null; kind: 'audio' | 'midi' | 'folder'; collapsed?: boolean }
export function assertTree<T extends TreeTrack>(tracks: readonly T[]): Map<string, T> {
  const map = new Map(tracks.map((t) => [t.id, t]));
  if (map.size !== tracks.length) throw new Error('Duplicate track ID');
  for (const t of tracks) {
    const seen = new Set([t.id]); let pid = t.parentId;
    while (pid !== null) {
      if (seen.has(pid)) throw new Error('Track hierarchy cycle'); seen.add(pid);
      const p = map.get(pid); if (!p || p.kind !== 'folder') throw new Error('Parent must be an existing folder');
      pid = p.parentId;
    }
  }
  return map;
}
export function flattenVisible<T extends TreeTrack>(tracks: readonly T[]): Array<{ track: T; depth: number; descendantCount: number }> {
  assertTree(tracks);
  const byParent = childrenByParent(tracks), out: Array<{ track: T; depth: number; descendantCount: number }> = [];
  const count = (id: string): number => (byParent.get(id) ?? []).reduce((n, t) => n + 1 + count(t.id), 0);
  const visit = (parent: string | null, depth: number): void => {
    for (const t of byParent.get(parent) ?? []) {
      out.push({ track: t, depth, descendantCount: count(t.id) });
      if (!t.collapsed) visit(t.id, depth + 1);
    }
  };
  visit(null, 0); return out;
}
function childrenByParent<T extends TreeTrack>(tracks: readonly T[]): Map<string | null, T[]> {
  const out = new Map<string | null, T[]>();
  for (const t of tracks) { const a = out.get(t.parentId) ?? []; a.push(t); out.set(t.parentId, a); }
  return out;
}
/** beforeId is a sibling in the DESTINATION after removing the dragged root.
 * Undefined appends. A whole subtree moves, preserving child IDs and order.
 */
export function moveSubtree<T extends TreeTrack>(tracks: readonly T[], dragId: string,
  newParentId: string | null, beforeId?: string): T[] {
  const map = assertTree(tracks), dragged = map.get(dragId);
  if (!dragged) throw new Error('Dragged track does not exist');
  if (beforeId === dragId && newParentId === dragged.parentId) return [...tracks];
  const changed = { ...dragged, parentId: newParentId };
  const proposed = tracks.map((t) => t.id === dragId ? changed : t);
  assertTree(proposed); // Rejects self-parenting, descendant drops and non-folder parents.
  const groups = childrenByParent(proposed);
  for (const [parent, list] of groups) groups.set(parent, list.filter((t) => t.id !== dragId));
  const siblings = groups.get(newParentId) ?? [];
  const at = beforeId === undefined ? siblings.length : siblings.findIndex((t) => t.id === beforeId);
  if (at < 0) throw new Error('Drop anchor is not a destination sibling');
  siblings.splice(at, 0, changed); groups.set(newParentId, siblings);
  const out: T[] = [];
  const visit = (parent: string | null): void => { for (const t of groups.get(parent) ?? []) { out.push(t); visit(t.id); } };
  visit(null); return out;
}
