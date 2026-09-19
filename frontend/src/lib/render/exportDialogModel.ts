/**
 * exportDialogModel — the export dialog's pure request builder.
 *
 * The dialog asks five questions: WHAT to bounce (the mix, one stem per
 * track, or a clip selection), WHEN in time (the whole project, the current
 * timeline selection, or a hand-typed range), WHICH format, WHERE it lands
 * (the library, a download, or both), and a name plus the tail length. This
 * module turns those five answers into the exact `BounceRequest` /
 * `RenderRange` pairs the engine will run — nothing about React, the DOM, or
 * the Zustand stores, so the whole suite runs under plain tsx and the
 * dialog, the preflight and the job builder can all share one model.
 *
 * Only two formats exist because `encodeBounce` (renderCore.ts) is the whole
 * encoder the app has: `encodeWav(buffer, { float32 })`. There is no mp3,
 * flac, ogg or aiff path to encode to, and no sample-rate or bit-depth
 * control beyond that one boolean — offering one would be a control that
 * cannot work. The render itself is always 44.1 kHz stereo
 * (`BOUNCE_SAMPLE_RATE`), so that is stated to the user rather than exposed
 * as a choice (`SAMPLE_RATE_LABEL`).
 *
 * The three `ExportWhat` branches copy the fidelity flags of
 * `WaveformEditor`'s `mixdownRequest` / `stemRequest` / `selectionRequest`
 * verbatim (see renderCore.ts's header for why those three combinations and
 * no others). They are restated here as literals rather than imported from
 * `components/audio/WaveformEditor.tsx`, so this module stays free of
 * anything that drags React in behind it. `float32` is the one flag
 * `stemRequest` decides from live hosted-VST detection; there is no chain to
 * inspect from a dialog, so here it comes from the user's chosen format
 * instead.
 */
import { BOUNCE_SAMPLE_RATE, type BounceRequest } from '../renderCore';
import { MAX_TAIL_SEC, rangeFromSeconds, type RenderRange } from './renderRange';

/* ── the five answers ────────────────────────────────────────────────────── */

export type ExportWhat =
  | { kind: 'mix' }
  | { kind: 'stems'; trackIds: string[] }
  | { kind: 'clips'; clipIds: string[] };

export type ExportRangeMode = 'project' | 'selection' | 'custom';

export type ExportFormatId = 'wav16' | 'wav32';

export type ExportDestination = 'library' | 'download' | 'both';

export interface ExportDialogState {
  /** What to bounce: the whole mix, one stem per selected track, or a clip
   *  selection. */
  what: ExportWhat;
  /** Which span of time to render. */
  rangeMode: ExportRangeMode;
  /** The current timeline selection in seconds, or null when there is none.
   *  Only read when `rangeMode` is 'selection'. */
  selectionSec: { startSec: number; endSec: number } | null;
  /** The hand-typed range in seconds. Only read when `rangeMode` is
   *  'custom'. */
  customSec: { startSec: number; endSec: number };
  format: ExportFormatId;
  destination: ExportDestination;
  name: string;
  /** Extra seconds past the range for a tail to decay into. Clamped to
   *  0..MAX_TAIL_SEC before it reaches a request — the same ceiling
   *  `rangeFromSeconds` enforces. */
  tailSec: number;
}

/* ── format catalog ──────────────────────────────────────────────────────── */

export interface ExportFormat {
  id: ExportFormatId;
  label: string;
  ext: 'wav';
  mime: 'audio/wav';
  /** Mirrors `BounceRequest.float32` — the only thing that actually differs
   *  between the two, since `encodeBounce` only branches on this one flag. */
  float32: boolean;
}

/** Exactly two entries: `encodeBounce` only knows how to write a WAV, either
 *  16-bit PCM or 32-bit float. A third entry here with nothing to encode it
 *  would be a control that cannot work. */
export const EXPORT_FORMATS: ExportFormat[] = [
  { id: 'wav16', label: 'WAV · 16-bit PCM', ext: 'wav', mime: 'audio/wav', float32: false },
  { id: 'wav32', label: 'WAV · 32-bit float', ext: 'wav', mime: 'audio/wav', float32: true },
];

const FORMATS_BY_ID: Record<ExportFormatId, ExportFormat> = {
  wav16: EXPORT_FORMATS[0],
  wav32: EXPORT_FORMATS[1],
};

/** The render itself never varies: every bounce is 44.1 kHz stereo. Shown to
 *  the user as a fact, not offered as a choice with only one option. */
export const SAMPLE_RATE_LABEL = '44.1 kHz · stereo (fixed)';

/** Total over `ExportFormatId` — the union already limits callers to the two
 *  ids above, so there is no unknown-id case left to throw on. */
export function formatOf(id: ExportFormatId): ExportFormat {
  return FORMATS_BY_ID[id];
}

/* ── opening state ───────────────────────────────────────────────────────── */

/**
 * The dialog's opening state: the mix, the whole project, WAV 16-bit, both
 * destinations, no tail. `customSec` starts at the full project length so a
 * user who switches to a custom range begins from something valid rather
 * than an empty 0..0 window.
 */
export function defaultExportState(opts: {
  selectionSec?: { startSec: number; endSec: number } | null;
  projectEndSec: number;
  name?: string;
}): ExportDialogState {
  return {
    what: { kind: 'mix' },
    rangeMode: 'project',
    selectionSec: opts.selectionSec ?? null,
    customSec: { startSec: 0, endSec: opts.projectEndSec },
    format: 'wav16',
    destination: 'both',
    name: opts.name ?? 'mixdown',
    tailSec: 0,
  };
}

/* ── the render plan ─────────────────────────────────────────────────────── */

export interface ExportRenderItem {
  kind: 'mixdown' | 'stem' | 'selection';
  label: string;
  trackId?: string;
  request: BounceRequest;
  range: RenderRange | null;
  formatId: ExportFormatId;
  destination: ExportDestination;
}

export interface ExportRenderPlan {
  items: ExportRenderItem[];
  /** Set when `rangeMode` needs a range and none can be built — the chosen
   *  span is empty, or 'selection' was asked for with nothing selected.
   *  `items` is still returned (each with `range: null`) so the dialog can
   *  keep showing what WOULD render once the range is fixed. */
  rangeError: string | null;
}

const EMPTY_RANGE_ERROR = 'The chosen range is empty — set an end after the start.';

const clampTailSec = (sec: number): number => {
  if (!Number.isFinite(sec)) return 0;
  return Math.min(MAX_TAIL_SEC, Math.max(0, sec));
};

/** Appends '.wav' unless the name already ends in it (case-insensitively),
 *  so a typed "Take1.WAV" is not doubled into "Take1.WAV.wav". */
const withWavExt = (name: string): string => (/\.wav$/i.test(name) ? name : `${name}.wav`);

/**
 * Turns the dialog's five answers into the exact requests the engine runs.
 * Never throws: an unresolvable range is reported through `rangeError`
 * rather than by leaving `items` empty or raising.
 */
export function buildRenderRequest(state: ExportDialogState): ExportRenderPlan {
  const { float32 } = formatOf(state.format);
  const tailSec = clampTailSec(state.tailSec);
  const trimmedName = state.name.trim();
  const base = { sampleRate: BOUNCE_SAMPLE_RATE, float32, tailSec };

  let range: RenderRange | null = null;
  let rangeError: string | null = null;
  if (state.rangeMode === 'selection' || state.rangeMode === 'custom') {
    const sec = state.rangeMode === 'selection' ? state.selectionSec : state.customSec;
    range = sec ? rangeFromSeconds(sec.startSec, sec.endSec, { tailSec }) : null;
    if (!range) rangeError = EMPTY_RANGE_ERROR;
  }
  // 'project' covers the whole timeline: range stays null, no error.

  const { what } = state;
  const items: ExportRenderItem[] = [];

  if (what.kind === 'mix') {
    // Mirrors WaveformEditor's `mixdownRequest`: master + per-track racks,
    // automation, mute AND solo.
    const request: BounceRequest = {
      ...base,
      scope: { kind: 'master' },
      includeFx: true,
      includeAutomation: true,
      includeTrackMix: true,
    };
    items.push({
      kind: 'mixdown',
      label: withWavExt(trimmedName),
      request,
      range,
      formatId: state.format,
      destination: state.destination,
    });
  } else if (what.kind === 'stems') {
    // Mirrors `stemRequest`: the track's own rack, no automation, no track
    // mix. `float32` comes from the chosen format, not from VST detection —
    // there is no live chain to inspect from a dialog.
    for (const trackId of what.trackIds) {
      const request: BounceRequest = {
        ...base,
        scope: { kind: 'track', trackId },
        includeFx: true,
        includeAutomation: false,
        includeTrackMix: false,
      };
      items.push({
        kind: 'stem',
        label: withWavExt(`${trimmedName} — ${trackId}`),
        trackId,
        request,
        range,
        formatId: state.format,
        destination: state.destination,
      });
    }
  } else {
    // Mirrors `selectionRequest`: no inserts, no automation, but the track
    // mix applies — a selection bounce should sound like what is balanced.
    const request: BounceRequest = {
      ...base,
      scope: { kind: 'selection', clipIds: what.clipIds },
      includeFx: false,
      includeAutomation: false,
      includeTrackMix: true,
    };
    items.push({
      kind: 'selection',
      label: withWavExt(trimmedName),
      request,
      range,
      formatId: state.format,
      destination: state.destination,
    });
  }

  return { items, rangeError };
}
