/**
 * djRhythmStore — downbeats for the DJ tab, read-only and cheap.
 *
 * The rhythm module (`backend/modules/rhythm`) already knows where the bar
 * lines are: `GET /api/rhythm/{id}` returns a cached analysis with
 * `downbeats`, and `POST /api/rhythm/{id}/run` computes one. TrackInfo, the
 * Rhythm block and `lib/rhythmSeed` all read it. The DJ tab never did, so its
 * beatgrid drew a bar line every fourth beat (`i % 4 === 0` — wrong the
 * instant a track has a pickup or is not in 4/4) and cue seeding had nothing
 * but a flat beat list to work from.
 *
 * Two rules make this safe to call on every deck load:
 *
 *   1. **GET only.** A cache miss answers `200 {status: 'pending'}` and we
 *      stop there. `/run` decodes and re-analyzes the whole file; firing that
 *      from a deck load would stall the DJ tab behind a minute of CPU for
 *      data it only uses as a nicety. Cue seeding falls back to plain beats,
 *      and if the user later analyzes the track elsewhere the rhythm lands
 *      here on the next load.
 *   2. **One request per entry per session.** Results — including misses and
 *      failures — are remembered, so a deck that reloads the same track does
 *      not re-ask. Not persisted: the cache it mirrors lives on disk and can
 *      change between sessions.
 */
import { create } from 'zustand';

export interface DjRhythm {
  /** True when the backend had a finished analysis cached. */
  ready: boolean;
  /** Bar starts in seconds, or null when there are none to be had. */
  downbeats: number[] | null;
  /** An explicit bar list, when the payload carries one separately. */
  bars: number[] | null;
}

interface DjRhythmState {
  byEntry: Record<string, DjRhythm>;
  /** What is already known about an entry; never fetches. */
  rhythmFor: (entryId: string | null) => DjRhythm | null;
  /** Fetch once (GET only) and remember. Resolves null when there is
   *  nothing usable — the caller seeds from plain beats in that case. */
  ensureRhythm: (entryId: string) => Promise<DjRhythm | null>;
}

/** In-flight requests, so three decks asking at once make one request. */
const inflight = new Map<string, Promise<DjRhythm | null>>();

/** Keep only finite, non-negative times; `null` when nothing survives. */
function times(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  const out = value.filter((t): t is number => typeof t === 'number' && Number.isFinite(t) && t >= 0);
  return out.length > 0 ? out : null;
}

const MISS: DjRhythm = { ready: false, downbeats: null, bars: null };

export const useDjRhythmStore = create<DjRhythmState>()((set, get) => ({
  byEntry: {},
  rhythmFor: (entryId) => (entryId ? get().byEntry[entryId] ?? null : null),
  ensureRhythm: async (entryId) => {
    if (!entryId) return null;
    const known = get().byEntry[entryId];
    if (known) return known.ready ? known : null;
    const pending = inflight.get(entryId);
    if (pending) return pending;

    const run = (async (): Promise<DjRhythm | null> => {
      try {
        const res = await fetch(`/api/rhythm/${encodeURIComponent(entryId)}`);
        if (!res.ok) {
          // Remember the failure: a 404 (no such entry) or a 500 will not
          // start working on the next deck load, and retrying on every load
          // would be a request per track per reload.
          set((s) => ({ byEntry: { ...s.byEntry, [entryId]: MISS } }));
          return null;
        }
        const body = (await res.json()) as { status?: string; downbeats?: unknown; bars?: unknown };
        // A cache miss stops here on purpose — see the header. No `/run`.
        if (body?.status !== 'ready') {
          set((s) => ({ byEntry: { ...s.byEntry, [entryId]: MISS } }));
          return null;
        }
        const data: DjRhythm = {
          ready: true,
          downbeats: times(body.downbeats),
          bars: times(body.bars),
        };
        set((s) => ({ byEntry: { ...s.byEntry, [entryId]: data } }));
        return data;
      } catch {
        // Backend still warming, or offline. Same as a miss: the DJ path
        // has a working fallback and must never surface this.
        set((s) => ({ byEntry: { ...s.byEntry, [entryId]: MISS } }));
        return null;
      } finally {
        inflight.delete(entryId);
      }
    })();
    inflight.set(entryId, run);
    return run;
  },
}));
