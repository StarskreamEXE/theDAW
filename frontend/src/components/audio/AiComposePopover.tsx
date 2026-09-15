import React, { useRef, useState } from 'react';
import { Sparkles, Loader2 } from 'lucide-react';
import { generatePianoFromParams, type AiComposeResult } from '../../lib/aiComposeClient';
import { logError, logInfo } from '../../state/logStore';
import { DockFlyout, FLYOUT_CARD, KEY_REST, RAIL_GLYPH, RailKey } from './midiDockKit';

const KEYS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const MODES = [
  'major',
  'minor',
  'dorian',
  'phrygian',
  'lydian',
  'mixolydian',
  'harmonic minor',
];
// Curated composition styles (pianistic + a few genre colours the user asked for).
const STYLES = [
  'None',
  'Romantic',
  'Baroque',
  'Impressionist',
  'Neo-classical',
  'Ragtime',
  'Jazz ballad',
  'Smooth jazz',
  'Fire-jazz',
  'Cinematic',
  'Lo-fi',
  'Futurebass',
  'Prog',
];

const legendCls = 'text-[12px] font-display font-bold uppercase et-ink-3';
const fieldCls =
  'bg-black/60 border border-white/10 rounded px-1.5 py-1 text-[12px] font-semibold text-zinc-200 outline-none focus:border-[rgb(var(--et-accent)/0.6)]';

/**
 * AI COMPOSE control for the Piano Roll. The AI key in the MIDI dock's action
 * rail opens a parameter form to its right, asks a Gemini model (through
 * theDAW's server-side proxy) to write a two-hand piano part, and hands the
 * resulting notes back to the roll.
 */
export const AiComposePopover: React.FC<{
  currentBpm: number;
  onGenerated: (result: AiComposeResult) => void;
}> = ({ currentBpm, onGenerated }) => {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [keyName, setKeyName] = useState('C');
  const [mode, setMode] = useState('minor');
  const [style, setStyle] = useState('None');
  const [bars, setBars] = useState(8);
  const [bpm, setBpm] = useState(currentBpm || 120);
  const [complexity, setComplexity] = useState(0.6);
  const [withBass, setWithBass] = useState(true);
  const keyRef = useRef<HTMLButtonElement>(null);

  const generate = async () => {
    setBusy(true);
    try {
      const result = await generatePianoFromParams({
        prompt,
        key: keyName,
        mode,
        bars,
        bpm,
        style: style === 'None' ? undefined : style,
        complexity,
        withBass,
      });
      onGenerated(result);
      logInfo(
        'piano-roll',
        `AI composed ${result.notes.length} notes in ${keyName} ${mode}${result.summary ? ` — ${result.summary}` : ''}`,
      );
      setOpen(false);
    } catch (e) {
      logError('piano-roll', `AI compose failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <RailKey
        ref={keyRef}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="piano-roll-ai-compose-popover"
        aria-label="AI compose"
        description="Write a piano part with AI from the parameters in its card"
        on={open}
        icon={<Sparkles className={RAIL_GLYPH} />}
        legend="AI"
      />

      <DockFlyout
        open={open}
        anchorRef={keyRef}
        onClose={() => setOpen(false)}
        placement="right"
        floorSelector="[data-dock-floor]"
        id="piano-roll-ai-compose-popover"
        role="dialog"
        aria-label="AI compose parameters"
        className={`w-80 p-2.5 flex flex-col gap-2 ${FLYOUT_CARD}`}
      >
        <div className="flex flex-col gap-1">
          <label htmlFor="ai-compose-prompt" className={legendCls}>
            Describe the piece
          </label>
          <textarea
            id="ai-compose-prompt"
            name="ai-compose-prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={2}
            placeholder="e.g. dramatic minor-key intro that builds to virtuosic runs"
            className="bg-black/40 border border-white/10 rounded px-2 py-1 text-[12px] font-semibold text-zinc-200 placeholder:text-zinc-600 outline-none resize-none focus:border-[rgb(var(--et-accent)/0.6)]"
          />
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div className="flex flex-col gap-1">
            <label htmlFor="ai-compose-key" className={legendCls}>
              Key
            </label>
            <select
              id="ai-compose-key"
              name="ai-compose-key"
              value={keyName}
              onChange={(e) => setKeyName(e.target.value)}
              className={fieldCls}
            >
              {KEYS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="ai-compose-mode" className={legendCls}>
              Mode
            </label>
            <select
              id="ai-compose-mode"
              name="ai-compose-mode"
              value={mode}
              onChange={(e) => setMode(e.target.value)}
              className={fieldCls}
            >
              {MODES.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-2">
          <div className="flex flex-col gap-1">
            <label htmlFor="ai-compose-bars" className={legendCls}>
              Bars
            </label>
            <input
              id="ai-compose-bars"
              name="ai-compose-bars"
              type="number"
              min={1}
              max={32}
              value={bars}
              onChange={(e) => setBars(Math.max(1, Math.min(32, parseInt(e.target.value) || 8)))}
              className={fieldCls}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="ai-compose-bpm" className={legendCls}>
              BPM
            </label>
            <input
              id="ai-compose-bpm"
              name="ai-compose-bpm"
              type="number"
              min={40}
              max={240}
              value={bpm}
              onChange={(e) => setBpm(Math.max(40, Math.min(240, parseInt(e.target.value) || 120)))}
              className={fieldCls}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="ai-compose-style" className={legendCls}>
              Style
            </label>
            <select
              id="ai-compose-style"
              name="ai-compose-style"
              value={style}
              onChange={(e) => setStyle(e.target.value)}
              className={fieldCls}
            >
              {STYLES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <label htmlFor="ai-compose-complexity" className={`${legendCls} shrink-0`}>
            Density
          </label>
          <input
            id="ai-compose-complexity"
            name="ai-compose-complexity"
            type="range"
            min={0}
            max={100}
            value={Math.round(complexity * 100)}
            onChange={(e) => setComplexity((parseInt(e.target.value) || 0) / 100)}
            className="flex-1 accent-[rgb(var(--et-accent))]"
          />
          <span className="text-[12px] font-bold et-ink w-8 text-right tabular-nums">
            {Math.round(complexity * 100)}%
          </span>
        </div>

        <label htmlFor="ai-compose-bass" className="flex items-center gap-2 text-[12px] font-semibold text-zinc-300 cursor-pointer">
          <input
            id="ai-compose-bass"
            name="ai-compose-bass"
            type="checkbox"
            checked={withBass}
            onChange={(e) => setWithBass(e.target.checked)}
            className="accent-[rgb(var(--et-accent))]"
          />
          Distinct left-hand bass line
        </label>

        {/* aria-disabled while composing, never the native attribute: the key keeps
            keyboard focus through the request, and a press does nothing until it ends. */}
        <button
          type="button"
          onClick={() => {
            if (!busy) void generate();
          }}
          aria-disabled={busy || undefined}
          className={`w-full mt-0.5 flex items-center justify-center gap-2 px-2 py-1.5 rounded-xs border-b text-[12px] font-display font-extrabold uppercase aria-disabled:cursor-default aria-disabled:*:opacity-40 ${KEY_REST}`}
        >
          {busy ? (
            <>
              <Loader2 aria-hidden="true" className="w-3.5 h-3.5 animate-spin" /> <span>Composing…</span>
            </>
          ) : (
            <>
              <Sparkles aria-hidden="true" className="w-3.5 h-3.5" /> <span>Generate</span>
            </>
          )}
        </button>
        <p className="text-[12px] font-semibold et-ink-3 leading-snug">
          Replaces the roll with the generated part. Needs a Gemini API key set in Settings.
        </p>
      </DockFlyout>
    </>
  );
};
