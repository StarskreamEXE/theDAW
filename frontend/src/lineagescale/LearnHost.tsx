import React, { Suspense, lazy, useCallback, useEffect, useState } from 'react';
import { fetchLineageSummaryProbe, type LineageSummary, type SummaryProbe } from './lineageScaleClient';
import { formatCount } from './lineageScaleModel';

/**
 * LearnHost — the LEARN tab, hosting BOTH lineage views.
 *
 * The classic graph (`LineageModal`'s `LineageView`) draws every song in the
 * library at once. On a small library that is the right picture and nothing
 * here changes it. On the user's real library it is 194,833 nodes, 475,174
 * links and a 128 MB answer, and the page dies — so on a library that size the
 * classic view is not offered as a choice the user can make and regret: the
 * button is there, disabled, saying why, and it is NEVER MOUNTED, because
 * mounting it is what fires the request.
 *
 * Which view opens is therefore the backend's call, not a preference:
 * `/summary`'s `full_view_ok` (with_lineage <= 2000). A backend that does not
 * have this module at all answers 404 — an older build — and that falls back
 * to exactly today's behaviour, the classic view, with nothing alarming shown.
 *
 * ONLY a 404 means that. Any other failure — a 500, a 503 while the library is
 * still opening, a dropped request — leaves the library's size unknown, and
 * "unknown" must never be read as "small": on the real library that mounts the
 * classic view and brings back the crash. So a non-404 failure stays on the new
 * view, says so, and offers a retry.
 *
 * The props are the ones `DAWCenterPanel` already passes to `LineageView`, so
 * mounting this instead is a one-line change at the import.
 */

export type LearnMode = 'scale' | 'classic';

/** The props both hosted views take — and the ones this host is given. */
export interface LearnViewProps {
  rootEntryId?: string | null;
  visible?: boolean;
}

const CHOICE_KEY = 'thedaw.learnMode';

/* ─────────────────────────────── the decision ────────────────────────────── */

export interface LearnDecision {
  mode: LearnMode;
  /** False when the classic view would certainly fail to load. */
  classicAllowed: boolean;
  /** Why it is not allowed, in the library's real numbers. '' when allowed. */
  reason: string;
}

/**
 * Why `with_lineage`: the classic view draws the songs that HAVE relationships
 * — that is the drawing that will not fit — and it is the number the backend
 * already counts for `full_view_ok`.
 */
export const classicUnavailableReason = (summary: LineageSummary): string =>
  `The classic graph draws every song at once. This library has ${formatCount(summary.with_lineage)} connected songs, so it cannot load here.`;

/**
 * Why the classic view is refused when the summary could not be read at all.
 * Not knowing the size is not permission to try the drawing that dies.
 */
export const classicUnknownSizeReason =
  'The lineage summary could not be read, so this library’s size is unknown. The classic graph is not offered until it is.';

/**
 * Which view to open, once the summary has been asked for. The caller shows
 * its own loading state until then and mounts NEITHER view, because rendering
 * the classic one is what starts the 128 MB request.
 *
 *  * `failed` — the route answered something other than 404. The size is
 *    unknown, so the new view stays up with its own error state and the
 *    classic one is refused. This case is NOT the old behaviour and must not
 *    be collapsed into it.
 *  * `summary === null` and not `failed` — a 404: a backend that predates this
 *    module. That is the classic view, exactly what this tab did before, with
 *    nothing alarming said.
 *  * `full_view_ok` → the classic view by default, so a small library sees no
 *    change at all. The user may switch, and that choice is remembered.
 *  * not `full_view_ok` → the new view, and the classic one is refused. A
 *    remembered choice does not override this; it is not a matter of taste.
 */
export function decideLearnMode(
  summary: LineageSummary | null,
  remembered: LearnMode | null,
  failed = false,
): LearnDecision {
  if (failed) {
    return { mode: 'scale', classicAllowed: false, reason: classicUnknownSizeReason };
  }
  if (!summary) return { mode: 'classic', classicAllowed: true, reason: '' };
  if (!summary.full_view_ok) {
    return { mode: 'scale', classicAllowed: false, reason: classicUnavailableReason(summary) };
  }
  return { mode: remembered ?? 'classic', classicAllowed: true, reason: '' };
}

/* ───────────────────────────── remembered choice ─────────────────────────── */

const isMode = (v: unknown): v is LearnMode => v === 'scale' || v === 'classic';

/** The session's choice, or null. Storage can be absent or throw (private
 *  browsing, a non-browser host); a missing preference is not an error. */
export function rememberedMode(): LearnMode | null {
  try {
    if (typeof sessionStorage === 'undefined') return null;
    const raw = sessionStorage.getItem(CHOICE_KEY);
    return isMode(raw) ? raw : null;
  } catch {
    return null;
  }
}

export function rememberMode(mode: LearnMode): void {
  try {
    if (typeof sessionStorage === 'undefined') return;
    sessionStorage.setItem(CHOICE_KEY, mode);
  } catch {
    /* nothing to do: the choice simply does not outlive this mount */
  }
}

/* ──────────────────────────────── the chrome ─────────────────────────────── */

const REASON_ID = 'lineage-scale-classic-unavailable';

export interface LearnSwitchProps {
  mode: LearnMode;
  classicAllowed: boolean;
  reason: string;
  onSelect: (mode: LearnMode) => void;
}

const TAB_BASE = 'px-2 py-1 rounded text-[9px] font-mono uppercase tracking-widest border';
const TAB_ON = 'bg-purple-500/20 text-purple-200 border-purple-400/50';
const TAB_OFF = 'bg-black/40 text-zinc-400 border-white/10 hover:text-zinc-200';
const TAB_DEAD = 'bg-black/40 text-zinc-600 border-white/5 cursor-not-allowed';

/** The two-option switch. */
export const LearnSwitch: React.FC<LearnSwitchProps> = ({
  mode, classicAllowed, reason, onSelect,
}) => (
  <div className="flex items-center gap-1 border-b border-white/10 px-2 py-1">
    <div role="group" aria-label="Lineage view" className="flex items-center gap-1">
      <button
        type="button"
        onClick={() => onSelect('scale')}
        aria-pressed={mode === 'scale'}
        className={`${TAB_BASE} ${mode === 'scale' ? TAB_ON : TAB_OFF}`}
      >
        Lineage
      </button>
      <button
        type="button"
        onClick={() => onSelect('classic')}
        aria-pressed={mode === 'classic'}
        disabled={!classicAllowed}
        aria-describedby={classicAllowed ? undefined : REASON_ID}
        className={`${TAB_BASE} ${
          !classicAllowed ? TAB_DEAD : mode === 'classic' ? TAB_ON : TAB_OFF
        }`}
      >
        Classic graph
      </button>
    </div>
    {!classicAllowed && (
      <p id={REASON_ID} className="ml-1 truncate text-[9px] font-mono text-zinc-500">
        {reason}
      </p>
    )}
  </div>
);

/* ──────────────────────────────── the host ───────────────────────────────── */

/** The new view. Loaded on demand, like every other tab body. */
const DefaultScaleView = lazy(() => import('./LineageScaleView'));

/**
 * The EXISTING view, untouched and rendered with the props it gets today.
 * `lazy` is what keeps the promise in this file's header: the module — and the
 * whole-library request its mount makes — is not even fetched until the classic
 * pane is actually placed in the tree.
 */
const DefaultClassicView = lazy(() =>
  import('../components/library/LineageModal').then((m) => ({ default: m.LineageView })),
);

const Waiting: React.FC<{ what: string }> = ({ what }) => (
  <p className="absolute inset-0 flex items-center justify-center text-[10px] font-mono text-zinc-500">
    {what}
  </p>
);

/** The summary is read ONCE, and only for a tab the user is looking at. */
export const shouldReadSummary = (visible: boolean, alreadyRead: boolean): boolean =>
  visible && !alreadyRead;

export interface LearnHostSurfaceProps extends LearnViewProps {
  /** Has the summary request finished (either way)? */
  read: boolean;
  /** What it said, or null when there was none (a 404, or a failure). */
  summary: LineageSummary | null;
  /**
   * The message from a failure that was NOT a 404, or null. Set means the
   * library's size is unknown, so the classic view stays unmounted.
   */
  failure?: string | null;
  /** Ask for the summary again after a failure. */
  onRetry?: () => void;
  /** The session's remembered choice, if any. */
  chosen: LearnMode | null;
  onSelect: (mode: LearnMode) => void;
  /** Swapped in tests, so a render test never pulls in either real view. */
  scaleView?: React.ComponentType<LearnViewProps>;
  classicView?: React.ComponentType<LearnViewProps>;
}

/**
 * Everything the host DOES, as a function of what it knows — so every state it
 * can be in is a render test and not a browser. `LearnHost` adds only the two
 * pieces of state and the one request that produce these props.
 *
 * The classic pane is not merely hidden when it is not the mode: the element is
 * never constructed, so neither the lazy import nor the mount that fires the
 * whole-library request can happen.
 */
export const LearnHostSurface: React.FC<LearnHostSurfaceProps> = ({
  read, summary, failure = null, onRetry, chosen, onSelect,
  rootEntryId = null, visible = true, scaleView, classicView,
}) => {
  const decision = decideLearnMode(summary, chosen, failure !== null);
  const Scale = scaleView ?? DefaultScaleView;
  const Classic = classicView ?? DefaultClassicView;

  // Until the answer is in there is no choice to show and, above all, no
  // classic view to mount.
  if (!read) {
    return (
      <div className="relative h-full w-full bg-black/20">
        <Waiting what={visible ? 'Reading this library’s lineage…' : ''} />
      </div>
    );
  }

  return (
    <div className="flex h-full w-full flex-col bg-black/20">
      <LearnSwitch
        mode={decision.mode}
        classicAllowed={decision.classicAllowed}
        reason={decision.reason}
        onSelect={onSelect}
      />
      {failure !== null && (
        <div
          role="status"
          className="flex items-center gap-2 border-b border-amber-400/30 bg-amber-500/10 px-2 py-1"
        >
          <p className="min-w-0 grow truncate text-[9px] font-mono text-amber-200">
            {`Could not read this library’s lineage summary: ${failure}`}
          </p>
          <button
            type="button"
            onClick={onRetry}
            className="shrink-0 rounded border border-amber-400/40 px-2 py-0.5 text-[9px] font-mono uppercase tracking-widest text-amber-100 hover:border-amber-300/70 hover:text-white"
          >
            Retry
          </button>
        </div>
      )}
      <div className="relative min-h-0 grow">
        <Suspense fallback={<Waiting what="Loading…" />}>
          {decision.mode === 'classic'
            ? <Classic rootEntryId={rootEntryId} visible={visible} />
            : <Scale rootEntryId={rootEntryId} visible={visible} />}
        </Suspense>
      </div>
    </div>
  );
};

export interface LearnHostProps extends LearnViewProps {
  /**
   * Swapped in tests. The default reads `/api/lineage-scale/summary` and
   * reports `{kind: 'absent'}` for a 404 ONLY; anything else it rejects with,
   * which is what keeps the classic view unmounted on an unknown library.
   */
  loadSummary?: () => Promise<SummaryProbe>;
  scaleView?: React.ComponentType<LearnViewProps>;
  classicView?: React.ComponentType<LearnViewProps>;
}

export const LearnHost: React.FC<LearnHostProps> = ({
  rootEntryId = null,
  visible = true,
  loadSummary,
  scaleView,
  classicView,
}) => {
  const [summary, setSummary] = useState<LineageSummary | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [read, setRead] = useState(false);
  const [chosen, setChosen] = useState<LearnMode | null>(() => rememberedMode());

  useEffect(() => {
    if (!shouldReadSummary(visible, read)) return undefined;
    let live = true;
    (loadSummary ?? fetchLineageSummaryProbe)()
      .then((probe) => {
        if (!live) return;
        // 'absent' is a 404: an older backend has no such route. That is not
        // an error the user needs to see; it is the old behaviour, so take it.
        setSummary(probe.kind === 'ok' ? probe.summary : null);
        setFailure(null);
        setRead(true);
      })
      .catch((e: unknown) => {
        // NOT a 404. The size is unknown, so the classic view is not mounted
        // on a guess; the new view stays up and says what happened.
        if (!live) return;
        setSummary(null);
        setFailure(e instanceof Error ? e.message : String(e));
        setRead(true);
      });
    return () => {
      live = false;
    };
  }, [visible, read, loadSummary]);

  const onSelect = useCallback((mode: LearnMode) => {
    setChosen(mode);
    rememberMode(mode);
  }, []);

  // `read` back to false is what re-arms the effect above; `shouldReadSummary`
  // is the only gate, so there is no second attempt counter to keep in step.
  const onRetry = useCallback(() => {
    setFailure(null);
    setRead(false);
  }, []);

  return (
    <LearnHostSurface
      read={read}
      summary={summary}
      failure={failure}
      onRetry={onRetry}
      chosen={chosen}
      onSelect={onSelect}
      rootEntryId={rootEntryId}
      visible={visible}
      scaleView={scaleView}
      classicView={classicView}
    />
  );
};

/**
 * The name `DAWCenterPanel` mounts the LEARN tab under. Exported so the tab's
 * lazy import can name it, and as the default so it can skip the `.then`.
 */
export const LineageView = LearnHost;

export default LearnHost;
