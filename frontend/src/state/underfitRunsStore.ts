/**
 * The Underfit dashboard's training runs, as the footer's UNDERFIT key sees
 * them. The dashboard (the UNDERFIT tab embeds it) starts runs from its own
 * forms; this store follows them through the backend (GET /api/underfit/runs,
 * since the dashboard sends no CORS headers) and stops one on request
 * (POST /api/underfit/runs/{id}/kill, which kills the run's process group).
 */
import { create } from 'zustand';
import { logError, logInfo } from './logStore';
import { useStatusBarStore } from './statusBarStore';

/** One run, with the fields GET /api/underfit/runs passes on. */
export interface UnderfitRun {
  id: string;
  display_name?: string | null;
  status?: string | null;
  created_at?: string | null;
}

/**
 * How the key reaches the runs: `ok` (the dashboard answered), `dashboard-down`
 * (the dashboard or the backend did not answer), `backend-old` (the backend
 * predates the run routes and needs a restart).
 */
export type TrainingLink = 'ok' | 'dashboard-down' | 'backend-old';

/** The dashboard statuses of a run whose process is live: the ones its kill route stops. */
const LIVE_STATUSES = new Set(['training', 'demos', 'loading', 'resuming', 'paused']);

export interface LiveUnderfitRun {
  run: UnderfitRun;
  /** Live runs besides `run`. */
  others: number;
}

/** The run the key stops: the newest live run (latest created_at, the first listed on a tie). */
export function liveUnderfitRun(runs: readonly UnderfitRun[]): LiveUnderfitRun | null {
  const live = runs.filter((r) => LIVE_STATUSES.has(String(r.status ?? '')));
  if (live.length === 0) return null;
  const newest = live.reduce((a, b) => (String(b.created_at ?? '') > String(a.created_at ?? '') ? b : a));
  return { run: newest, others: live.length - 1 };
}

/** A run's printed name. */
export const runName = (run: UnderfitRun): string => run.display_name || run.id;

interface UnderfitRunsState {
  runs: UnderfitRun[];
  link: TrainingLink;
  /** The run whose kill request is out, or null. */
  stoppingId: string | null;
  refresh: () => Promise<void>;
  /** Stops run `id`. A second call while a kill is out does nothing. */
  stopRun: (id: string) => Promise<void>;
}

export const useUnderfitRunsStore = create<UnderfitRunsState>()((set, get) => ({
  runs: [],
  link: 'dashboard-down',
  stoppingId: null,

  refresh: async () => {
    try {
      const r = await fetch('/api/underfit/runs', { cache: 'no-store' });
      if (r.status === 404) {
        set({ runs: [], link: 'backend-old' });
        return;
      }
      if (!r.ok) {
        set({ runs: [], link: 'dashboard-down' });
        return;
      }
      const body = (await r.json()) as { reachable?: boolean; runs?: UnderfitRun[] };
      set({
        runs: Array.isArray(body.runs) ? body.runs.filter((x) => x && typeof x.id === 'string') : [],
        link: body.reachable ? 'ok' : 'dashboard-down',
      });
    } catch {
      set({ runs: [], link: 'dashboard-down' });
    }
  },

  stopRun: async (id) => {
    if (get().stoppingId) return;
    const run = get().runs.find((r) => r.id === id);
    const name = run ? runName(run) : id;
    set({ stoppingId: id });
    useStatusBarStore.getState().setText(`STOPPING TRAINING RUN: ${name}`);
    logInfo('training', `STOP pressed: stopping the Underfit training run "${name}"`);
    try {
      const r = await fetch(`/api/underfit/runs/${encodeURIComponent(id)}/kill`, { method: 'POST' });
      if (!r.ok) {
        const detail = ((await r.json().catch(() => null)) as { detail?: unknown } | null)?.detail;
        // The route's own refusals carry the dashboard's message; FastAPI's bare
        // 404 is a backend that predates the route.
        const why = r.status === 404 && detail === 'Not Found'
          ? 'the backend has no Underfit run routes; restart the backend to get them'
          : typeof detail === 'string' ? detail : `HTTP ${r.status}`;
        throw new Error(why);
      }
      logInfo('training', `Stopped the Underfit training run "${name}".`);
      useStatusBarStore.getState().setText(`TRAINING RUN STOPPED: ${name}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logError('training', `Could not stop the Underfit training run "${name}": ${msg}`);
      useStatusBarStore.getState().setText(`TRAINING RUN NOT STOPPED: ${msg}`);
    } finally {
      await get().refresh();
      set({ stoppingId: null });
    }
  },
}));
