/**
 * djAnalysisStore — per-entry audio analysis (BPM / key / etc.) for the DJ tab.
 *
 * The backend already computes BPM (aubio), musical key + scale (librosa), bars,
 * loudness, pitch — exposed at `/api/analysis/{id}` (GET row, returns
 * `{status:'pending'}` when not yet analyzed) and `/api/analysis/{id}/run`
 * (POST, synchronous foreground analysis). This store is a thin cache + an
 * `ensureAnalyzed()` that runs analysis on demand (e.g. when a track is loaded
 * onto a deck) so DJ decks show grid info without a manual step.
 *
 * Mirrors the shape DetailsView already uses; Camelot is derived client-side
 * (see lib/camelot.ts) — no extra backend work.
 *
 * ── Why there are two lanes and a cap ──────────────────────────────────────
 * Opening the DJ tab used to enqueue EVERY library row the browser had in hand
 * — hundreds — and each one is a foreground decode on the backend. The deck the
 * user actually just loaded then queued behind all of them. Two rules fix that:
 *
 *   * a *request* lane (`ensureAnalyzed`, `analyzeEntries`) that jumps ahead of
 *     the browsing sweep and is never discarded, and
 *   * a *sweep* lane (`analyzeAll`) that is a capped, REPLACEABLE working set:
 *     the rows currently worth pre-analysing. Scrolling replaces it, so rows
 *     that left the viewport stop costing decodes.
 */
import { create } from 'zustand';
import { logError } from './logStore';

export interface DjAnalysis {
  bpm: number | null;
  /** The beat detector's own confidence in `bpm`, 0..1 (null when it never
   *  reported one). A deck greys out a BPM detected at 0.1 rather than
   *  beatmatching on it. */
  bpm_confidence: number | null;
  key: string | null;
  scale: string | null;
  key_confidence: number | null;
  bars_estimated: number | null;
  rms_db: number | null;
  duration_sec: number | null;
  beats: number[] | null;
  analyzed_at: number | null;
}

type Status = 'unknown' | 'pending' | 'running' | 'ready' | 'error';

interface Entry {
  status: Status;
  data: DjAnalysis | null;
}

/** How many rows one `analyzeAll` sweep may hold. The DJ browser can have
 *  hundreds of rows in hand and every analysis is a real decode, so the sweep
 *  is a window, not a backlog. */
export const DJ_SWEEP_CAP = 24;

/** An entry whose analysis failed is retried exactly ONCE, and only after this
 *  long. Before this, a failing entry that stayed on screen was re-POSTed by
 *  every sweep; after it, a transient failure (backend busy, file briefly
 *  locked) still gets a second chance without becoming a loop. */
export const ANALYSIS_ERROR_RETRY_MS = 60_000;

/** Breathing room between queued analyses so the backend's threadpool is not
 *  saturated by this tab alone. The server-side cap is the real bound; this
 *  just stops the client from queueing into it flat out. */
const QUEUE_GAP_MS = 80;

/** The DJ profile: ffprobe + one decode + tempo/beats/confidence + key + rms.
 *  It deliberately skips pitch statistics and the second (loudness) decode,
 *  neither of which any deck reads — see backend `PROFILE_DJ`. */
const RUN_PROFILE = 'dj';

// ── queue state (module-level: one consumer per tab, not per component) ──────
/** Explicit requests: deck loads, setlist/VJ additions. Drained FIRST and
 *  never dropped. */
const _hot: string[] = [];
/** The browsing sweep's working set. Replaced wholesale by `analyzeAll`. */
let _sweep: string[] = [];
const _queued = new Set<string>();
const _waiters = new Map<string, Array<() => void>>();
/** id -> when its last run failed, and whether its one retry is spent. */
const _erroredAt = new Map<string, number>();
const _retried = new Set<string>();
let _processing = false;
let _paused = false;

/** Worth queueing or running right now? Pure — it consumes nothing, so an id
 *  that is only *considered* never burns its one retry. */
function _eligible(id: string, now: number): boolean {
  const cur = useDjAnalysisStore.getState().byId[id];
  if (!cur) return true;
  if (cur.status === 'ready' || cur.status === 'running') return false;
  if (cur.status === 'error') {
    if (_retried.has(id)) return false;
    return now - (_erroredAt.get(id) ?? 0) >= ANALYSIS_ERROR_RETRY_MS;
  }
  return true;
}

function _settle(id: string): void {
  const waiting = _waiters.get(id);
  if (!waiting) return;
  _waiters.delete(id);
  for (const resolve of waiting) resolve();
}

function _waitFor(id: string): Promise<void> {
  return new Promise<void>((resolve) => {
    const waiting = _waiters.get(id);
    if (waiting) waiting.push(resolve);
    else _waiters.set(id, [resolve]);
  });
}

function _enqueue(id: string, priority: boolean): void {
  if (priority) {
    const inSweep = _sweep.indexOf(id);
    if (inSweep >= 0) _sweep.splice(inSweep, 1); // promote out of the sweep
    else if (_queued.has(id)) return; // already waiting in the hot lane
    if (!_hot.includes(id)) _hot.push(id);
  } else {
    if (_queued.has(id)) return;
    _sweep.push(id);
  }
  _queued.add(id);
}

async function _processQueue(): Promise<void> {
  if (_processing || _paused) return;
  _processing = true;
  try {
    while (!_paused) {
      const id = _hot.shift() ?? _sweep.shift();
      if (id === undefined) break;
      _queued.delete(id);
      if (!_eligible(id, Date.now())) {
        _settle(id);
        continue;
      }
      // Spend the one retry HERE, where the run actually happens.
      if (useDjAnalysisStore.getState().byId[id]?.status === 'error') _retried.add(id);
      await _runOne(id);
      _settle(id);
      if (_hot.length || _sweep.length) await new Promise((r) => setTimeout(r, QUEUE_GAP_MS));
    }
  } finally {
    _processing = false;
  }
}

function _markReady(entryId: string, raw: Record<string, unknown>): void {
  _erroredAt.delete(entryId);
  _retried.delete(entryId);
  useDjAnalysisStore.setState((s) => ({
    byId: { ...s.byId, [entryId]: { status: 'ready', data: pickFields(raw) } },
  }));
}

function _markError(entryId: string): void {
  _erroredAt.set(entryId, Date.now());
  useDjAnalysisStore.setState((s) => ({
    byId: { ...s.byId, [entryId]: { status: 'error', data: null } },
  }));
}

/** GET the cached row; if there is none, POST a DJ-profile run. */
async function _runOne(entryId: string): Promise<void> {
  await useDjAnalysisStore.getState().fetch(entryId);
  const after = useDjAnalysisStore.getState().byId[entryId];
  if (after?.status === 'ready') return;
  if (after?.status === 'error') return; // don't hammer a failing entry

  useDjAnalysisStore.setState((s) => ({
    byId: { ...s.byId, [entryId]: { status: 'running', data: null } },
  }));
  try {
    const r = await fetch(`/api/analysis/${entryId}/run?profile=${RUN_PROFILE}`, {
      method: 'POST',
    });
    if (!r.ok) {
      _markError(entryId);
      return;
    }
    _markReady(entryId, (await r.json()) as Record<string, unknown>);
  } catch (e) {
    logError('dj', `Analysis run failed for ${entryId}: ${e instanceof Error ? e.message : String(e)}`);
    _markError(entryId);
  }
}

interface DjAnalysisState {
  byId: Record<string, Entry>;
  /** Fetch the cached analysis row for an entry (no run). */
  fetch: (entryId: string) => Promise<void>;
  /**
   * "I need this entry's analysis now." Resolves once the entry is ready or
   * failed. Safe to call repeatedly — ready / in-flight entries are skipped.
   *
   * `priority` defaults to TRUE: the entry jumps ahead of everything
   * `analyzeAll` has queued, which is the point of calling this instead. A
   * deck load should use the default; pass `{ priority: false }` only for
   * speculative work that may politely wait behind the browsing sweep.
   */
  ensureAnalyzed: (entryId: string, opts?: { priority?: boolean }) => Promise<void>;
  /**
   * Set the browsing sweep's working set: the rows worth pre-analysing right
   * now, in priority order, capped at `cap` (default {@link DJ_SWEEP_CAP}).
   *
   * Each call REPLACES the previous window, so a scroll stops paying for rows
   * that scrolled away. Ids already requested via `ensureAnalyzed` /
   * `analyzeEntries` are untouched — those are promises, not a window.
   *
   * Callers (DJView) should pass ids most-wanted-first:
   * **the loaded decks → the active set / queue → the ≤24 visible rows.**
   * Anything past `cap` is dropped, not queued, so the order is what decides
   * what actually gets analysed. Returns as soon as the window is set; it does
   * not wait for the analyses.
   */
  analyzeAll: (entryIds: string[], opts?: { cap?: number }) => Promise<void>;
  /** Stop starting new analyses (the one in flight finishes). Use while the
   *  user is doing something latency-sensitive — a live set. */
  pauseQueue: () => void;
  /** Resume after {@link pauseQueue} and drain whatever is still queued. */
  resumeQueue: () => void;
  /** Selector helper. */
  get: (entryId: string | null) => Entry | null;
}

/**
 * Queue one or more library entries for immediate background analysis. Safe to
 * call from anywhere (stores, buses) — null/dupe/already-analyzed ids are
 * dropped. This is what makes "anything added to DJ / VJ / a setlist gets
 * analyzed" hold without each call site spiking the backend.
 *
 * These are explicit requests, so they land in the request lane: a DJ-tab
 * sweep can neither delay nor discard them.
 */
export function analyzeEntries(ids: Array<string | null | undefined>): void {
  const now = Date.now();
  for (const id of ids) {
    if (!id || !_eligible(id, now)) continue;
    _enqueue(id, true);
  }
  void _processQueue();
}

function pickFields(raw: Record<string, unknown>): DjAnalysis {
  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null;

  // Beats: the DB/API row carries them as a JSON string in `beats_json`; some
  // payloads may use a parsed `beats` array. Accept either (the field-name
  // mismatch is why decks had no real beatgrid before).
  let beats: number[] | null = Array.isArray(raw.beats) ? (raw.beats as number[]) : null;
  if (!beats && typeof raw.beats_json === 'string') {
    try {
      const arr = JSON.parse(raw.beats_json);
      if (Array.isArray(arr)) beats = arr.filter((n): n is number => typeof n === 'number' && Number.isFinite(n));
    } catch {
      /* leave null */
    }
  }

  // Duration: an explicit field if present, else pull it from ffprobe metadata.
  let duration = num(raw.duration_sec) ?? num(raw.duration);
  if (duration == null && typeof raw.ffprobe_json === 'string') {
    try {
      const fp = JSON.parse(raw.ffprobe_json) as { format?: { duration?: unknown }; duration?: unknown };
      const d = Number(fp?.format?.duration ?? fp?.duration);
      if (Number.isFinite(d) && d > 0) duration = d;
    } catch {
      /* leave null */
    }
  }

  return {
    bpm: num(raw.bpm),
    bpm_confidence: num(raw.bpm_confidence),
    key: typeof raw.key === 'string' ? raw.key : null,
    scale: typeof raw.scale === 'string' ? raw.scale : null,
    key_confidence: num(raw.key_confidence ?? raw.confidence),
    bars_estimated: num(raw.bars_estimated),
    rms_db: num(raw.rms_db),
    duration_sec: duration,
    beats,
    analyzed_at: num(raw.analyzed_at),
  };
}

export const useDjAnalysisStore = create<DjAnalysisState>()((set, get) => ({
  byId: {},

  fetch: async (entryId) => {
    try {
      const r = await fetch(`/api/analysis/${entryId}`);
      if (!r.ok) {
        _markError(entryId);
        return;
      }
      const payload = (await r.json()) as Record<string, unknown> & { status?: string };
      if (payload.status === 'pending') {
        set((s) => ({ byId: { ...s.byId, [entryId]: { status: 'pending', data: null } } }));
        return;
      }
      _markReady(entryId, payload);
    } catch (e) {
      logError('dj', `Analysis fetch failed for ${entryId}: ${e instanceof Error ? e.message : String(e)}`);
      _markError(entryId);
    }
  },

  ensureAnalyzed: async (entryId, opts) => {
    if (!entryId) return;
    if (!_eligible(entryId, Date.now())) return;
    const settled = _waitFor(entryId);
    _enqueue(entryId, opts?.priority !== false);
    void _processQueue();
    await settled;
  },

  analyzeAll: async (entryIds, opts) => {
    const cap = Math.max(0, opts?.cap ?? DJ_SWEEP_CAP);
    const now = Date.now();
    const wanted: string[] = [];
    for (const id of entryIds) {
      if (wanted.length >= cap) break;
      if (!id || wanted.includes(id)) continue;
      if (_hot.includes(id)) continue; // an explicit request already owns it
      if (!_eligible(id, now)) continue;
      wanted.push(id);
    }
    // The previous window is gone, not merged: rows that scrolled out of the
    // browser are not worth a decode, and keeping them would let the backlog
    // grow without bound no matter what the cap says.
    for (const id of _sweep) {
      if (wanted.includes(id)) continue;
      _queued.delete(id);
      _settle(id);
    }
    _sweep = wanted;
    for (const id of wanted) _queued.add(id);
    void _processQueue();
  },

  pauseQueue: () => {
    _paused = true;
  },

  resumeQueue: () => {
    _paused = false;
    void _processQueue();
  },

  get: (entryId) => (entryId ? get().byId[entryId] ?? null : null),
}));
