/**
 * What a track's lineage says about it: who it came from, what came from it,
 * how far the family reaches either way, and the words and tags that recur
 * across it. Read by the lineage window's node inspector and by the library's
 * INFO tab, from the `{nodes, edges}` that `/api/library/{id}/lineage` returns.
 */

export interface LineageNode {
  id: string;
  kind?: string;
  title?: string;
  source?: string;
  duration_sec?: number;
  model?: string;
  play_count?: number;
}

export interface LineageEdge {
  from_id: string;
  to_id: string;
  kind: string;
  weight?: number;
}

/** One colour per relation, the same in the graph and everywhere it is listed. */
export const EDGE_COLOR_BY_KIND: Record<string, string> = {
  chimera_source_of: '#a78bfa',
  init_for: '#34d399',
  inpaint_for: '#fbbf24',
  stem_of: '#60a5fa',
  midi_of: '#f472b6',
  derived_from: '#94a3b8',
  used_in_lora: '#fb7185',
};

export const edgeColor = (kind: string): string => EDGE_COLOR_BY_KIND[kind] ?? '#71717a';

/** A relation's name as words: `chimera_source_of` reads "chimera source of". */
export const relationWords = (kind: string): string => kind.replace(/_/g, ' ');

/** Lineage entries fetched for themes are capped, so a giant family does not
 *  fire hundreds of requests; the cap is reported, never hidden. */
export const LINEAGE_FETCH_CAP = 40;

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'with', 'in', 'on', 'to', 'for', 'at',
  'by', 'from', 'is', 'it', 'this', 'that', 'into', 'over', 'out', 'up', 'as',
  'but', 'are', 'was', 'be', 'no', 'not', 'very', 'more', 'some', 'like',
]);

/** The words of a prompt worth counting: three letters or more, no stopwords. */
export function tokenize(s: string): string[] {
  return (s.toLowerCase().match(/[a-z][a-z0-9'-]{2,}/g) ?? []).filter((t) => !STOPWORDS.has(t));
}

/** Every node reachable from `start` over `adj`, `start` itself left out. */
export function reach(start: string, adj: Record<string, string[]>): Set<string> {
  const out = new Set<string>();
  const stack = [start];
  while (stack.length) {
    const id = stack.pop() as string;
    for (const nb of adj[id] ?? []) {
      if (nb !== start && !out.has(nb)) {
        out.add(nb);
        stack.push(nb);
      }
    }
  }
  return out;
}

export interface Relatives {
  /** Edges that end at the node: what it came from. */
  incoming: LineageEdge[];
  /** Edges that start at the node: what came from it. */
  outgoing: LineageEdge[];
  ancestors: Set<string>;
  descendants: Set<string>;
  /** Outgoing edges counted by relation: what the node spawned. */
  spawnedByKind: Record<string, number>;
}

/** The node's place in its family, read off the edges. */
export function relativesOf(nodeId: string, edges: LineageEdge[]): Relatives {
  const parentsOf: Record<string, string[]> = {};
  const childrenOf: Record<string, string[]> = {};
  for (const e of edges) {
    (childrenOf[e.from_id] = childrenOf[e.from_id] || []).push(e.to_id);
    (parentsOf[e.to_id] = parentsOf[e.to_id] || []).push(e.from_id);
  }
  const outgoing = edges.filter((e) => e.from_id === nodeId);
  const spawnedByKind: Record<string, number> = {};
  for (const e of outgoing) spawnedByKind[e.kind] = (spawnedByKind[e.kind] ?? 0) + 1;
  return {
    incoming: edges.filter((e) => e.to_id === nodeId),
    outgoing,
    ancestors: reach(nodeId, parentsOf),
    descendants: reach(nodeId, childrenOf),
    spawnedByKind,
  };
}

export interface Themes {
  terms: Array<[string, number]>;
  tags: Array<[string, number]>;
}

/** The prompt words and tags that recur across a family's entries, the eight
 *  most frequent of each. */
export function themesOf(entries: Array<{ prompt?: unknown; tags?: unknown } | null>): Themes {
  const termCount = new Map<string, number>();
  const tagCount = new Map<string, number>();
  for (const e of entries) {
    if (!e) continue;
    for (const t of tokenize(String(e.prompt ?? ''))) termCount.set(t, (termCount.get(t) ?? 0) + 1);
    for (const tag of Array.isArray(e.tags) ? e.tags : []) tagCount.set(String(tag), (tagCount.get(String(tag)) ?? 0) + 1);
  }
  const top = (m: Map<string, number>) => Array.from(m.entries()).sort((a, b) => b[1] - a[1]).slice(0, 8);
  return { terms: top(termCount), tags: top(tagCount) };
}
