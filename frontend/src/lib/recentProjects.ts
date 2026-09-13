// The Recent projects list the project dialog and the PERFORM Open field show.
//
// Two sources feed it. The project router keeps recent_projects.json, ordered
// newest first, for every .tasmo it saved or opened. Known places remembers
// every .tasmo the app wrote or was handed some other way, such as a Save a
// copy of a project asset, each with the time it was recorded.

import { basenameOf, pathKey, type PlaceItem } from './placesClient';
import type { RecentItem } from './projectClient';

/**
 * The project router's recent list merged with the .tasmo files known places
 * remembers, one row per file, newest first. The router's list is ordered but
 * carries no times, so each of its rows takes the time known places has for it,
 * or the time of the row above it; a router row above every match stays on top.
 */
export function mergeRecentProjects(projects: RecentItem[], places: PlaceItem[]): RecentItem[] {
  const placeByKey = new Map<string, PlaceItem>();
  for (const it of places) {
    if (!it || typeof it.path !== 'string' || !/\.tasmo$/i.test(it.path.trim())) continue;
    const key = pathKey(it.path);
    const prev = placeByKey.get(key);
    if (!prev || (it.at ?? 0) > (prev.at ?? 0)) placeByKey.set(key, it);
  }

  const rows: Array<{ item: RecentItem; at: number; order: number }> = [];
  const seen = new Set<string>();
  let inherited = Number.POSITIVE_INFINITY;
  for (const r of projects) {
    if (!r || typeof r.path !== 'string' || !r.path.trim()) continue;
    const key = pathKey(r.path);
    if (seen.has(key)) continue;
    seen.add(key);
    const known = placeByKey.get(key);
    if (known && Number.isFinite(known.at)) inherited = known.at;
    rows.push({ item: r, at: inherited, order: rows.length });
  }
  for (const [key, it] of placeByKey) {
    if (seen.has(key)) continue;
    seen.add(key);
    const file = basenameOf(it.path);
    const name = (it.name || file).replace(/\.tasmo$/i, '') || file;
    rows.push({
      item: { path: it.path, name },
      at: Number.isFinite(it.at) ? it.at : 0,
      order: rows.length,
    });
  }
  rows.sort((a, b) => (a.at === b.at ? a.order - b.order : b.at - a.at));
  return rows.map((r) => r.item);
}
