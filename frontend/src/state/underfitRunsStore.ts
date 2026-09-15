/**
 * The Underfit dashboard's training runs, as the footer's TRAIN key sees them.
 *
 * The dashboard (the UNDERFIT tab embeds it) sends no CORS headers, so
 * everything here goes through the backend:
 *   GET  /api/underfit/runs               — the runs and their statuses
 *   GET  /api/underfit/runs/{id}/config   — a run's settings, as /runs/new takes them
 *   POST /api/underfit/runs/new           — start a run
 *   POST /api/underfit/runs/{id}/kill     — kill a run's process group
 *
 * The key stops the live run, and with none live it trains again from the most
 * recent run's settings under a fresh name. Everything a first run needs —
 * picking a dataset, a base model, a rank — is the dashboard's form; the key
 * repeats what that form already produced once.
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
  /** The card it trained on. The next run goes on the same one. */
  gpu?: number | null;
}

/** A run's settings, as GET /api/underfit/runs/{id}/config returns them. */
export type UnderfitRunConfig = Record<string, unknown>;

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

/**
 * The run TRAIN repeats: the newest run of any status, live or finished, since
 * its settings are the last ones the user chose.
 */
export function lastUnderfitRun(runs: readonly UnderfitRun[]): UnderfitRun | null {
  if (runs.length === 0) return null;
  return runs.reduce((a, b) => (String(b.created_at ?? '') > String(a.created_at ?? '') ? b : a));
}

/**
 * The name for a repeat of `base`, unique among `taken`.
 *
 * "vox" becomes "vox 2", and a name that already ends in a number counts on, so
 * repeating "vox 2" gives "vox 3" rather than "vox 2 2". The dashboard slugifies
 * and rejects a duplicate slug with a 409, so the search runs to the first free
 * number rather than assuming the highest one is free.
 */
export function nextRunName(base: string, taken: readonly string[]): string {
  const slug = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const used = new Set(taken.map(slug));
  const m = /^(.*?)[\s_-]*(\d+)$/.exec(base.trim());
  const stem = (m ? m[1] : base).trim() || 'run';
  let n = m ? Number(m[2]) + 1 : 2;
  while (used.has(slug(`${stem} ${n}`))) n += 1;
  return `${stem} ${n}`;
}

interface UnderfitRunsState {
  runs: UnderfitRun[];
  link: TrainingLink;
  /** The run whose kill request is out, or null. */
  stoppingId: string | null;
  /** A start request is out. */
  starting: boolean;
  refresh: () => Promise<void>;
  /** Stops run `id`. A second call while a kill is out does nothing. */
  stopRun: (id: string) => Promise<void>;
  /**
   * Starts a run from the most recent run's settings, under a fresh name.
   * Does nothing while a start or a kill is out, or with no run to repeat.
   */
  trainAgain: () => Promise<void>;
}

/** The backend route is missing: this build's backend predates it. */
const RESTART_BACKEND = 'the backend has no Underfit run routes; restart the backend to get them';

/** The refusal in the backend's own words, or a plain description of the status. */
async function refusal(r: Response): Promise<string> {
  const detail = ((await r.json().catch(() => null)) as { detail?: unknown } | null)?.detail;
  // The routes' own refusals carry the dashboard's message; FastAPI's bare 404
  // is a backend that predates the route.
  if (r.status === 404 && detail === 'Not Found') return RESTART_BACKEND;
  return typeof detail === 'string' ? detail : `HTTP ${r.status}`;
}

export const useUnderfitRunsStore = create<UnderfitRunsState>()((set, get) => ({
  runs: [],
  link: 'dashboard-down',
  stoppingId: null,
  starting: false,

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
      if (!r.ok) throw new Error(await refusal(r));
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

  trainAgain: async () => {
    if (get().starting || get().stoppingId) return;
    const last = lastUnderfitRun(get().runs);
    if (!last) return;
    const from = runName(last);
    const name = nextRunName(from, get().runs.map(runName));
    set({ starting: true });
    useStatusBarStore.getState().setText(`STARTING TRAINING RUN: ${name}`);
    logInfo('training', `TRAIN pressed: starting "${name}" from the settings of "${from}".`);
    try {
      const cr = await fetch(`/api/underfit/runs/${encodeURIComponent(last.id)}/config`, { cache: 'no-store' });
      if (!cr.ok) throw new Error(await refusal(cr));
      const config = (await cr.json()) as UnderfitRunConfig;
      // The dashboard requires a GPU index and a name; everything else is the
      // previous run's. Its own validation answers for the rest.
      const body = { ...config, name, gpu: typeof last.gpu === 'number' ? last.gpu : 0 };
      const r = await fetch('/api/underfit/runs/new', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(await refusal(r));
      logInfo('training', `Started the Underfit training run "${name}". Watch it on the UNDERFIT tab.`);
      useStatusBarStore.getState().setText(`TRAINING RUN STARTED: ${name}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logError('training', `Could not start an Underfit training run: ${msg}`);
      useStatusBarStore.getState().setText(`TRAINING RUN NOT STARTED: ${msg}`);
    } finally {
      await get().refresh();
      set({ starting: false });
    }
  },
}));
