/**
 * MasterTrackRow — the pinned MASTER row: a header cell (label, meter,
 * volume, mute, FX) plus a lane area, rendered above/below the scrollable
 * track list.
 *
 * This is a VIEW over the master that already exists — it creates no second
 * sum, GainNode, analyser or FX chain. Every value it shows comes from a
 * store or module that already owns it:
 *  - Volume/mute: `playbackStore` (the footer fader and the engine's master
 *    gain already read the same pair; `MixerStrips.tsx`'s master strip binds
 *    it too).
 *  - FX chains + automation lanes: `editorStore.masterFxChain` /
 *    `masterVstChain` / `automationLanes` — opening the rack itself is the
 *    caller's job via `onOpenMasterFx`, never this component's.
 *  - Metering: the same per-channel tap `MixerStrips.tsx`'s own master bar
 *    reads (`levelsStore.sampleChannelLevels()`). The master has no entry in
 *    `stripMeters`' per-strip registry — that map covers tracks and buses
 *    only, never the master.
 *
 * Because it is not one of `editorStore.tracks`, it is excluded from track
 * reorder, marquee track hits, delete, folder operations and clip drops —
 * `masterTrackRowModel`'s `isMasterRowId` / `excludeMasterRow` encode that
 * rule for every caller that iterates tracks.
 */
import React, { useEffect, useRef } from 'react';
import { SlidersHorizontal, Volume2, VolumeX } from 'lucide-react';
import { usePlaybackStore } from '../../state/playbackStore';
import { useEditorStore } from '../../state/editorStore';
import { sampleChannelLevels } from '../../state/levelsStore';
import { linearToDb } from '../../lib/assistantTools/toolTypes';
import {
  MASTER_ROW_LABEL,
  masterAutomationLanes,
  masterFxButtonLabel,
  masterFxCount,
  masterLaneLabel,
  masterVolumeAria,
  meterFillPercent,
} from './masterTrackRowModel';

export interface MasterTrackRowProps {
  headerWidthPx: number;
  heightPx: number;
  scrollLeftPx: number;
  contentWidthPx: number;
  onOpenMasterFx: () => void;
  masterFxOpen: boolean;
}

/** ARIA text refreshes a few times a second, not every frame — the same
 *  throttle `MixerStrips.tsx`'s strip meters use, for the same reason: a
 *  number no screen reader can follow at 60fps is just DOM churn. */
const ARIA_INTERVAL_MS = 250;

export const MasterTrackRow: React.FC<MasterTrackRowProps> = ({
  headerWidthPx,
  heightPx,
  scrollLeftPx,
  contentWidthPx,
  onOpenMasterFx,
  masterFxOpen,
}) => {
  const volume = usePlaybackStore((s) => s.volume);
  const setVolume = usePlaybackStore((s) => s.setVolume);
  const muted = usePlaybackStore((s) => s.muted);
  const toggleMute = usePlaybackStore((s) => s.toggleMute);

  const masterFxChain = useEditorStore((s) => s.masterFxChain);
  const masterVstChain = useEditorStore((s) => s.masterVstChain);
  const automationLanes = useEditorStore((s) => s.automationLanes);

  const fxCount = masterFxCount(masterFxChain, masterVstChain);
  const lanes = masterAutomationLanes(automationLanes);
  // Required by the prop type, but checked defensively anyway: a control
  // that cannot work must be disabled WITH a reason, never decorative, even
  // if the only way to reach that state is a caller that skipped the types.
  const fxAvailable = typeof onOpenMasterFx === 'function';

  const meterRootRef = useRef<HTMLDivElement | null>(null);
  const meterFillRef = useRef<HTMLDivElement | null>(null);

  // The master has no entry in the per-strip registry `sampleStripLevels()`
  // reports — `liveMixer`'s strip map is built from tracks + buses only, and
  // the master is deliberately not one of them. It is read from the same
  // per-channel tap `MixerStrips.tsx`'s own master bar uses instead. This row
  // does not call `ensureMeter()`/`disposeMeter()` itself — it is a passive
  // view over whatever tap is already attached, not a second holder forcing
  // the audio engine + BS.1770 worklet to spin up just because this row is
  // mounted — so the reading is "unavailable" unless the Levels tab or the
  // mixer drawer already holds it open. No React state and no store writes
  // happen per frame — the loop reads `sampleChannelLevels()` once and writes
  // the fill width and the throttled aria text straight onto the ref'd
  // elements.
  useEffect(() => {
    let raf = 0;
    let lastAria = 0;
    const frame = (now: number): void => {
      raf = requestAnimationFrame(frame);
      const fill = meterFillRef.current;
      const root = meterRootRef.current;
      if (!fill || !root) return;
      const m = sampleChannelLevels();
      if (!m) {
        fill.style.width = '0%';
        root.title = 'Master meter unavailable';
        root.setAttribute('aria-label', 'Master meter unavailable');
        return;
      }
      const rms = Math.sqrt((m.rmsL * m.rmsL + m.rmsR * m.rmsR) * 0.5);
      const pct = meterFillPercent(linearToDb(rms));
      fill.style.width = `${pct}%`;
      if (now - lastAria >= ARIA_INTERVAL_MS) {
        lastAria = now;
        root.title = 'Master level';
        root.setAttribute('aria-label', `Master level ${pct} percent`);
      }
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="flex shrink-0 border-b border-white/10" style={{ height: heightPx }}>
      <div
        className="shrink-0 flex items-center gap-1.5 px-2 overflow-hidden border-r border-white/10 bg-black/30"
        style={{ width: headerWidthPx }}
      >
        <span className="shrink-0 font-display text-xs font-bold uppercase tracking-wider text-zinc-300">
          {MASTER_ROW_LABEL}
        </span>

        <div
          ref={meterRootRef}
          role="img"
          aria-label="Master level"
          title="Master level"
          className="relative h-1 w-10 shrink-0 overflow-hidden rounded-xs bg-white/10"
        >
          <div ref={meterFillRef} className="absolute inset-y-0 left-0 bg-red-500/60" style={{ width: '0%' }} />
        </div>

        <label htmlFor="master-track-volume" className="sr-only">
          Volume
        </label>
        <input
          id="master-track-volume"
          name="master-track-volume"
          type="range"
          min={0}
          max={100}
          step={1}
          value={volume}
          aria-valuetext={masterVolumeAria(volume, muted)}
          onChange={(e) => setVolume(Number(e.target.value))}
          className="w-12 shrink-0 accent-purple-500"
        />

        <button
          type="button"
          onClick={toggleMute}
          aria-pressed={muted}
          aria-label="Mute master"
          title={muted ? 'Unmute master' : 'Mute master'}
          className={`shrink-0 grid place-items-center h-6 w-6 rounded border ${
            muted
              ? 'bg-red-500/20 border-red-500/50 text-red-400'
              : 'border-white/10 text-zinc-500 hover:text-white hover:bg-white/5'
          }`}
        >
          {muted ? <VolumeX className="w-3 h-3" /> : <Volume2 className="w-3 h-3" />}
        </button>

        <button
          type="button"
          onClick={fxAvailable ? onOpenMasterFx : undefined}
          disabled={!fxAvailable}
          aria-pressed={masterFxOpen}
          aria-label={masterFxButtonLabel(fxCount)}
          title={fxAvailable ? 'Master FX' : 'Master FX rack unavailable'}
          className={`shrink-0 flex items-center gap-1 px-1.5 h-6 rounded border font-display text-xs font-bold uppercase tracking-wider disabled:opacity-30 ${
            masterFxOpen
              ? 'bg-purple-600/20 border-purple-500/40 text-purple-300'
              : 'border-white/10 text-zinc-500 hover:text-white hover:bg-white/5'
          }`}
        >
          <SlidersHorizontal className="w-3 h-3" />
          FX {fxCount}
        </button>
      </div>

      <div className="flex-1 min-w-0 overflow-hidden relative">
        <div
          className="absolute inset-y-0 left-0"
          style={{ transform: `translateX(${-scrollLeftPx}px)`, width: contentWidthPx }}
        >
          {/* Grid backdrop only: the timeline owns bar/beat gridline math and
              paints it elsewhere. This carries the same dark surface a normal
              track lane sits on so that grid reads through behind it; no
              gridline math is duplicated here. */}
          <div className="absolute inset-0 bg-black/20" aria-hidden="true" />

          {lanes.length > 0 && (
            <div className="relative flex flex-col">
              {lanes.map((lane) => (
                <div
                  key={lane.id}
                  className="h-4 border-b border-white/5 px-1 text-xs leading-4 font-mono text-zinc-500 truncate"
                >
                  {masterLaneLabel(lane.target)}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
