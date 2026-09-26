import { useEffect, useRef, useState } from 'react';
import { measureCanvasBox } from '../../lib/canvasScale';
import {
  EMPTY_BINS,
  analyzeBufferAsync,
  decodeAudio,
  drawWaveformCached,
  type WaveBin,
} from './djSemanticWaveformAnalysis';

/** Round a measured lane width UP to a 64 px bucket, so a one-pixel layout
 *  wobble never changes the analysis bin count (and so re-mounting a lane at
 *  a near-identical width still hits the analysis memo). */
function widthBucket(px: number): number {
  if (!Number.isFinite(px) || px <= 0) return 0;
  return Math.ceil(px / 64) * 64;
}

export function DJSemanticWaveform({
  audioUrl,
  height = 64,
  viewportStart = 0,
  viewportEnd = 1,
  onDuration,
  transparentBg = false,
  normalize = true,
  width,
}: {
  audioUrl: string;
  height?: number;
  viewportStart?: number;
  viewportEnd?: number;
  /** Fires once the audio decodes, reporting its length in seconds. */
  onDuration?: (seconds: number) => void;
  /** Skip the opaque canvas background so a caller's own background shows through. */
  transparentBg?: boolean;
  /** `true` (default, unchanged): rescale peaks to this track's own loudest
   *  sample — the DJ decks' behaviour, so two tracks of different mastering
   *  loudness still fill the same visual height. `false`: absolute amplitude,
   *  clamped but never rescaled — REAPER's default, and what the EDIT
   *  timeline wants (see `analyzeBuffer`'s `AnalyzeOptions`). */
  normalize?: boolean;
  /** Lane width in CSS px, if the caller already knows it. Decides how many
   *  analysis bins this instance asks for: the overview lanes are 34-44 px
   *  and used to compute the full 6,400 bins anyway. Omitted, the wrapper is
   *  measured instead, so no call site has to change. */
  width?: number;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [bins, setBins] = useState<WaveBin[]>(EMPTY_BINS);
  const [decodeError, setDecodeError] = useState<string | null>(null);
  // The decoded buffer, held so flipping `normalize` can re-analyze the SAME
  // decode instead of re-fetching + re-decoding the file (audit follow-up #5
  // — a fetch+decode is a real network round trip and a real
  // decodeAudioData, not something to redo over a scaling option). This has
  // to be reactive STATE, not a plain ref: the analysis effect below is
  // keyed on it, and a ref's mutations do not retrigger an effect — only a
  // state change does. `bufferAudioUrlRef` guards the one thing a ref IS
  // right for: an in-flight decode for a STALE audioUrl resolving after a
  // newer one has already started must not write over it.
  const [buffer, setBuffer] = useState<AudioBuffer | null>(null);
  const bufferAudioUrlRef = useRef<string | null>(null);

  // The measured lane width, bucketed, as STATE — refreshed by the draw
  // effect's ResizeObserver below. It has to be state rather than a value
  // sampled once inside the analysis effect: a lane that is hidden, or simply
  // not laid out yet when the audio finishes decoding, measures 0, analyses at
  // the full 6,400-bin cap, and would never re-analyse when it was shown or
  // resized. 0 means "not measured", which keeps the historical cap.
  const [laneWidth, setLaneWidth] = useState(0);

  // Fetch + decode — keyed ONLY on `audioUrl`. `normalize` never appears
  // here, which is the whole point of the split.
  //
  // DJ-2: this goes through the DJ-wide decode cache (`lib/djAudioCache`), so
  // the deck's two waveform instances and the engine share ONE fetch and ONE
  // decode per URL. There is deliberately no `AbortController` any more — the
  // request is shared, so an unmounting instance must not cancel the download
  // the others are waiting on; a stale result is dropped here instead.
  useEffect(() => {
    let cancelled = false;
    setBuffer(null);
    setDecodeError(null);
    decodeAudio(audioUrl)
      .then((decoded) => {
        if (cancelled) return;
        bufferAudioUrlRef.current = audioUrl;
        setBuffer(decoded);
        onDuration?.(decoded.duration);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setBuffer(null);
        setDecodeError(err instanceof Error ? err.message : 'Unable to decode audio waveform');
      });
    return () => {
      cancelled = true;
    };
    // onDuration intentionally omitted — a fresh closure each render must not re-decode.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioUrl]);

  // Analyze — keyed on the decoded buffer AND `normalize` (this pair is the
  // analysis result's real cache key; see `buffer`'s own doc above for why
  // `audioUrl` is deliberately NOT repeated here). Runs again whenever either
  // changes, but a `normalize` flip alone never touches the effect above.
  //
  // DJ-2: `analyzeBufferAsync` memoises per (url, normalize, binCount) and
  // runs the loop in a Worker where one exists, so the SECOND instance for a
  // deck costs nothing and the first one no longer blocks the main thread for
  // 0.6-2 s. The lane is measured (not a prop) so no call site had to change.
  useEffect(() => {
    if (!buffer || bufferAudioUrlRef.current !== audioUrl) {
      setBins(EMPTY_BINS);
      return;
    }
    let cancelled = false;
    const lane = width ?? laneWidth;
    analyzeBufferAsync(audioUrl, buffer, { normalize, width: lane })
      .then((result) => {
        if (!cancelled) setBins(result);
      })
      .catch(() => {
        if (!cancelled) setBins(EMPTY_BINS);
      });
    return () => {
      cancelled = true;
    };
  }, [buffer, normalize, audioUrl, width, laneWidth]);

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const render = () => {
      // Publish the measured lane width for the analysis effect. Bucketed, so
      // a sub-64px layout wobble cannot thrash the analysis, and compared
      // before setting, so this never loops.
      setLaneWidth((prev) => {
        const next = widthBucket(wrap.clientWidth);
        return prev === next ? prev : next;
      });
      // `height` is the wrapper's inline height, already in local css px, so it
      // is passed straight through; only the width needs the zoom correction.
      const box = measureCanvasBox(wrap, { cssHeight: height });
      // DJ-2: a playing deck moves its viewport ~6x/s. `drawWaveformCached`
      // renders the body once per (track, zoom, size) and blits a different
      // slice of it as the viewport moves; the full view still goes straight
      // through to the unchanged `drawWaveform`.
      drawWaveformCached(
        canvas,
        box,
        bins,
        viewportStart,
        viewportEnd,
        transparentBg,
        decodeError,
        `${audioUrl}|${normalize ? 'n' : 'a'}`,
      );
    };
    render();
    const ro = new ResizeObserver(render);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [bins, height, viewportEnd, viewportStart, transparentBg, decodeError, audioUrl, normalize]);

  return (
    <div
      ref={wrapRef}
      className="relative h-full w-full min-w-0 overflow-hidden rounded"
      style={{ height, background: transparentBg ? 'transparent' : '#06070d' }}
      role={decodeError ? 'img' : undefined}
      aria-label={decodeError ? `Waveform unavailable: ${decodeError}` : undefined}
    >
      <canvas ref={canvasRef} className="absolute inset-0 block h-full w-full" />
      {decodeError && (
        // A decode failure that happens after mount (the canvas was already
        // painted, or the wrapper is off-screen) must still be announced to
        // screen readers, not just exposed via the static aria-label above —
        // a visually-hidden live region fires even without focus moving.
        <span role="status" className="sr-only">
          Waveform unavailable: {decodeError}
        </span>
      )}
    </div>
  );
}
