/**
 * ArpeggiatorPanel — the chord-progression arpeggiator UI (the MIDI tab's
 * alternate face, shown when the roll's "Arp" toggle is on). A faithful React
 * rebuild of Jake Albaugh's arpeggiator layout (keyboard strip, chord
 * progression grid, key/mode/steps/type/style selectors, live output) rehosted
 * on the app's Web Audio synth via `ArpPlayerEngine`. The current progression
 * can be dumped into the piano roll's note model with one click. The MIDI
 * strip's PLAY key starts and stops it through `playing`.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Piano, Music4 } from 'lucide-react';
import {
  ArpPlayerEngine,
  DEFAULT_ARP_CONFIG,
  noteNameToMidi,
  type ArpConfig,
  type PatternType,
} from '../../lib/arpEngine';
import { getEngineCtx } from '../../state/playerStore';
import { usePianoRollStore, type PianoNote } from '../../state/pianoRollStore';
import { playedRollBends } from '../../lib/pitchBend';
import { InstrumentPicker } from './InstrumentPicker';
import { KEY_ON, KEY_REST, StripKey } from './midiDockKit';

const KEYS = 'C C# D D# E F F# G G# A A# B'.split(' ');
const OCTAVES = [2, 3, 4, 5, 6, 7];
const MODES = ['ionian', 'dorian', 'phrygian', 'lydian', 'mixolydian', 'aeolian', 'locrian', 'major', 'minor', 'melodic', 'harmonic'];
const INTERVALS = 'i ii iii iv v vi vii'.split(' ');
const STEP_OPTS = [3, 4, 5, 6];
const BPM_MIN = 20;
const BPM_MAX = 300;
/** Center column px for the full chord-progression keys: 39 of section chrome, 7 keys of 24 with 6 gaps of 4, an 8 gap, 65 of output. */
const PROGRESSION_FULL_PX = 304;

/** Tiny polyline thumbnail of one arpeggio index pattern (port of _genPatternSvg). */
const PatternSvg: React.FC<{ pattern: number[] }> = ({ pattern }) => {
  const spacing = 2;
  const hi = Math.max(...pattern);
  const width = pattern.length * spacing + spacing;
  const height = hi + spacing * 2;
  let x = spacing;
  const pts = pattern.map((p) => {
    const y = height - p - spacing;
    const point = `${x},${y}`;
    x += spacing;
    return point;
  });
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-auto pointer-events-none" aria-hidden="true">
      <polyline points={pts.join(' ')} fill="none" stroke="currentColor" strokeWidth={0.6} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
};

const Section: React.FC<{ title: string; tip?: string; className?: string; children: React.ReactNode }> = ({ title, tip, className, children }) => (
  <section className={`rounded-md border border-white/10 bg-black/30 p-2 ${className ?? ''}`}>
    <h3 className="text-[10px] font-mono font-bold uppercase tracking-[0.15em] et-ink-3 mb-1.5" title={tip}>{title}</h3>
    {children}
  </section>
);

// The MIDI dock's key grammar (midiDockKit): a chosen cell takes the theme
// accent and its bottom edge, every other cell rests.
const cellEdge = 'border-b transition-[color,box-shadow,border-color] duration-100 active:shadow-[inset_0_1px_2px_rgba(0,0,0,0.7)]';
const cellBase = `text-[11px] font-mono font-semibold uppercase tracking-wide rounded-xs ${cellEdge} cursor-pointer select-none`;
const cellOn = KEY_ON;
const cellOff = KEY_REST;

export const ArpeggiatorPanel: React.FC<{ playing: boolean }> = ({ playing }) => {
  const engineRef = useRef<ArpPlayerEngine | null>(null);
  if (!engineRef.current) engineRef.current = new ArpPlayerEngine();
  const engine = engineRef.current;

  const [cfg, setCfg] = useState<ArpConfig>({ ...DEFAULT_ARP_CONFIG });

  // Below PROGRESSION_FULL_PX of center column (the section's chrome, seven
  // 24px degree keys with 4px gaps, the output row) the keys go compact: 16px,
  // 1px gaps, smaller numerals. Measured on the column, whose height the grid
  // sets, so the switch never changes what it measures.
  const centerRef = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const el = centerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setCompact(el.clientHeight < PROGRESSION_FULL_PX));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The rag counts its odd 16ths from the roll's bar lines, so the engine
  // follows the roll's meter map and pickup as they change.
  const meterMap = usePianoRollStore((s) => s.meterMap);
  const pickupSteps = usePianoRollStore((s) => s.pickupSteps);
  useEffect(() => {
    engine.setMeter({ meterMap, pickupSteps });
  }, [engine, meterMap, pickupSteps]);

  // The arpeggiator bends with the roll's lane A, its curve looping at the roll's length.
  const bends = usePianoRollStore((s) => s.bends);
  const lanes = usePianoRollStore((s) => s.lanes);
  const rollSteps = usePianoRollStore((s) => s.totalSteps);
  useEffect(() => {
    engine.setBend(playedRollBends(bends, lanes, rollSteps).get(0) ?? null, rollSteps);
  }, [engine, bends, lanes, rollSteps]);
  const [activeChord, setActiveChord] = useState<number>(-1);
  const [activeMidi, setActiveMidi] = useState<Set<number>>(new Set());
  const timeoutsRef = useRef<number[]>([]);

  // Patch engine + local mirror together so the UI and the scheduler agree.
  const patch = (p: Partial<ArpConfig>): void => {
    engine.setConfig(p);
    setCfg({ ...engine.cfg });
  };

  const clearTimers = (): void => {
    timeoutsRef.current.forEach((t) => window.clearTimeout(t));
    timeoutsRef.current = [];
  };

  useEffect(() => {
    engine.onTick = ({ when, chordIndex, trebleMidi, bassMidi }) => {
      const ctx = getEngineCtx();
      const delay = Math.max(0, (when - ctx.currentTime) * 1000);
      const id = window.setTimeout(() => {
        setActiveChord(chordIndex);
        setActiveMidi((prev) => {
          const next = new Set(prev);
          next.add(trebleMidi);
          if (bassMidi !== null) {
            // a fresh bass note clears the prior held bass below its register
            for (const m of next) if (m < 48) next.delete(m);
            next.add(bassMidi);
          }
          // keep the held bass + only the latest treble: drop stale trebles
          for (const m of next) if (m >= 48 && m !== trebleMidi) next.delete(m);
          return next;
        });
      }, delay);
      timeoutsRef.current.push(id);
      // prune fired timers occasionally
      if (timeoutsRef.current.length > 256) {
        timeoutsRef.current = timeoutsRef.current.slice(-64);
      }
    };
    engine.onStop = () => {
      clearTimers();
      setActiveChord(-1);
      setActiveMidi(new Set());
    };
    return () => {
      engine.dispose();
      clearTimers();
    };
    // engine is stable (ref); run once
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Follow the strip's PLAY key. Declared after the tick handlers, so a start
  // on mount already has them.
  useEffect(() => {
    if (playing) engine.start();
    else engine.stop();
  }, [engine, playing]);

  const sendToRoll = (): void => {
    const notes = engine.renderProgression();
    const piano: PianoNote[] = notes.map((n, i) => ({
      id: `arp-${i}-${n.step}-${n.midi}`,
      note: n.midi,
      step: n.step,
      length: n.length,
      velocity: n.velocity,
    }));
    usePianoRollStore.getState().importNotes(piano, cfg.bpm);
  };

  const out = engine.outputChords();
  const scaleName = engine.MS._scale?.name ?? '';
  const patternList = engine.AP.patterns[cfg.patternType];

  // active note set for keyboard highlight, by midi
  const trebleMidis = useMemo(() => activeMidi, [activeMidi]);

  const setBpm = (v: number): void =>
    patch({ bpm: Math.max(BPM_MIN, Math.min(BPM_MAX, Math.round(v) || BPM_MIN)) });

  const qPct = Math.round(cfg.quantize * 100);
  const ragPct = Math.round(cfg.swing * 100);
  // small segmented pill (steps / type)
  const pill = `px-2 py-0.5 text-[11px] font-mono font-semibold rounded-xs ${cellEdge} cursor-pointer select-none`;
  const fieldBox = 'flex items-center gap-1 px-1.5 py-0.5 bg-black/40 border border-white/5 rounded';

  return (
    <div className="h-full w-full flex flex-col bg-[#07050a] text-zinc-100 overflow-hidden">
      {/* toolbar — the arpeggiator's settings; it plays from the strip's PLAY key */}
      <div className="shrink-0 flex flex-wrap items-center gap-2 px-2 py-1 border-b border-white/5 bg-black/40">
        <span className="text-[11px] font-black uppercase tracking-widest et-ink" title="Chord-progression arpeggiator — pick a key, mode and chords; it arpeggiates them live through theDAW's synth.">Arp</span>
        <span className="text-[10px] font-mono text-zinc-500" title="Current key + scale">{engine.MS.key} {scaleName}</span>

        {/* BPM */}
        <div className={fieldBox} title="Tempo in beats per minute. Type a value or use −/+ to step by 5.">
          <span className="text-[7px] font-mono text-zinc-600 uppercase">BPM</span>
          <button type="button" aria-label="Decrease BPM" title="−5 BPM" onClick={() => setBpm(cfg.bpm - 5)} className="text-zinc-500 hover:text-zinc-200 leading-none px-0.5">−</button>
          <label htmlFor="arp-bpm" className="sr-only">BPM</label>
          <input
            id="arp-bpm" name="arp-bpm" type="number" min={BPM_MIN} max={BPM_MAX} value={cfg.bpm}
            onChange={(e) => setBpm(parseInt(e.target.value, 10))}
            className="bg-transparent border-none outline-none text-[10px] font-mono text-[rgb(var(--et-accent))] w-9 font-black text-center"
          />
          <button type="button" aria-label="Increase BPM" title="+5 BPM" onClick={() => setBpm(cfg.bpm + 5)} className="text-zinc-500 hover:text-zinc-200 leading-none px-0.5">+</button>
        </div>

        {/* Steps */}
        <div className="flex items-center gap-1" title="Notes per arpeggio (3-6). More steps = busier, longer pattern.">
          <span className="text-[7px] font-mono text-zinc-600 uppercase">Steps</span>
          {STEP_OPTS.map((s) => {
            const on = cfg.steps === s;
            return (
              <button key={s} type="button" aria-label={`Arpeggio steps ${s}`} aria-pressed={on}
                onClick={() => patch({ steps: s })} title={`${s} notes per arpeggio (more steps = busier pattern)`} className={`${pill} ${on ? cellOn : cellOff}`}>
                {s}
              </button>
            );
          })}
        </div>

        {/* Type */}
        <div className="flex items-center gap-1">
          {(['straight', 'looped'] as PatternType[]).map((t) => {
            const on = cfg.patternType === t;
            return (
              <button key={t} type="button" aria-label={`Arpeggio type ${t}`} aria-pressed={on}
                onClick={() => patch({ patternType: t })}
                title={t === 'straight' ? 'Straight: play the note order once per chord' : 'Looped: play the order then mirror back down'}
                className={`${pill} capitalize ${on ? cellOn : cellOff}`}>
                {t}
              </button>
            );
          })}
        </div>

        {/* Quantize + Rag (live timing feel, same as the piano roll) */}
        <div className={fieldBox} title="Quantize: 100% = dead-on grid; lower humanizes timing. Rag delays/pushes the off-16ths. Use −/+ for single-percent steps.">
          <span className="text-[7px] font-mono text-zinc-600 uppercase">Q</span>
          <button type="button" aria-label="Decrease quantize" title="−1%" onClick={() => patch({ quantize: Math.max(0, qPct - 1) / 100 })} className="text-zinc-500 hover:text-zinc-200 leading-none px-0.5">−</button>
          <label htmlFor="arp-quantize" className="sr-only">Quantize</label>
          <input id="arp-quantize" name="arp-quantize" type="range" min={0} max={100} value={qPct}
            onChange={(e) => patch({ quantize: (parseInt(e.target.value, 10) || 0) / 100 })} className="w-16 accent-[rgb(var(--et-accent))]" />
          <button type="button" aria-label="Increase quantize" title="+1%" onClick={() => patch({ quantize: Math.min(100, qPct + 1) / 100 })} className="text-zinc-500 hover:text-zinc-200 leading-none px-0.5">+</button>
          <span className="text-[8px] font-mono text-[rgb(var(--et-accent))] w-7 text-right">{qPct}%</span>
          <span className="text-[7px] font-mono text-zinc-600 uppercase ml-1">Rag</span>
          <button type="button" aria-label="Decrease rag" title="−1%" onClick={() => patch({ swing: Math.max(-50, ragPct - 1) / 100 })} className="text-zinc-500 hover:text-zinc-200 leading-none px-0.5">−</button>
          <label htmlFor="arp-rag" className="sr-only">Rag (swing)</label>
          <input id="arp-rag" name="arp-rag" type="range" min={-50} max={50} value={ragPct}
            onChange={(e) => patch({ swing: (parseInt(e.target.value, 10) || 0) / 100 })} className="w-16 accent-[rgb(var(--et-accent))]" />
          <button type="button" aria-label="Increase rag" title="+1%" onClick={() => patch({ swing: Math.min(50, ragPct + 1) / 100 })} className="text-zinc-500 hover:text-zinc-200 leading-none px-0.5">+</button>
          <span className="text-[8px] font-mono text-[rgb(var(--et-accent))] w-8 text-right">{ragPct > 0 ? '+' : ''}{ragPct}%</span>
        </div>

        {/* Own id prefix: the arpeggiator and the Piano Roll are both mounted
            at once (MidiPanel keeps the roll alive behind the arp face), so the
            default `pr-instrument` id would exist twice in one document. */}
        <InstrumentPicker idPrefix="arp-instrument" />

        {/* Bass */}
        <button
          type="button" aria-label="Toggle bass voice" aria-pressed={cfg.bassOn}
          onClick={() => patch({ bassOn: !cfg.bassOn })} title="Bass voice"
          className={`${pill} flex items-center gap-1 ${cfg.bassOn ? cellOn : cellOff}`}
        >
          <Music4 className="w-3 h-3" /> Bass
        </button>

        <div className="flex-1" />
        <StripKey
          onClick={sendToRoll}
          title="Render the progression into the piano roll's notes (then morph it with the Virtuoso strip above)"
          icon={<Piano className="w-3 h-3" />}
          legend="Piano roll"
        />
      </div>

      {/* body: TONIC/MODE (left rail) · CHORDS + OUTPUT (center hero) · STYLES (right rail) */}
      <div className="flex-1 min-h-0 p-2 grid grid-rows-1 gap-2" style={{ gridTemplateColumns: '196px minmax(0,1fr) 196px' }}>
        {/* left rail: tonic + mode */}
        <div className="flex flex-col gap-2 min-w-0 min-h-0 overflow-y-auto">
          <Section title="Tonic / root" tip="The key center. Every chord is built from this root note plus the chosen mode.">
            <div className="grid grid-cols-4 gap-1">
              {KEYS.map((key) => {
                const on = cfg.key === key;
                return (
                  <button key={key} type="button" aria-label={`Key ${key}`} aria-pressed={on}
                    onClick={() => patch({ key })} title={`Set the tonic (root) to ${key}`} className={`${cellBase} w-full py-1 ${on ? cellOn : cellOff}`}>
                    {key}
                  </button>
                );
              })}
            </div>
          </Section>

          <Section title="Mode" tip="The scale/mode that colors the chords (major, minor, dorian, …). Changes which chords are major/minor/diminished.">
            <div className="grid grid-cols-2 gap-1">
              {MODES.map((mode) => {
                const on = cfg.mode === mode;
                return (
                  <button key={mode} type="button" aria-label={`Mode ${mode}`} aria-pressed={on}
                    onClick={() => patch({ mode })} title={`Use the ${mode} scale/mode for the chords`} className={`${cellBase} w-full py-1 capitalize truncate ${on ? cellOn : cellOff}`}>
                    {mode}
                  </button>
                );
              })}
            </div>
          </Section>
        </div>

        {/* center hero: the chord progression fills the space; output aligns
            directly beneath each chord column. */}
        <div ref={centerRef} className="flex flex-col gap-2 min-w-0 min-h-0 overflow-y-auto">
          {/* The section and its slots keep their content height as a minimum,
              so a short column scrolls; the keys never squash into each other. */}
          <Section title="Chord progression" tip="Eight progression slots, left to right. Each column is one slot — click a scale degree to set which chord plays there. The lit column is playing now." className="flex-1 flex flex-col">
            <div className="flex-1 flex gap-1.5">
              {cfg.chords.map((sel, c) => (
                <div key={c} className={`flex-1 min-w-0 flex flex-col ${compact ? 'gap-px' : 'gap-1'} rounded-xs ${activeChord === c ? 'ring-2 ring-[rgb(var(--et-accent))]' : ''}`}>
                  {INTERVALS.map((_label, i) => {
                    const on = sel === i;
                    const interval = engine.MS.notes[i]?.triad.interval ?? INTERVALS[i];
                    return (
                      <button
                        key={i}
                        type="button"
                        aria-label={`Chord ${c + 1} degree ${interval}`}
                        aria-pressed={on}
                        onClick={() => {
                          const chords = [...cfg.chords];
                          chords[c] = i;
                          patch({ chords });
                        }}
                        title={`Slot ${c + 1}: play the ${interval} chord (scale degree ${i + 1}) here`}
                        className={`flex-1 font-mono font-bold rounded-xs ${cellEdge} cursor-pointer ${compact ? 'min-h-4 text-[10px] leading-none' : 'min-h-6 text-[13px]'} ${on ? cellOn : cellOff}`}
                      >
                        {interval}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          </Section>

          <Section title="Output" tip="The actual chord in each slot (note + quality), lit as it plays. Each chip sits under its progression column." className="shrink-0">
            <div className="flex gap-1.5">
              {out.map((chord, i) => (
                <div
                  key={i}
                  className={`flex-1 min-w-0 text-center px-1 py-1 rounded-xs border text-[11px] font-mono ${
                    activeChord === i
                      ? 'border-[rgb(var(--et-accent))] bg-[rgb(var(--et-accent)/0.12)] text-[rgb(var(--et-accent))]'
                      : 'border-white/10 bg-white/5 text-zinc-200'
                  }`}
                  title={`${chord.note}${chord.type} · ${chord.interval}`}
                >
                  <span className="font-bold">{chord.note}</span>
                  <span className="text-zinc-400 lowercase">{chord.type}</span>
                </div>
              ))}
            </div>
          </Section>
        </div>

        {/* right rail: arpeggio styles (the only scroller) */}
        <div className="flex flex-col gap-2 min-w-0 min-h-0">
          <Section title={`Style (${patternList.length})`} tip="The order each chord's notes are arpeggiated through. Each thumbnail is one note-order; click to choose." className="flex-1 min-h-0 flex flex-col">
            <div className="flex-1 min-h-0 overflow-y-auto grid gap-1 text-zinc-200" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(30px, 1fr))' }}>
              {patternList.map((pattern, i) => {
                const on = cfg.patternId === i;
                return (
                  <button
                    key={i}
                    type="button"
                    aria-label={`Arpeggio style ${pattern.join('')}`}
                    aria-pressed={on}
                    onClick={() => patch({ patternId: i })}
                    title={`Note order ${pattern.map((n) => n + 1).join('-')}`}
                    className={`rounded-xs p-0.5 ${cellEdge} ${on ? cellOn : cellOff}`}
                  >
                    <PatternSvg pattern={pattern} />
                  </button>
                );
              })}
            </div>
          </Section>
        </div>
      </div>

      {/* keyboard strip — anchored to the bottom of the panel */}
      <div className="shrink-0 px-2 pb-2 pt-1">
        <div className="flex gap-px rounded overflow-hidden border border-white/10 bg-black/40">
          {OCTAVES.map((octave) =>
            KEYS.map((key) => {
              const midi = noteNameToMidi(key, octave);
              const black = key.includes('#');
              const on = trebleMidis.has(midi);
              return (
                <div
                  key={`${key}${octave}`}
                  aria-hidden="true"
                  className={`${black ? 'flex-2' : 'flex-3'} h-9 ${
                    on ? (black ? 'bg-[rgb(var(--et-accent)/0.7)]' : 'bg-[rgb(var(--et-accent))]') : black ? 'bg-zinc-800' : 'bg-zinc-200/85'
                  } transition-colors`}
                />
              );
            }),
          )}
        </div>
      </div>
    </div>
  );
};
