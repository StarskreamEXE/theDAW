/**
 * Polls `GET /api/library/index-status` while the backend is opening the
 * library, for the LIBRARY tab's progress bar.
 *
 * The backend opens the library off its startup: a schema upgrade, a first
 * start's read of every metadata.json, and the search index build can each
 * run for minutes on a 200,000-entry library. Meanwhile the list answers 503
 * (upgrade, read) or searches cover part of the library (index build), and
 * this store is what says how far it has got.
 *
 * Polling starts when something needs it — the progress bar mounting, the
 * list getting a 503, a searched page saying the index is incomplete — and
 * stops by itself at `ready` or `failed`. Two steps refetch the list: the
 * first snapshot that says the store is open while the list is still marked
 * refused (the upgrade is over; the list answers even while the search index
 * builds), and the step from a working phase to `ready` (every search answer
 * cached meanwhile covered part of the library). Both ask the counts store
 * for the new library revision and fetch the visible range again.
 */
import { create } from 'zustand';
import {
  fetchLibraryIndexStatus,
  isWorkingPhase,
  type LibraryIndexStatus,
} from '../lib/libraryIndexStatus';
import { useLibraryStore } from './libraryStore';
import { useLibraryCounts } from './libraryCountsStore';
import { logInfo, logWarn } from './logStore';

/** How often the status is asked for while a phase is running. */
export const INDEX_STATUS_POLL_MS = 1000;

/** How long to wait after a failed status request before asking again. */
export const INDEX_STATUS_RETRY_MS = 3000;

export type IndexStatusFetcher = (signal?: AbortSignal) => Promise<LibraryIndexStatus | null>;

export interface LibraryIndexStatusState {
  /** The last snapshot, or null before the first answer. */
  status: LibraryIndexStatus | null;
  /** False once the backend has proved it has no status route. */
  supported: boolean;
  /** True while a poll is scheduled or in flight. */
  watching: boolean;
  /** Start polling unless it already runs. */
  watch: () => void;
  /** Stop polling (the next `watch` starts again). */
  stop: () => void;
}

let fetcher: IndexStatusFetcher = (signal) => fetchLibraryIndexStatus(signal);
let timer: ReturnType<typeof setTimeout> | null = null;
let controller: AbortController | null = null;
/** Bumped by `stop`, so an answer from a stopped poll is dropped. */
let generation = 0;
/** Set once a refused list has been asked for again, until it is refused anew. */
let reopenAsked = false;

/** Test seam: replace the request (and reset the store). */
export function setIndexStatusFetcher(next: IndexStatusFetcher): void {
  fetcher = next;
  useLibraryIndexStatus.getState().stop();
  useLibraryIndexStatus.setState({ status: null, supported: true });
}

/** Ask for the list (and the counts) again. */
function refetchLibrary(): void {
  useLibraryCounts.getState().invalidate();
  useLibraryStore.getState().invalidatePages();
}

/** Everything cached while the library was opening is stale: ask again. */
function onLibraryReady(previous: LibraryIndexStatus): void {
  logInfo('library', `${previous.label || 'Opening the library'}: done`);
  reopenAsked = true;
  refetchLibrary();
}

export const useLibraryIndexStatus = create<LibraryIndexStatusState>((set, get) => {
  const schedule = (delay: number, gen: number): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void tick(gen);
    }, delay);
  };

  const tick = async (gen: number): Promise<void> => {
    if (gen !== generation) return;
    const ctrl = new AbortController();
    controller = ctrl;
    let next: LibraryIndexStatus | null;
    try {
      next = await fetcher(ctrl.signal);
    } catch (e) {
      if (gen !== generation || ctrl.signal.aborted) return;
      logWarn('library', `index status request failed: ${e instanceof Error ? e.message : String(e)}`);
      schedule(INDEX_STATUS_RETRY_MS, gen);
      return;
    } finally {
      if (controller === ctrl) controller = null;
    }
    if (gen !== generation) return;
    if (next === null) {
      // A backend from before the route: nothing to show, nothing to poll.
      set({ supported: false, watching: false });
      return;
    }
    const previous = get().status;
    set({ status: next });
    if (next.opened && !reopenAsked && useLibraryStore.getState().libraryOpening) {
      // The store answers now (the search index may still be building): the
      // list that was refused during the upgrade can be shown.
      reopenAsked = true;
      refetchLibrary();
    }
    if (isWorkingPhase(next.phase)) {
      schedule(INDEX_STATUS_POLL_MS, gen);
      return;
    }
    set({ watching: false });
    if (next.phase === 'ready' && previous !== null && isWorkingPhase(previous.phase)) {
      onLibraryReady(previous);
    }
  };

  return {
    status: null,
    supported: true,
    watching: false,
    watch: () => {
      if (!get().supported || get().watching) return;
      set({ watching: true });
      void tick(generation);
    },
    stop: () => {
      generation += 1;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      controller?.abort();
      controller = null;
      set({ watching: false });
    },
  };
});

// The list says the library is opening, or a search says the index is still
// building: start watching, so the bar appears and the list refreshes when the
// backend is done.
useLibraryStore.subscribe((s, prev) => {
  const opening = s.libraryOpening && !prev.libraryOpening;
  if (opening) reopenAsked = false;
  const partial = s.searchIndex !== null && !s.searchIndex.complete;
  const wasPartial = prev.searchIndex !== null && !prev.searchIndex.complete;
  if (opening || (partial && !wasPartial)) useLibraryIndexStatus.getState().watch();
});
