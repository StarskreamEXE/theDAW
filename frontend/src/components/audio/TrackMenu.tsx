/**
 * The footer's three-dots key and the track menu it opens: everything the app
 * can do with the track the footer has loaded, in one card.
 *
 * Layout: one wide card of grouped columns, never submenus. Every action is
 * one click from the key and in view at once; the groups pack into as few
 * columns as the screen height allows (five at 1366x768, and the same five at
 * 1920x1080, where the column height is capped) and the card only scrolls on a
 * screen too small for that (trackMenuModel.packTrackMenuColumns).
 *
 * Rows come from buildTrackMenu, a pure function of the loaded track and the
 * facts the backend reports when the menu opens. A row that cannot apply stays
 * in place, dimmed, with the reason in its tooltip and in the status line at
 * the card's foot (which is what a keyboard user sees). A row that starts a
 * backend job carries a JOB legend. Stems are one line each, with icon keys.
 *
 * The card is a DockFlyout (placement, focus in and back, Tab out, Escape,
 * outside click). It portals into its own full-viewport theme host: the
 * footer's backdrop blur is a containing block for fixed descendants, so a card
 * portaled into the footer would be placed against the footer's box.
 *
 * Keys inside the card: Up/Down walk every row in reading order, Left/Right
 * jump to the nearest row of the next column, Home/End, a letter jumps to the
 * next row starting with it, Enter/Space choose. Every key but Escape and Tab
 * stops at the card, modified or not, because EDIT's window shortcuts (Space
 * plays, Home/End move the playhead, letters pick tools, Delete removes clips,
 * Ctrl+Z undoes) would otherwise act behind the open menu. Escape and Tab go
 * on to DockFlyout.
 *
 * Two kinds of row ask for input first: Separate stems and Stems as EDIT
 * tracks open the stem settings dialog, and Load lyrics opens the file picker
 * from the click itself (a picker needs the click's user activation).
 */
import React, { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Activity, AlignLeft, ArrowRightToLine, AudioLines, AudioWaveform, BookOpen, Brush, Captions, Cast, CircleStop,
  ClipboardCopy, Combine, Disc, Disc3, Dna, Download, Drum, Eraser, FileAudio, FileJson, FileMusic, FileText, FileUp,
  FolderOpen, Gauge, GitFork, Grid2x2, Grid3x3, Guitar, Image as ImageIcon, Inbox, Info, Layers,
  Library as LibraryIcon, LibraryBig, Link as LinkIcon, ListEnd, ListMusic, ListPlus, MessageSquareText, Mic, MicVocal,
  MoreHorizontal, Music, Network, Package, Palette, PenLine, Piano, Quote, ScanLine, ScanSearch, Scissors,
  ScrollText, Shuffle, SlidersHorizontal, Sparkles, Split, SquarePlus, Star, Swords, Tag, TextCursorInput,
  ThumbsDown, ThumbsUp, Timer, Trash2, Type, Waves, Workflow,
  type LucideIcon,
} from 'lucide-react';
import { DockFlyout, FLYOUT_CARD } from './midiDockKit';
import {
  lastMenuItem,
  markOf,
  menuItems,
  restoreTarget,
  rovingIndex,
  type FocusMark,
  type MenuKey,
} from './trackMenuFocus';
import { TrackMetaDialog } from './TrackMetaDialog';
import { StemsRunModal, type StemsRunOptions } from '../library/StemsRunModal';
import { usePlayerStore, getLoadedAudioUrl } from '../../state/playerStore';
import { useLibraryStore, type LibraryEntry } from '../../state/libraryStore';
import { useShardIndexStore } from '../../state/shardIndexStore';
import { useDjSideList } from '../../state/djSideListStore';
import { useDjSampler } from '../../state/djSamplerStore';
import { useSetlistStore } from '../../state/setlistStore';
import { useEditThemeStore } from '../../state/editThemeStore';
import { useFeatureToggleStore } from '../../state/featureToggleStore';
import { useTrackMenuJobs } from '../../state/trackMenuJobStore';
import { logError } from '../../state/logStore';
import { resolveEditThemeVars } from '../../lib/editThemes';
import { isLocalClient } from '../../lib/placesClient';
import { loadConvertFormats } from '../../convert/convertClient';
import { deriveLyrics, deriveStyle } from '../../catalog/catalogSearch';
import type { TrackMenuActionContext, TrackMenuSubject } from './trackMenuActions';
import {
  REASON,
  allTrackMenuRows,
  buildTrackMenu,
  destinationName,
  packTrackMenuColumns,
  probeChecking,
  probeFailed,
  probeKnown,
  trackMenuColumnHeight,
  trackMenuMaxColumns,
  trackMenuSubjectKind,
  type Probe,
  type TrackMenuFacts,
  type TrackMenuFormat,
  type TrackMenuGroup,
  type TrackMenuIcon,
  type TrackMenuLyricsDoc,
  type TrackMenuRow,
  type TrackMenuRunningJob,
  type TrackMenuStem,
  type TrackMenuSubjectKind,
} from './trackMenuModel';

const LineageModal = lazy(() => import('../library/LineageModal').then((m) => ({ default: m.LineageModal })));

const MENU_ID = 'footer-track-menu';
const LYRICS_INPUT_ID = 'footer-track-menu-lyrics-file';
/** The flyout's gap above the key plus its screen-edge pad. */
const KEY_CLEARANCE_PX = 10;

const ICONS: Record<TrackMenuIcon, LucideIcon> = {
  'list-music': ListMusic, sparkles: Sparkles, 'square-plus': SquarePlus, 'arrow-right-to-line': ArrowRightToLine,
  layers: Layers, 'sliders-horizontal': SlidersHorizontal, dna: Dna, 'grid-3x3': Grid3x3, workflow: Workflow,
  'git-fork': GitFork, waves: Waves, cast: Cast, info: Info, music: Music, 'mic-vocal': MicVocal, 'book-open': BookOpen,
  'pen-line': PenLine, 'audio-lines': AudioLines, brush: Brush, gauge: Gauge, activity: Activity,
  'audio-waveform': AudioWaveform, eraser: Eraser, combine: Combine, 'text-cursor-input': TextCursorInput, 'disc-3': Disc3,
  'file-music': FileMusic, piano: Piano, 'grid-2x2': Grid2x2, drum: Drum, 'scan-line': ScanLine, 'scan-search': ScanSearch,
  split: Split, timer: Timer, scissors: Scissors, captions: Captions, 'align-left': AlignLeft, quote: Quote, mic: Mic,
  guitar: Guitar, swords: Swords, image: ImageIcon, disc: Disc, 'list-plus': ListPlus, 'list-end': ListEnd,
  shuffle: Shuffle, download: Download, package: Package, 'file-json': FileJson, network: Network, 'file-text': FileText,
  'file-audio': FileAudio, 'folder-open': FolderOpen, 'clipboard-copy': ClipboardCopy, link: LinkIcon, type: Type,
  'message-square-text': MessageSquareText, palette: Palette, 'scroll-text': ScrollText, inbox: Inbox,
  library: LibraryIcon, star: Star, 'thumbs-up': ThumbsUp, 'thumbs-down': ThumbsDown, tag: Tag,
  'library-big': LibraryBig, 'trash-2': Trash2, 'file-up': FileUp, 'circle-stop': CircleStop,
};

const KIND_LEGEND: Record<TrackMenuSubjectKind, string> = {
  none: 'Nothing loaded',
  library: 'Library',
  editor: 'EDIT timeline',
  loose: 'Loaded audio',
};

/* ── what the backend knows about the entry ───────────────────────────── */

interface Probes {
  stems: Probe<TrackMenuStem[]>;
  wholeMidi: Probe<boolean>;
  notation: Probe<{ midi: number; score: number }>;
  lyricsDoc: Probe<TrackMenuLyricsDoc>;
  vocalNotes: Probe<boolean>;
  rhythmReady: Probe<boolean>;
  audioPath: Probe<string | null>;
  convertFormats: Probe<TrackMenuFormat[]>;
  /** A stem separation is in flight for the entry. */
  runningStems: Probe<boolean>;
}

const checkingProbes = (): Probes => ({
  stems: probeChecking(),
  wholeMidi: probeChecking(),
  notation: probeChecking(),
  lyricsDoc: probeChecking(),
  vocalNotes: probeChecking(),
  rhythmReady: probeChecking(),
  audioPath: probeChecking(),
  convertFormats: probeChecking(),
  runningStems: probeChecking(),
});

/** A track that is not a library entry has none of the entry facts. */
const entrylessProbes = (): Probes => ({
  stems: probeKnown([]),
  wholeMidi: probeKnown(false),
  notation: probeKnown({ midi: 0, score: 0 }),
  lyricsDoc: probeKnown({ text: '', timed: false }),
  vocalNotes: probeKnown(false),
  rhythmReady: probeKnown(false),
  audioPath: probeKnown(null),
  convertFormats: probeChecking(),
  runningStems: probeKnown(false),
});

/** Stem separation phases after which nothing runs. */
const STEMS_AT_REST = new Set(['idle', 'completed', 'failed', 'aborted']);

async function getJson(url: string, signal: AbortSignal): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, { signal });
  return { status: res.status, body: await res.json().catch(() => null) };
}

/** Read one probe; a 404 for the entry means "none", anything else unexpected is a failed check. */
function probe<T>(
  url: string,
  signal: AbortSignal,
  read: (body: unknown) => T,
  onNotFound: (body: unknown) => Probe<T>,
): Promise<Probe<T>> {
  return getJson(url, signal).then(
    ({ status, body }) => (status === 200 ? probeKnown(read(body)) : status === 404 ? onNotFound(body) : probeFailed<T>()),
    () => probeFailed<T>(),
  );
}

/** Whether a resource exists, without downloading it (the vocal artifact
 *  carries the whole pitch curve). */
function probeExists(url: string, signal: AbortSignal): Promise<Probe<boolean>> {
  return fetch(url, { signal }).then(
    (res) => {
      void res.body?.cancel().catch(() => undefined);
      return res.status === 200 ? probeKnown(true) : res.status === 404 ? probeKnown(false) : probeFailed<boolean>();
    },
    () => probeFailed<boolean>(),
  );
}

type Json = Record<string, unknown>;
const asList = (v: unknown): Json[] => (Array.isArray(v) ? (v as Json[]) : []);
const extOf = (path: unknown): string => /\.([a-z0-9]{1,5})$/i.exec(String(path ?? ''))?.[1].toLowerCase() ?? 'wav';

/* ── keyboard helpers ─────────────────────────────────────────────────── */

const itemsIn = menuItems;

/** The row of the next column (dir 1) or the previous one (dir -1) nearest in height. */
function acrossColumns(from: HTMLElement, dir: 1 | -1, root: HTMLElement): HTMLElement | null {
  const column = from.closest<HTMLElement>('[data-track-menu-column]');
  if (!column) return null;
  const target = root.querySelector<HTMLElement>(
    `[data-track-menu-column="${Number(column.dataset.trackMenuColumn) + dir}"]`,
  );
  if (!target) return null;
  const a = from.getBoundingClientRect();
  const y = a.top + a.height / 2;
  let best: HTMLElement | null = null;
  let bestDistance = Infinity;
  for (const item of itemsIn(target)) {
    const r = item.getBoundingClientRect();
    const d = Math.abs(r.top + r.height / 2 - y);
    if (d < bestDistance) {
      best = item;
      bestDistance = d;
    }
  }
  return best;
}

/* ── the rows ─────────────────────────────────────────────────────────── */

// No leading-none: a 12px label needs its 16px line box, or the span's
// overflow clips the descenders of g, j, p, q and y.
const ROW =
  'group/row h-6 w-full flex items-center gap-2 px-2 rounded-xs text-left text-xs font-semibold select-none et-ink';
const KEY = 'group/row h-6 w-6 shrink-0 flex items-center justify-center rounded-xs select-none et-ink';
const ROW_LIVE =
  'cursor-pointer hover:shadow-[inset_0_0_0_100px_rgb(var(--et-tint)/0.1)] focus:shadow-[inset_0_0_0_100px_rgb(var(--et-tint)/0.1)]';
const ROW_OFF =
  'cursor-default *:opacity-60 hover:shadow-[inset_0_0_0_100px_rgb(var(--et-tint)/0.05)] focus:shadow-[inset_0_0_0_100px_rgb(var(--et-tint)/0.1)]';
const CHIP =
  'h-6 min-w-0 px-1 flex items-center justify-center rounded-xs bg-white/5 text-xs font-semibold tabular-nums whitespace-nowrap select-none et-ink';
const LEGEND = 'shrink-0 font-display text-xs font-bold tracking-wider et-ink-3';
/** A row's JOB legend: off rows carry it in the second ink, which stays
 *  readable once the row is dimmed. */
const ROW_LEGEND_OFF = 'shrink-0 font-display text-xs font-bold tracking-wider et-ink-2';

/** What a screen reader hears after the label. */
const spokenExtras = (row: TrackMenuRow): string =>
  [row.longJob ? 'starts a backend job' : null, row.goes ? `opens ${destinationName(row.goes)}` : null]
    .filter(Boolean)
    .join(', ');

/** The status line for the row under the hand or the focus. */
const statusFor = (row: TrackMenuRow): string => {
  if (!row.enabled) return `Off: ${row.reason}`;
  const extras = [row.longJob ? 'Runs as a backend job' : null, row.goes ? `Opens ${destinationName(row.goes)}` : null];
  return [row.does, ...extras].filter(Boolean).join('. ');
};

interface PendingRow {
  row: TrackMenuRow;
  subject: TrackMenuSubject;
  ctx: TrackMenuActionContext;
}

const runRow = ({ row, subject, ctx }: PendingRow) => {
  void import('./trackMenuActions')
    .then((m) => m.runTrackMenuRow(row, subject, ctx))
    .catch((e) => logError('track-menu', `The track menu could not load its actions: ${e instanceof Error ? e.message : String(e)}`));
};

interface TrackMenuProps {
  /** The footer's icon-button class, so the key matches its neighbours. */
  buttonClassName: string;
}

export const TrackMenu: React.FC<TrackMenuProps> = ({ buttonClassName }) => {
  const keyRef = useRef<HTMLButtonElement | null>(null);
  const lyricsInputRef = useRef<HTMLInputElement | null>(null);
  /**
   * Opened with ArrowUp on the key: focus the last row, not the first.
   *
   * It stays set until the user moves focus themselves, because the menu's last
   * row is not the last row for long. The Stems group is built last and starts
   * as one "Checking" placeholder; when the probe lands it becomes a line per
   * stem, so the row that was last is gone and many rows now sit below it. Held,
   * the intent re-lands on whatever the last row has become.
   */
  const focusLastRef = useRef(false);
  /** Where focus was, to give it back when a resize remounts the columns or a
   *  probe replaces the row (trackMenuFocus). */
  const markRef = useRef<FocusMark | null>(null);
  /** Load lyrics waits here for the file picker's answer. */
  const pendingLyricsRef = useRef<PendingRow | null>(null);
  const [open, setOpen] = useState(false);
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const [space, setSpace] = useState({ height: 600, width: 1366 });
  const [pointedId, setPointedId] = useState<string | null>(null);
  const [lineageId, setLineageId] = useState<string | null>(null);
  const [metaEntry, setMetaEntry] = useState<LibraryEntry | null>(null);
  const [stemsAsk, setStemsAsk] = useState<PendingRow | null>(null);

  const themeId = useEditThemeStore((s) => s.themeId);
  const themeImage = useEditThemeStore((s) => s.customImage);
  const theme = useMemo(() => resolveEditThemeVars(themeId, themeImage), [themeId, themeImage]);

  const hasTrack = usePlayerStore((s) => s.hasTrack);
  const currentEntryId = usePlayerStore((s) => s.currentEntryId);
  const currentLabel = usePlayerStore((s) => s.currentLabel);
  const entries = useLibraryStore((s) => s.entries);
  const found = useMemo(
    () => (currentEntryId ? entries.find((e) => e.id === currentEntryId) ?? null : null),
    [entries, currentEntryId],
  );
  const kind = trackMenuSubjectKind({ hasTrack, entryId: currentEntryId }, !!found);
  const entry = kind === 'library' ? found : null;
  const label = entry?.title || currentLabel || '';

  const crate = useShardIndexStore((s) => s.crate);
  const djNext = useDjSideList((s) => s.items);
  const pads = useDjSampler((s) => s.pads);
  const activeSetId = useSetlistStore((s) => s.activeId);
  const setlists = useSetlistStore((s) => s.setlists);
  const vocalJobs = useTrackMenuJobs((s) => s.vocal);

  const measure = useCallback(() => {
    const top = keyRef.current?.getBoundingClientRect().top ?? window.innerHeight - 40;
    setSpace((prev) => {
      const next = { height: Math.floor(top - KEY_CLEARANCE_PX), width: window.innerWidth };
      return prev.height === next.height && prev.width === next.width ? prev : next;
    });
  }, []);

  useEffect(() => {
    if (!open) return;
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [open, measure]);

  const close = useCallback(() => {
    setOpen(false);
    setPointedId(null);
    markRef.current = null;
    focusLastRef.current = false;
  }, []);

  /** The user moved focus themselves, so the menu stops steering it. */
  const takeFocus = useCallback(() => {
    focusLastRef.current = false;
  }, []);

  const toggle = () => {
    if (open) {
      close();
      return;
    }
    measure();
    setOpen(true);
  };

  // Probes, keyed by what they describe so a result for one track never
  // shows on another.
  const probeKey = `${kind}:${entry?.id ?? ''}`;
  const [probeState, setProbeState] = useState<{ key: string; probes: Probes } | null>(null);

  useEffect(() => {
    if (!open) return;
    const ctl = new AbortController();
    const key = probeKey;
    const id = entry?.id ?? null;
    const base = id ? checkingProbes() : entrylessProbes();
    setProbeState({ key, probes: base });
    const put = <K extends keyof Probes>(name: K, value: Probes[K]) => {
      if (ctl.signal.aborted) return;
      setProbeState((prev) => (prev && prev.key === key ? { key, probes: { ...prev.probes, [name]: value } } : prev));
    };

    void loadConvertFormats().then(
      (catalog) =>
        put('convertFormats', probeKnown(catalog.formats.filter((f) => f.kind === 'audio').map((f) => ({ id: f.id, label: f.label })))),
      () => put('convertFormats', probeFailed()),
    );

    if (id) {
      const enc = encodeURIComponent(id);
      const signal = ctl.signal;
      void probe<TrackMenuStem[]>(`/api/stems/${enc}`, signal,
        (b) =>
          asList((b as Json)?.stems)
            .filter((s) => s.id !== undefined && s.id !== null && String(s.id) !== '')
            .map((s) => ({ id: String(s.id), name: String(s.stem_name ?? s.name ?? 'stem'), ext: extOf(s.audio_path) })),
        () => probeKnown<TrackMenuStem[]>([]),
      ).then((p) => put('stems', p));
      void probe(`/api/midi/${enc}`, signal,
        (b) => asList((b as Json)?.midis).some((m) => m.id === `${id}__full`),
        () => probeKnown(false),
      ).then((p) => put('wholeMidi', p));
      void probe(`/api/notation/${enc}/artifacts`, signal,
        (b) => {
          const artifacts = asList((b as Json)?.artifacts);
          return {
            midi: artifacts.filter((a) => a.kind === 'midi').length,
            score: artifacts.filter((a) => a.kind === 'musicxml').length,
          };
        },
        () => probeKnown({ midi: 0, score: 0 }),
      ).then((p) => put('notation', p));
      void probe<TrackMenuLyricsDoc>(`/api/lyrics/${enc}`, signal,
        (b) => {
          const doc = (b as Json)?.doc as Json | undefined;
          return {
            text: typeof doc?.text === 'string' ? doc.text : '',
            timed: asList(doc?.lines).some((l) => l.kind === 'lyric' && typeof l.start_ms === 'number'),
          };
        },
        () => probeKnown({ text: '', timed: false }),
      ).then((p) => put('lyricsDoc', p));
      void probeExists(`/api/vocal/metadata/${enc}`, signal).then((p) => put('vocalNotes', p));
      void probe(`/api/stems/${enc}/progress`, signal,
        (b) => !STEMS_AT_REST.has(String((b as Json)?.phase ?? 'idle')),
        () => probeKnown(false),
      ).then((p) => put('runningStems', p));
      void probe(`/api/rhythm/${enc}`, signal, (b) => (b as Json)?.status === 'ready', () => probeKnown(false))
        .then((p) => put('rhythmReady', p));
      void probe<string | null>(`/api/library/entries/${enc}/path`, signal,
        (b) => {
          const path = (b as Json)?.path;
          return typeof path === 'string' && path ? path : null;
        },
        // FastAPI's own 404 for a route it does not have: a backend started
        // before the path route existed.
        (b) => ((b as Json)?.detail === 'Not Found' ? probeFailed(REASON.pathRouteMissing) : probeKnown(null)),
      ).then((p) => put('audioPath', p));
    }
    return () => ctl.abort();
    // probeKey carries kind and entry id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, probeKey]);

  const probes = probeState?.key === probeKey ? probeState.probes : entry ? checkingProbes() : entrylessProbes();

  // Nothing is built while the menu is closed; the footer renders it on every
  // player change.
  const facts: TrackMenuFacts | null = useMemo(() => {
    if (!open) return null;
    const free = Array.from({ length: 10 }, (_, i) => i).find((i) => !pads[i]);
    const active = activeSetId ? setlists[activeSetId] : null;
    const vocalJobId = entry ? vocalJobs[entry.id] ?? null : null;
    const stemsRun = probes.runningStems;
    const runningJob: Probe<TrackMenuRunningJob> =
      stemsRun.state === 'known'
        ? probeKnown({ stems: stemsRun.value, vocalJobId })
        : vocalJobId
          ? probeKnown({ stems: false, vocalJobId })
          : stemsRun.state === 'checking'
            ? probeChecking()
            : probeFailed(stemsRun.detail);
    return {
      kind,
      label,
      entry: entry
        ? {
            id: entry.id,
            title: entry.title,
            kind: entry.kind ?? 'audio',
            model: entry.model,
            prompt: (entry.prompt ?? '').trim(),
            style: deriveStyle(entry).trim(),
            lyrics: deriveLyrics(entry).trim(),
            favorite: entry.favorite,
            rating: entry.rating,
            analyzed: !!entry.analysis && Object.keys(entry.analysis).length > 0,
          }
        : null,
      hasBytes: kind === 'library' || !!getLoadedAudioUrl(),
      stems: probes.stems,
      wholeMidi: probes.wholeMidi,
      notation: probes.notation,
      lyricsDoc: probes.lyricsDoc,
      vocalNotes: probes.vocalNotes,
      rhythmReady: probes.rhythmReady,
      audioPath: probes.audioPath,
      convertFormats: probes.convertFormats,
      runningJob,
      localClient: isLocalClient(),
      clipboard: typeof navigator !== 'undefined' && !!navigator.clipboard?.writeText,
      inCrate: !!entry && crate.includes(entry.id),
      inDjNext: !!entry && djNext.some((it) => it.entryId === entry.id),
      freeSamplerPad: free ?? null,
      activeSet: active ? { id: active.id, name: active.name } : null,
    };
    // currentLabel and currentEntryId re-run this when the player changes what
    // getLoadedAudioUrl() answers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, label, entry, open, probes, crate, djNext, pads, activeSetId, setlists, vocalJobs, currentLabel, currentEntryId]);

  const groups = useMemo(() => (facts ? buildTrackMenu(facts) : []), [facts]);
  const layout = useMemo(
    () =>
      packTrackMenuColumns(groups, {
        maxColumns: trackMenuMaxColumns(space.width),
        columnHeightPx: trackMenuColumnHeight(space.height),
      }),
    [groups, space],
  );
  const rowsById = useMemo(() => new Map(allTrackMenuRows(groups).map((r) => [r.id, r])), [groups]);
  const pointed = pointedId ? rowsById.get(pointedId) ?? null : null;

  // A resize that packs the groups into other columns remounts the column
  // boxes, and the focused row with them, which drops focus to <body>. The
  // same row takes focus back. A row a probe replaced (the Stems placeholder
  // becoming one line per stem) hands focus back to the end of its group the
  // user was at, so the row after the placeholder is not the group's first when
  // the user had arrowed to its last.
  useLayoutEffect(() => {
    if (!open) return;
    const mark = markRef.current;
    const active = document.activeElement;
    if (!mark || (active && active !== document.body)) return;
    const menu = document.getElementById(MENU_ID);
    if (!menu) return;
    restoreTarget(menu, mark)?.focus({ preventScroll: true });
  }, [open, layout]);

  // DockFlyout puts focus on the first row once the card is placed; a menu
  // opened with ArrowUp moves it on to the last row after that. This runs again
  // on every layout, so the probe that turns the Stems placeholder into a line
  // per stem — every one of them below the row that was last — moves the intent
  // on to the row that is last now. It holds until the user moves focus (any
  // key, or the pointer over a row), which is what clears focusLastRef.
  useEffect(() => {
    if (!open || !focusLastRef.current) return;
    let raf = 0;
    let frames = 0;
    const tick = () => {
      if (!focusLastRef.current) return;
      const menu = document.getElementById(MENU_ID);
      const last = menu ? lastMenuItem(menu) : null;
      if (menu && last && menu.contains(document.activeElement)) {
        if (document.activeElement !== last) last.focus();
        return;
      }
      frames += 1;
      if (frames < 30) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [open, layout]);

  const choose = (row: TrackMenuRow) => {
    if (!row.enabled) return;
    const subject: TrackMenuSubject = { kind, label, entry, loadedUrl: kind === 'library' ? null : getLoadedAudioUrl() };
    const ctx: TrackMenuActionContext = {
      audioPath: probes.audioPath.state === 'known' ? probes.audioPath.value : null,
      stems: probes.stems.state === 'known' ? probes.stems.value : [],
      lyricsText: probes.lyricsDoc.state === 'known' ? probes.lyricsDoc.value.text : '',
      runningJob: facts?.runningJob.state === 'known' ? facts.runningJob.value : { stems: false, vocalJobId: null },
      openLineage: (id: string) => setLineageId(id),
      openMetaEditor: (e: LibraryEntry) => setMetaEntry(e),
    };
    close();
    if (row.id === 'load-lyrics') {
      // The picker opens inside this click; its answer runs the row.
      pendingLyricsRef.current = { row, subject, ctx };
      const input = lyricsInputRef.current;
      if (input) {
        input.value = '';
        input.click();
      }
      return;
    }
    if (row.id === 'run-stems' || row.id === 'edit-stems') {
      setStemsAsk({ row, subject, ctx });
      return;
    }
    runRow({ row, subject, ctx });
  };

  const confirmStems = (opts: StemsRunOptions) => {
    const ask = stemsAsk;
    setStemsAsk(null);
    keyRef.current?.focus();
    if (!ask) return;
    if (opts.persistAsDefault) {
      void useFeatureToggleStore.getState().patch({
        stems: { default_count: opts.stems, device: opts.device, quality: opts.quality },
      });
    }
    runRow({ ...ask, ctx: { ...ask.ctx, stemOptions: { stems: opts.stems, device: opts.device, quality: opts.quality } } });
  };

  const onMenuKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    // Escape and Tab belong to DockFlyout's window listener.
    if (e.key === 'Escape' || e.key === 'Tab') return;
    // Every other key stops here, modified or not: the app's window hotkeys
    // (EDIT's Delete, Backspace, Ctrl+Z, Ctrl+A) would act behind the menu.
    e.stopPropagation();
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    // From here the user is steering, so the open-at-the-last-row intent ends
    // and a later probe no longer moves focus out from under them.
    takeFocus();
    const root = e.currentTarget;
    const items = itemsIn(root);
    if (items.length === 0) return;
    const active = document.activeElement as HTMLElement | null;
    const at = active ? items.indexOf(active) : -1;
    let next: HTMLElement | null = null;
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp':
      case 'Home':
      case 'End':
        next = items[rovingIndex(at, items.length, e.key as MenuKey)] ?? null;
        break;
      case 'ArrowRight':
      case 'ArrowLeft':
        next = active && at >= 0 ? acrossColumns(active, e.key === 'ArrowRight' ? 1 : -1, root) : items[0];
        break;
      case 'Enter':
      case ' ':
        // The focused row's own click runs.
        return;
      default: {
        if (e.key.length !== 1 || !/\S/.test(e.key)) return;
        const letter = e.key.toLowerCase();
        for (let step = 1; step <= items.length; step += 1) {
          const candidate = items[(Math.max(at, -1) + step) % items.length];
          if ((candidate.dataset.label ?? '').toLowerCase().startsWith(letter)) {
            next = candidate;
            break;
          }
        }
      }
    }
    e.preventDefault();
    if (next) {
      next.focus();
      next.scrollIntoView({ block: 'nearest' });
    }
  };

  const renderRow = (row: TrackMenuRow) => {
    const Icon = ICONS[row.icon];
    const extras = spokenExtras(row);
    const common = {
      type: 'button' as const,
      role: 'menuitem',
      tabIndex: -1,
      'aria-disabled': row.enabled ? undefined : true,
      'aria-label': row.line || extras ? [row.label, extras].filter(Boolean).join(', ') : undefined,
      title: row.title,
      'data-label': row.label,
      'data-row-id': row.id,
      onClick: () => choose(row),
      onFocus: (e: React.FocusEvent<HTMLButtonElement>) => {
        setPointedId(row.id);
        markRef.current = markOf(e.currentTarget);
      },
      onMouseEnter: () => {
        takeFocus();
        setPointedId(row.id);
      },
    };
    const iconTone = row.enabled
      ? 'et-ink-2 group-hover/row:text-[rgb(var(--et-accent))] group-focus/row:text-[rgb(var(--et-accent))]'
      : 'et-ink-2';
    if (row.chip) {
      return (
        <button key={row.id} {...common} className={`${CHIP} ${row.enabled ? ROW_LIVE : ROW_OFF}`}>
          <span>{row.label}</span>
        </button>
      );
    }
    if (row.line) {
      return (
        <button key={row.id} {...common} className={`${KEY} ${row.enabled ? ROW_LIVE : ROW_OFF}`}>
          <Icon aria-hidden="true" className={`w-3.5 h-3.5 shrink-0 ${iconTone}`} />
        </button>
      );
    }
    return (
      <button key={row.id} {...common} className={`${ROW} ${row.enabled ? ROW_LIVE : ROW_OFF}`}>
        <Icon aria-hidden="true" className={`w-3.5 h-3.5 shrink-0 ${iconTone}`} />
        <span className="flex-1 min-w-0 truncate">{row.label}</span>
        {row.longJob && <span aria-hidden="true" className={row.enabled ? LEGEND : ROW_LEGEND_OFF}>JOB</span>}
      </button>
    );
  };

  const renderGroup = (group: TrackMenuGroup) => {
    const chips = group.rows.filter((r) => r.chip);
    const rows = group.rows.filter((r) => !r.chip && !r.line);
    const lines: Array<{ key: string; label: string; rows: TrackMenuRow[] }> = [];
    for (const r of group.rows) {
      if (!r.line) continue;
      const line = lines.find((l) => l.key === r.line?.key);
      if (line) line.rows.push(r);
      else lines.push({ key: r.line.key, label: r.line.label, rows: [r] });
    }
    return (
      <div
        key={group.id}
        role="group"
        data-group-id={group.id}
        aria-label={group.longJob ? `${group.label}, each starts a backend job` : group.label}
        className="flex flex-col"
      >
        <div aria-hidden="true" className="h-6 flex items-center gap-2 px-2 font-display text-xs font-bold uppercase tracking-wider et-ink-2">
          <span className="flex-1 min-w-0 truncate">{group.label}</span>
          {group.longJob && <span className={LEGEND}>JOB</span>}
        </div>
        {rows.map(renderRow)}
        {lines.map((line) => (
          <div key={`line:${line.key}`} role="none" className="h-6 flex items-center gap-1 pl-2">
            <span aria-hidden="true" title={line.label} className="flex-1 min-w-0 truncate text-xs font-semibold et-ink">
              {line.label}
            </span>
            {line.rows.map(renderRow)}
          </div>
        ))}
        {chips.length > 0 && (
          <div role="none" className="grid grid-cols-3 gap-1 px-2 pb-1">
            {chips.map(renderRow)}
          </div>
        )}
      </div>
    );
  };

  return (
    <>
      <button
        ref={keyRef}
        type="button"
        onClick={toggle}
        onKeyDown={(e) => {
          if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
            e.preventDefault();
            // The card mounts and DockFlyout adds its window key listener
            // while this keydown is still dispatching; stopped here, the same
            // press does not also move the focus the card just placed.
            e.stopPropagation();
            measure();
            focusLastRef.current = e.key === 'ArrowUp';
            setOpen(true);
          }
        }}
        aria-label="More options"
        title="More options: everything you can do with this track"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={MENU_ID}
        className={buttonClassName}
      >
        <MoreHorizontal aria-hidden="true" className="w-4 h-4" />
      </button>

      {/* Load lyrics opens this picker from the row's click. */}
      <label htmlFor={LYRICS_INPUT_ID} className="sr-only">Lyrics file (.lrc or .txt) to load into this track</label>
      <input
        ref={lyricsInputRef}
        id={LYRICS_INPUT_ID}
        name={LYRICS_INPUT_ID}
        type="file"
        accept=".lrc,.txt,text/plain"
        tabIndex={-1}
        className="sr-only"
        onChange={(e) => {
          const file = e.target.files?.[0];
          const pending = pendingLyricsRef.current;
          pendingLyricsRef.current = null;
          if (!file || !pending) return;
          runRow({ ...pending, ctx: { ...pending.ctx, lyricsFile: file } });
        }}
      />

      {/* The theme host: a transparent full-viewport layer that carries the
          theme's variables and ink remaps, and lets the pointer through. It
          stacks over the assistant orb (9999) and the onboarding notes (1000),
          so an open menu is never under either. Its key scope keeps scoped
          window hotkeys off while the pointer or the focus is in the card. */}
      {typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={setHost}
            data-track-menu-host=""
            data-keyscope="track-menu"
            className="edit-theme-scope fixed inset-0 z-10000 pointer-events-none"
            data-et-light={theme.light ? '1' : undefined}
            style={{ ...(theme.vars as React.CSSProperties), background: 'transparent' }}
          />,
          document.body,
        )}

      <DockFlyout
        open={open}
        anchorRef={keyRef}
        onClose={close}
        placement="above"
        align="end"
        id={MENU_ID}
        role="menu"
        aria-label={label ? `Track menu for ${label}` : 'Track menu'}
        portalInto={host}
        className={`${FLYOUT_CARD} pointer-events-auto`}
      >
        <div
          role="none"
          className="flex flex-col min-h-0"
          style={{ maxHeight: space.height }}
          onKeyDown={onMenuKey}
          onMouseLeave={(e) => {
            // The status line goes back to the focused row, when focus is in the card.
            const active = document.activeElement as HTMLElement | null;
            setPointedId(active && e.currentTarget.contains(active) ? active.dataset.rowId ?? null : null);
          }}
        >
          <div aria-hidden="true" className="h-9 shrink-0 flex items-center gap-3 px-3 border-b border-white/10">
            <span className="flex-1 min-w-0 truncate text-sm font-bold et-ink">{label || 'No track loaded'}</span>
            <span className={`${LEGEND} uppercase`}>{KIND_LEGEND[kind]}</span>
          </div>
          <div role="none" className={`flex-1 min-h-0 flex gap-2 p-2 ${layout.fits ? '' : 'overflow-y-auto'}`}>
            {layout.columns.map((column, i) => (
              <div role="none" key={column.map((g) => g.id).join('+')} data-track-menu-column={i} className="w-62 shrink-0 flex flex-col gap-2">
                {column.map(renderGroup)}
              </div>
            ))}
          </div>
          <div aria-hidden="true" className="h-8 shrink-0 flex items-center px-3 border-t border-white/10 text-xs font-semibold et-ink-2">
            <span className="truncate">{pointed ? statusFor(pointed) : 'Arrow keys move, Enter chooses, Escape closes'}</span>
          </div>
        </div>
      </DockFlyout>

      {lineageId && (
        <Suspense fallback={null}>
          <LineageModal open rootEntryId={lineageId} onClose={() => setLineageId(null)} />
        </Suspense>
      )}
      {metaEntry && host && (
        <TrackMetaDialog
          entry={metaEntry}
          host={host}
          onClose={() => {
            setMetaEntry(null);
            keyRef.current?.focus();
          }}
        />
      )}
      {stemsAsk && host &&
        createPortal(
          <StemsRunModal
            open
            entryLabel={stemsAsk.subject.entry?.title ?? stemsAsk.subject.label}
            onCancel={() => {
              setStemsAsk(null);
              keyRef.current?.focus();
            }}
            onConfirm={confirmStems}
          />,
          host,
        )}
    </>
  );
};
