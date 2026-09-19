/**
 * StorageProvider implementation that talks to the backend's
 * `/api/library/*` endpoints. Audio lives on the server's filesystem
 * (default: `<project>/data/generations/`). This is the default for the
 * local-dev / self-hosted use case.
 *
 * A future cloud provider (S3 / R2 / Drive) plugs into the same
 * `StorageProvider` interface.
 */

import type {
  ImportRequest,
  LibraryEntry,
  LibraryEntryPatch,
} from '../state/libraryEntry';
import type { StorageProvider } from './storageProvider';
import { fetchBlobWithRetry } from './fetchRetry';
import type { LibraryFacetField, LibraryFacetValue, LibraryFacets } from './libraryFacets';
import { stripSourceId } from './displayName';

export type {
  LibraryFacetField,
  LibraryFacetValue,
  LibraryFacets,
} from './libraryFacets';

const DEFAULT_BASE = '/api/library';

interface ServerRecord {
  id: string;
  title: string;
  prompt: string;
  negative_prompt: string;
  model: string;
  duration: number;
  steps: number;
  cfg: number;
  seed: number;
  audio_url: string;
  audio_filename: string;
  file_size_bytes: number;
  mime_type: string;
  timestamp: string;
  favorite: boolean;
  rating: 'like' | 'dislike' | null;
  tags: string[];
  notes: string;
  lyrics?: string;
  // A paged list row drops `lyrics` when it is long and sends the first 280
  // characters here instead (`has_lyrics` says the full text exists). The full
  // text always stays on GET /entries/{id}, which is what `fetchLibraryEntry`
  // asks for, so an inspector that needs it gets it.
  lyrics_preview?: string;
  has_lyrics?: boolean;
  source: string;
  chimera_sources?: string[];
  play_count?: number;
  last_played_at?: number | null;
  cover_url?: string | null;
  // The record's media kind. /entries lists audio unless asked for ?kind=media
  // or ?kind=all, and older backends omit the field.
  kind?: 'audio' | 'video' | 'image';
  // Enrichment attached by the backend's `_attach_analysis` (only present once
  // the entry has been analyzed). Flat scalar analysis dict + parsed embedded
  // file tags — see LibraryEntry.analysis / .embeddedTags.
  analysis?: Record<string, unknown>;
  embedded_tags?: Record<string, unknown>;
}

const toEntry = (r: ServerRecord): LibraryEntry => ({
  id: r.id,
  // Strip the importer's source id ONCE, here at the read boundary, so
  // every panel that renders a title gets a clean one. `audioFilename`
  // below stays raw: it resolves files and backs the Filename row.
  title: stripSourceId(r.title),
  prompt: r.prompt,
  negativePrompt: r.negative_prompt,
  model: r.model,
  duration: r.duration,
  steps: r.steps,
  cfg: r.cfg,
  seed: r.seed,
  audioUrl: r.audio_url,
  audioFilename: r.audio_filename,
  fileSizeBytes: r.file_size_bytes,
  mimeType: r.mime_type,
  timestamp: r.timestamp,
  favorite: r.favorite,
  rating: r.rating,
  tags: r.tags ?? [],
  notes: r.notes ?? '',
  // A paged row carries at most the preview; the full text arrives with the
  // single-entry fetch and replaces it in the cache.
  lyrics: r.lyrics ?? r.lyrics_preview ?? '',
  source: (['generate', 'studio', 'import'].includes(r.source)
    ? r.source
    : 'generate') as LibraryEntry['source'],
  chimeraSources: r.chimera_sources ?? [],
  playCount: r.play_count ?? 0,
  lastPlayedAt: r.last_played_at ?? null,
  // Cover art the backend found embedded in the file. Null (not undefined)
  // when there is none, so the UI knows the answer without a probe request.
  coverUrl: r.cover_url ?? null,
  // Carry the kind through, so a list that keeps audio sees what the backend
  // said. A record without one is audio, as LibraryEntry.kind documents.
  kind: r.kind ?? 'audio',
  // Pass the backend analysis enrichment straight through (snake_case →
  // camelCase only). Left undefined when the entry hasn't been analyzed, which
  // the inspector + search treat as "no extra data" rather than empty objects.
  analysis: r.analysis,
  embeddedTags: r.embedded_tags,
});

const patchToServerKeys = (patch: LibraryEntryPatch): Record<string, unknown> => {
  const body: Record<string, unknown> = {};
  if (patch.title !== undefined) body.title = patch.title;
  if (patch.favorite !== undefined) body.favorite = patch.favorite;
  if (patch.rating !== undefined) body.rating = patch.rating;
  if (patch.tags !== undefined) body.tags = patch.tags;
  if (patch.notes !== undefined) body.notes = patch.notes;
  if (patch.lyrics !== undefined) body.lyrics = patch.lyrics;
  if (patch.chimeraSources !== undefined) body.chimera_sources = patch.chimeraSources;
  return body;
};

const errorText = async (r: Response): Promise<string> => {
  try {
    const body = (await r.json()) as { detail?: unknown };
    if (typeof body?.detail === 'string') return body.detail;
    if (body?.detail) return JSON.stringify(body.detail);
  } catch {
    /* fall through */
  }
  return `HTTP ${r.status} ${r.statusText}`;
};

export class BackendLocalProvider implements StorageProvider {
  readonly name = 'backend-local';
  private readonly base: string;

  constructor(base: string = DEFAULT_BASE) {
    this.base = base.replace(/\/$/, '');
  }

  async list(): Promise<LibraryEntry[]> {
    const r = await fetch(`${this.base}/entries`);
    if (!r.ok) throw new Error(`library.list: ${await errorText(r)}`);
    const body = (await r.json()) as { entries: ServerRecord[] };
    return (body.entries ?? []).map(toEntry);
  }

  async get(id: string): Promise<LibraryEntry | null> {
    const r = await fetch(`${this.base}/entries/${encodeURIComponent(id)}`);
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`library.get(${id}): ${await errorText(r)}`);
    return toEntry((await r.json()) as ServerRecord);
  }

  async import(req: ImportRequest): Promise<LibraryEntry> {
    const form = new FormData();
    form.append('file', req.blob, req.filename);
    const metaPayload: Record<string, unknown> = {};
    if (req.metadata) {
      const m = req.metadata;
      if (m.title !== undefined) metaPayload.title = m.title;
      if (m.prompt !== undefined) metaPayload.prompt = m.prompt;
      if (m.negativePrompt !== undefined) metaPayload.negative_prompt = m.negativePrompt;
      if (m.model !== undefined) metaPayload.model = m.model;
      if (m.duration !== undefined) metaPayload.duration = m.duration;
      if (m.steps !== undefined) metaPayload.steps = m.steps;
      if (m.cfg !== undefined) metaPayload.cfg = m.cfg;
      if (m.seed !== undefined) metaPayload.seed = m.seed;
      if (m.source !== undefined) metaPayload.source = m.source;
      if (m.tags !== undefined) metaPayload.tags = m.tags;
      if (m.chimeraSources !== undefined) metaPayload.chimera_sources = m.chimeraSources;
    }
    form.append('metadata', JSON.stringify(metaPayload));

    const r = await fetch(`${this.base}/import`, { method: 'POST', body: form });
    if (!r.ok) throw new Error(`library.import: ${await errorText(r)}`);
    return toEntry((await r.json()) as ServerRecord);
  }

  async update(id: string, patch: LibraryEntryPatch): Promise<LibraryEntry> {
    const r = await fetch(`${this.base}/entries/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patchToServerKeys(patch)),
    });
    if (!r.ok) throw new Error(`library.update(${id}): ${await errorText(r)}`);
    return toEntry((await r.json()) as ServerRecord);
  }

  async delete(id: string): Promise<void> {
    const r = await fetch(`${this.base}/entries/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    if (!r.ok && r.status !== 404) {
      throw new Error(`library.delete(${id}): ${await errorText(r)}`);
    }
  }

  getAudioUrl(entry: LibraryEntry): string {
    return entry.audioUrl;
  }

  // Session-scoped blob cache so multiple consumers don't re-fetch the
  // same audio. Keyed by entry id. Cleared on page reload.
  private readonly blobCache = new Map<string, Promise<Blob>>();

  async fetchAudioBlob(entry: LibraryEntry): Promise<Blob> {
    const cached = this.blobCache.get(entry.id);
    if (cached) return cached;
    // Resilient fetch: the single-worker backend can stall mid-stream while it
    // loads a model, dropping a large audio response even after a 200. Short
    // retries ride over that window instead of surfacing "Failed to fetch".
    const promise = fetchBlobWithRetry(entry.audioUrl, { label: entry.title || entry.id });
    this.blobCache.set(entry.id, promise);
    try {
      return await promise;
    } catch (e) {
      this.blobCache.delete(entry.id);
      throw e;
    }
  }
}

let _provider: StorageProvider | null = null;

export const getStorageProvider = (): StorageProvider => {
  if (_provider === null) {
    _provider = new BackendLocalProvider();
  }
  return _provider;
};

/** Tests / future settings UI can swap the active provider. */
export const setStorageProvider = (provider: StorageProvider): void => {
  _provider = provider;
};

/* ══════════════════════════ paged / searchable list ══════════════════════════
 *
 * `GET /api/library/entries` gained optional `limit` / `offset` / `q` / `sort` /
 * `kind` / `favorite` / `source` parameters, and answers a paged request with
 * `{entries, total, offset, limit, revision}`. WITHOUT `limit` it behaves
 * exactly as it always did, so every other caller is untouched.
 *
 * These are free functions rather than `StorageProvider` methods on purpose:
 * paging is a property of THIS backend, not of the storage abstraction, and a
 * future cloud provider will page differently. The store feature-detects the
 * backend from the shape of the first answer (see `LibraryListResult`).
 */

/** Rows per page. One page is one request; the store keeps an LRU of them. */
export const LIBRARY_PAGE_SIZE = 200;

/** The server caps `/entries/ids`; above this it answers 413 instead. */
export const LIBRARY_ID_CAP = 50_000;

/** The sort orders the backend understands. */
export type LibraryServerSort =
  | 'created_desc'
  | 'created_asc'
  | 'title_asc'
  | 'title_desc'
  | 'plays_desc'
  | 'duration_desc'
  | 'duration_asc';

/** The filter/sort state a paged request is made of. */
export interface LibraryQuery {
  /** Free-text search; '' means no text filter. */
  q: string;
  sort: LibraryServerSort;
  /** 'audio' (the historical default), 'media', 'video', 'image' or 'all'. */
  kind: string;
  /** true = favorites only. false/null = no favorite filter. */
  favorite: boolean | null;
  /** 'generate' | 'studio' | 'import', or null for any source. */
  source: string | null;
}

export const DEFAULT_LIBRARY_QUERY: LibraryQuery = {
  q: '',
  sort: 'created_desc',
  kind: 'audio',
  favorite: null,
  source: null,
};

/** One page of a paged result set. */
export interface LibraryPage {
  entries: LibraryEntry[];
  /** Rows matching the query, across every page. */
  total: number;
  offset: number;
  limit: number;
  /** The `library_revision` the page was read at. */
  revision: number;
}

/**
 * What a list request came back as.
 *
 * `paged` is the feature detection: a backend that understands `limit` answers
 * with a numeric `total`, and one that predates it ignores the parameter and
 * answers with the whole library. The unpaged answer is handed back rather than
 * thrown away, so the fallback costs ONE request, not two.
 */
export interface LibraryListResult {
  /** True when the backend understood `limit` and answered one page. */
  paged: boolean;
  /** The page, when `paged`; null otherwise. */
  page: LibraryPage | null;
  /** The whole library, when NOT `paged`; null otherwise. */
  entries: LibraryEntry[] | null;
}

/** Raised by `fetchLibraryIds` when the filters match more ids than the cap. */
export class LibraryIdCapError extends Error {
  readonly cap: number;
  constructor(cap: number = LIBRARY_ID_CAP) {
    super(
      `Select-all is limited to ${cap.toLocaleString()} entries — narrow the search.`,
    );
    this.name = 'LibraryIdCapError';
    this.cap = cap;
  }
}

/** The query as URL parameters. Absent filters are omitted, never sent empty. */
const queryParams = (query: LibraryQuery): URLSearchParams => {
  const params = new URLSearchParams();
  if (query.kind) params.set('kind', query.kind);
  if (query.q.trim()) params.set('q', query.q.trim());
  if (query.sort) params.set('sort', query.sort);
  if (query.favorite === true) params.set('favorite', 'true');
  if (query.source) params.set('source', query.source);
  return params;
};

/** A paged body has a numeric `total`; anything else is the old shape. */
const asPage = (body: unknown): LibraryPage | null => {
  if (!body || typeof body !== 'object') return null;
  const b = body as {
    entries?: unknown;
    total?: unknown;
    offset?: unknown;
    limit?: unknown;
    revision?: unknown;
  };
  if (typeof b.total !== 'number' || !Number.isFinite(b.total)) return null;
  if (!Array.isArray(b.entries)) return null;
  return {
    entries: (b.entries as ServerRecord[]).map(toEntry),
    total: b.total,
    offset: typeof b.offset === 'number' ? b.offset : 0,
    limit: typeof b.limit === 'number' ? b.limit : LIBRARY_PAGE_SIZE,
    revision: typeof b.revision === 'number' ? b.revision : 0,
  };
};

/** The rows out of an OLD (unpaged) `/entries` answer, or a bare array. */
const asEntryList = (body: unknown): LibraryEntry[] => {
  if (Array.isArray(body)) return (body as ServerRecord[]).map(toEntry);
  if (body && typeof body === 'object') {
    const rows = (body as { entries?: unknown }).entries;
    if (Array.isArray(rows)) return (rows as ServerRecord[]).map(toEntry);
  }
  return [];
};

/**
 * One page of the library, or — against a backend that has no paging — the
 * whole library in one answer. `signal` aborts an in-flight page whose query
 * the user has already moved on from.
 */
export async function fetchLibraryList(
  query: LibraryQuery,
  offset: number,
  limit: number,
  signal?: AbortSignal,
  base: string = DEFAULT_BASE,
): Promise<LibraryListResult> {
  const params = queryParams(query);
  params.set('limit', String(limit));
  params.set('offset', String(offset));
  const r = await fetch(`${base}/entries?${params.toString()}`, { signal });
  if (!r.ok) throw new Error(`library.page: ${await errorText(r)}`);
  const body: unknown = await r.json();
  const page = asPage(body);
  if (page) return { paged: true, page, entries: null };
  return { paged: false, page: null, entries: asEntryList(body) };
}

/**
 * Every id matching `query`, in the query's own order — what select-all and a
 * shift-range need without loading a single row.
 *
 * Throws `LibraryIdCapError` when the backend refuses (413), and returns null
 * when the route does not exist at all (an older backend), which tells the
 * caller to fall back to the rows it already holds.
 */
export async function fetchLibraryIds(
  query: LibraryQuery,
  signal?: AbortSignal,
  base: string = DEFAULT_BASE,
): Promise<{ ids: string[]; total: number } | null> {
  const r = await fetch(`${base}/entries/ids?${queryParams(query).toString()}`, { signal });
  if (r.status === 413) throw new LibraryIdCapError();
  if (r.status === 404 || r.status === 405) return null;
  if (!r.ok) throw new Error(`library.ids: ${await errorText(r)}`);
  const body = (await r.json()) as { ids?: unknown; total?: unknown };
  const ids = Array.isArray(body.ids) ? body.ids.filter((v): v is string => typeof v === 'string') : [];
  return { ids, total: typeof body.total === 'number' ? body.total : ids.length };
}

/* ════════════════════════════ facets ═══════════════════════════════════════
 *
 * `GET /api/library/entries/facets?fields=model,provider&<the page filters>`
 * answers `{facets: {model: [{value, count}, …], …}, revision}`. The values are
 * the DISTINCT values across the whole result set, so a filter dropdown offers
 * every model in a 200,000-entry library rather than the handful on the rows
 * that happen to be loaded. A backend without the route answers 404, and every
 * caller falls back to the rows in hand.
 */

/** The facet answer, already narrowed to the values the UI can use. */
export interface LibraryFacetsResult {
  facets: LibraryFacets;
  /** The `library_revision` the counts were read at; 0 when unknown. */
  revision: number;
}

/** `[{value, count}]`, dropping anything that is not that shape. */
const asFacetValues = (raw: unknown): LibraryFacetValue[] => {
  if (!Array.isArray(raw)) return [];
  const out: LibraryFacetValue[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const v = item as { value?: unknown; count?: unknown };
    const value = typeof v.value === 'string' ? v.value : v.value == null ? null : null;
    const count = typeof v.count === 'number' && Number.isFinite(v.count) ? v.count : 0;
    out.push({ value, count });
  }
  return out;
};

/**
 * The distinct values of each field across everything `query` matches.
 *
 * Returns null when the backend has no facets route (404/405) — the caller
 * keeps whatever it derived from the loaded rows. `sort` is deliberately not
 * sent: re-ordering a list cannot change a count, and sending it would make
 * every sort change a cache miss.
 */
export async function fetchLibraryFacets(
  fields: readonly LibraryFacetField[],
  query: LibraryQuery,
  signal?: AbortSignal,
  base: string = DEFAULT_BASE,
): Promise<LibraryFacetsResult | null> {
  if (fields.length === 0) return { facets: {}, revision: 0 };
  const params = queryParams(query);
  params.delete('sort');
  params.set('fields', fields.join(','));
  const r = await fetch(`${base}/entries/facets?${params.toString()}`, { signal });
  if (r.status === 404 || r.status === 405) return null;
  if (!r.ok) throw new Error(`library.facets: ${await errorText(r)}`);
  const body = (await r.json()) as { facets?: unknown; revision?: unknown };
  const raw = body.facets && typeof body.facets === 'object'
    ? (body.facets as Record<string, unknown>)
    : {};
  const facets: LibraryFacets = {};
  for (const field of fields) facets[field] = asFacetValues(raw[field]);
  return {
    facets,
    revision: typeof body.revision === 'number' && Number.isFinite(body.revision) ? body.revision : 0,
  };
}

/**
 * How many rows `query` matches, without loading any of them: one page of ONE
 * row, read for its `total`. Null against a backend that does not page (which
 * has every row in hand anyway, so the caller can count them itself).
 */
export async function fetchLibraryMatchCount(
  query: LibraryQuery,
  signal?: AbortSignal,
  base: string = DEFAULT_BASE,
): Promise<number | null> {
  const result = await fetchLibraryList(query, 0, 1, signal, base);
  if (!result.paged || !result.page) return null;
  return result.page.total;
}

/* ═════════════════════════ bulk delete ═════════════════════════════════════
 *
 * `POST /api/library/entries/bulk-delete` takes EITHER a list of ids or a
 * filter plus the count the user was shown. The server re-counts the filter and
 * refuses with 409 when its count differs, so a library that moved between the
 * confirmation and the click deletes nothing at all.
 */

/** The filter form's filter — the page query's filters, server spelling. */
export interface LibraryDeleteFilter {
  q?: string;
  kind?: string;
  /** false selects the NON-favorites; omit for no favourite filter. */
  favorite?: boolean;
  source?: string;
}

export type LibraryBulkDeleteRequest =
  | { ids: readonly string[] }
  | {
      filter: LibraryDeleteFilter;
      /** The count the user confirmed. The server refuses a different one. */
      confirmTotal: number;
      /** Required for an EMPTY filter, which would match the whole library. */
      all?: boolean;
    };

export interface LibraryBulkDeleteResult {
  deleted: number;
  /** The first failures, per id. A failure never aborts the rest of the job. */
  failed: { id: string; error: string }[];
  totalMatched: number;
  revision: number;
}

/** The server re-counted and got a different number: nothing was deleted. */
export class LibraryBulkConflictError extends Error {
  /** What the server counts NOW — re-ask the user with this. */
  readonly totalMatched: number;
  constructor(message: string, totalMatched: number) {
    super(message);
    this.name = 'LibraryBulkConflictError';
    this.totalMatched = totalMatched;
  }
}

const isIdForm = (req: LibraryBulkDeleteRequest): req is { ids: readonly string[] } =>
  Object.prototype.hasOwnProperty.call(req, 'ids');

/**
 * Delete many entries in one request.
 *
 * Returns null when the backend has no bulk route (404/405), so the caller can
 * keep its one-at-a-time behaviour and its old wording. Throws
 * `LibraryBulkConflictError` on the server's 409.
 */
export async function bulkDeleteLibraryEntries(
  req: LibraryBulkDeleteRequest,
  signal?: AbortSignal,
  base: string = DEFAULT_BASE,
): Promise<LibraryBulkDeleteResult | null> {
  let body: Record<string, unknown>;
  if (isIdForm(req)) {
    // Never send an empty id list: a server that reads it as "no filter" would
    // delete the library. Nothing selected is nothing to do.
    if (req.ids.length === 0) return { deleted: 0, failed: [], totalMatched: 0, revision: 0 };
    body = { ids: [...req.ids] };
  } else {
    const filter: Record<string, unknown> = {};
    if (req.filter.q) filter.q = req.filter.q;
    if (req.filter.kind) filter.kind = req.filter.kind;
    if (req.filter.favorite !== undefined) filter.favorite = req.filter.favorite;
    if (req.filter.source) filter.source = req.filter.source;
    if (Object.keys(filter).length === 0 && req.all !== true) {
      throw new Error(
        'library.bulkDelete: an empty filter matches the whole library and needs `all: true`',
      );
    }
    body = { filter, confirm_total: req.confirmTotal };
    if (req.all === true) body.all = true;
  }

  const r = await fetch(`${base}/entries/bulk-delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (r.status === 404 || r.status === 405) return null;
  if (r.status === 409) {
    const conflict = (await r.json().catch(() => ({}))) as { detail?: unknown; total_matched?: unknown };
    const detail = typeof conflict.detail === 'string'
      ? conflict.detail
      : 'the library changed since the count you confirmed';
    const matched = typeof conflict.total_matched === 'number' ? conflict.total_matched : 0;
    throw new LibraryBulkConflictError(detail, matched);
  }
  if (!r.ok) throw new Error(`library.bulkDelete: ${await errorText(r)}`);
  const out = (await r.json()) as {
    deleted?: unknown;
    failed?: unknown;
    total_matched?: unknown;
    revision?: unknown;
  };
  const failed = Array.isArray(out.failed)
    ? out.failed.flatMap((f) => {
        if (!f || typeof f !== 'object') return [];
        const row = f as { id?: unknown; error?: unknown };
        return typeof row.id === 'string'
          ? [{ id: row.id, error: typeof row.error === 'string' ? row.error : 'failed' }]
          : [];
      })
    : [];
  return {
    deleted: typeof out.deleted === 'number' ? out.deleted : 0,
    failed,
    totalMatched: typeof out.total_matched === 'number' ? out.total_matched : 0,
    revision: typeof out.revision === 'number' ? out.revision : 0,
  };
}

/** One entry by id, with its FULL lyrics. null when it is not in the library. */
export async function fetchLibraryEntry(
  id: string,
  signal?: AbortSignal,
  base: string = DEFAULT_BASE,
): Promise<LibraryEntry | null> {
  const r = await fetch(`${base}/entries/${encodeURIComponent(id)}`, { signal });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`library.get(${id}): ${await errorText(r)}`);
  return toEntry((await r.json()) as ServerRecord);
}

