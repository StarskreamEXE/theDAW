import { useEffect, useRef, useState } from 'react';
import { measureCanvasBox } from '../../lib/canvasScale';
import { EMPTY_BINS, analyzeBuffer, decodeAudio, drawWaveform, type WaveBin } from './djSemanticWaveformAnalysis';

export function DJSemanticWaveform({
  audioUrl,
  height = 64,
  viewportStart = 0,
  viewportEnd = 1,
  onDuration,
  transparentBg = false,
  normalize = true,
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
  // newer one has already started must not write over it, even though the
  // AbortController below already covers the same race for `fetch` itself.
  const [buffer, setBuffer] = useState<AudioBuffer | null>(null);
  const bufferAudioUrlRef = useRef<string | null>(null);

  // Fetch + decode — keyed ONLY on `audioUrl`. `normalize` never appears
  // here, which is the whole point of the split.
  useEffect(() => {
    const ctrl = new AbortController();
    setBuffer(null);
    setDecodeError(null);
    decodeAudio(audioUrl, ctrl.signal)
      .then((decoded) => {
        if (ctrl.signal.aborted) return;
        bufferAudioUrlRef.current = audioUrl;
        setBuffer(decoded);
        onDuration?.(decoded.duration);
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        setBuffer(null);
        setDecodeError(err instanceof Error ? err.message : 'Unable to decode audio waveform');
      });
    return () => ctrl.abort();
    // onDuration intentionally omitted — a fresh closure each render must not re-decode.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioUrl]);

  // Analyze — keyed on the decoded buffer AND `normalize` (this pair is the
  // analysis result's real cache key; see `buffer`'s own doc above for why
  // `audioUrl` is deliberately NOT repeated here). Runs again whenever either
  // changes, but a `normalize` flip alone never touches the effect above.
  useEffect(() => {
    if (!buffer || bufferAudioUrlRef.current !== audioUrl) {
      setBins(EMPTY_BINS);
      return;
    }
    setBins(analyzeBuffer(buffer, { normalize }));
  }, [buffer, normalize, audioUrl]);

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const render = () => {
      // `height` is the wrapper's inline height, already in local css px, so it
      // is passed straight through; only the width needs the zoom correction.
      const box = measureCanvasBox(wrap, { cssHeight: height });
      drawWaveform(canvas, box, bins, viewportStart, viewportEnd, transparentBg, decodeError);
    };
    render();
    const ro = new ResizeObserver(render);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [bins, height, viewportEnd, viewportStart, transparentBg, decodeError]);

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
