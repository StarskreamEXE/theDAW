import React from 'react';
import { Loader2, Piano, TriangleAlert } from 'lucide-react';
import { useSoundfontStore, ensureSoundfontReady } from '../../lib/soundfontEngine';
import { GM_NAMES } from '../../lib/gmInstruments';
import { SYNTH_VOICES } from '../../lib/synthVoices';
import { DOCK_SELECT } from './midiDockKit';

const VOICE_GROUPS = Array.from(new Set(SYNTH_VOICES.map((v) => v.group)));

/**
 * Single dropdown that picks the MIDI voice: the built-in sawtooth ("Basic") or
 * a General MIDI soundfont program. Drives the shared soundfont store, so the
 * choice applies to live preview, playback, and offline WAV bounce alike.
 *
 * `idPrefix` exists because the id used to be hardcoded `pr-instrument`: any
 * second mount (a picker open beside the Piano Roll) produced two elements with
 * the same id and a <label htmlFor> that named whichever came first. Callers
 * that can co-exist with the roll pass their own prefix.
 *
 * `compact` is the MIDI dock strip's form: a piano glyph in place of the visible
 * word, a narrow select, and the loading / failure notes as glyphs whose text is
 * in their title and in a screen-reader-only span.
 */
export const InstrumentPicker: React.FC<{ idPrefix?: string; compact?: boolean }> = ({
  idPrefix = 'pr-instrument',
  compact = false,
}) => {
  const useSoundfont = useSoundfontStore((s) => s.useSoundfont);
  const activeProgram = useSoundfontStore((s) => s.activeProgram);
  const activeSynthVoice = useSoundfontStore((s) => s.activeSynthVoice);
  const loading = useSoundfontStore((s) => s.loading);
  const loadError = useSoundfontStore((s) => s.loadError);
  const setUseSoundfont = useSoundfontStore((s) => s.setUseSoundfont);
  const setActiveProgram = useSoundfontStore((s) => s.setActiveProgram);
  const setActiveSynthVoice = useSoundfontStore((s) => s.setActiveSynthVoice);

  const value = activeSynthVoice ? `v:${activeSynthVoice}` : useSoundfont ? String(activeProgram) : 'basic';

  const onChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const v = e.target.value;
    if (v === 'basic') {
      setUseSoundfont(false);
      setActiveSynthVoice(null);
      return;
    }
    if (v.startsWith('v:')) {
      setActiveSynthVoice(v.slice(2)); // procedural EDM voice (clears soundfont)
      return;
    }
    setActiveProgram(Number(v));
    setUseSoundfont(true); // clears any synth voice
    void ensureSoundfontReady(); // warm the worklet + soundfont while the user looks
  };

  const options = (
    <>
      <option value="basic">Basic (sawtooth)</option>
      {VOICE_GROUPS.map((g) => (
        <optgroup key={g} label={`Synth · ${g}`}>
          {SYNTH_VOICES.filter((vv) => vv.group === g).map((vv) => (
            <option key={vv.id} value={`v:${vv.id}`}>{vv.name}</option>
          ))}
        </optgroup>
      ))}
      <optgroup label="General MIDI">
        {GM_NAMES.map((n, i) => (
          <option key={n} value={i}>{`${i + 1}. ${n}`}</option>
        ))}
      </optgroup>
    </>
  );

  if (compact) {
    return (
      <div className="flex items-center gap-1 shrink-0" title="Instrument">
        <label htmlFor={idPrefix} className="sr-only">
          Instrument
        </label>
        <Piano aria-hidden="true" className="w-3 h-3 shrink-0 et-ink-3" />
        <select
          id={idPrefix}
          name={idPrefix}
          aria-label="MIDI instrument"
          value={value}
          onChange={onChange}
          className={`${DOCK_SELECT} w-40`}
        >
          {options}
        </select>
        {loading && (
          <span className="flex et-ink-3" title="Loading the soundfont">
            <Loader2 aria-hidden="true" className="w-3 h-3 animate-spin" />
            <span className="sr-only">loading…</span>
          </span>
        )}
        {loadError && (
          <span className="flex text-red-300" title={`Soundfont failed: ${loadError}`}>
            <TriangleAlert aria-hidden="true" className="w-3 h-3" />
            <span className="sr-only">soundfont failed</span>
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1.5">
      <label htmlFor={idPrefix} className="text-xs text-white/50">
        Instrument
      </label>
      <select
        id={idPrefix}
        name={idPrefix}
        aria-label="MIDI instrument"
        value={value}
        onChange={onChange}
        className="form-select px-2 py-1 text-xs max-w-44"
        style={{ colorScheme: 'dark' }}
      >
        {options}
      </select>
      {loading && <span className="text-xs text-white/40">loading…</span>}
      {loadError && (
        <span className="text-xs text-red-300" title={loadError}>
          soundfont failed
        </span>
      )}
    </div>
  );
};
