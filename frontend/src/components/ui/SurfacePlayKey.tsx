/**
 * SurfacePlayKey — the one play/stop key every surface that plays music puts
 * in the same spot: the FIRST control at the left end of the surface's first
 * toolbar row.
 *
 * It draws the MIDI dock strip's play key (components/audio/midiDockKit.tsx on
 * the midi-dock-rail branch: KEY_PLAY_REST at rest, KEY_ON while playing), so
 * the key looks and sits the same from the piano roll to the sequencer, the
 * score, EDIT and PERFORM:
 *
 *   rest      a 10% tile with a 1px etched top highlight, primary theme ink,
 *             a transparent bottom edge; hover brightens with an inset fill
 *             (never `hover:bg-*`: `bg-white/10` is theme-remapped by an
 *             unlayered rule a layered hover utility cannot beat).
 *   playing   the theme accent ink and a 1px accent bottom edge. No glow.
 *   disabled  the cap stays; the glyph drops to 40%.
 *
 * A surface whose play pauses (its stop key beside it returns to the start)
 * passes `pauses`: while playing the key draws Pause and names itself
 * "Pause …". `busy` swaps the glyph for a spinner while a render runs before
 * the sound can start.
 *
 * `data-surface-play` marks every instance so a probe can find and measure them.
 */
import React from 'react';
import { Loader2, Pause, Play, Square } from 'lucide-react';

const CORE =
  'relative shrink-0 inline-flex items-center justify-center rounded-xs select-none border-b transition-[color,box-shadow,border-color] duration-100 active:shadow-[inset_0_1px_2px_rgba(0,0,0,0.7)] focus-visible:z-10 disabled:cursor-default disabled:*:opacity-40';

const REST =
  'bg-white/10 et-ink border-b-transparent shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] enabled:hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.1),inset_0_0_0_100px_rgba(255,255,255,0.08)]';

const PLAYING =
  'bg-white/10 text-[rgb(var(--et-accent))] border-b-[rgb(var(--et-accent))] shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] enabled:hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.1),inset_0_0_0_100px_rgba(255,255,255,0.06)]';

/** strip: a 22px row (the MIDI dock strip). bar: a 28px toolbar. */
const SIZE = { strip: 'h-5.5 w-7', bar: 'h-7 w-8' } as const;
const GLYPH = { strip: 'w-3 h-3', bar: 'w-3.5 h-3.5' } as const;

export type SurfacePlayKeyProps = Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'onClick' | 'type'> & {
  playing: boolean;
  onToggle: () => void;
  /** What plays, completing the accessible name: "the pattern" gives "Play the pattern" / "Stop the pattern". */
  what: string;
  size?: keyof typeof SIZE;
  /** The key pauses: while playing it draws Pause and reads "Pause …" (a stop key beside it returns to the start). */
  pauses?: boolean;
  /** A render is running before sound can start: the glyph is a spinner. */
  busy?: boolean;
};

export const SurfacePlayKey = React.forwardRef<HTMLButtonElement, SurfacePlayKeyProps>(
  ({ playing, onToggle, what, size = 'strip', pauses = false, busy = false, className = '', title, ...rest }, ref) => {
    const name = `${playing ? (pauses ? 'Pause' : 'Stop') : 'Play'} ${what}`;
    const Glyph = busy ? Loader2 : playing ? (pauses ? Pause : Square) : Play;
    const glyphTone = busy ? 'animate-spin' : playing && !pauses ? '' : 'fill-current';
    return (
      <button
        ref={ref}
        type="button"
        data-surface-play=""
        aria-label={name}
        aria-busy={busy || undefined}
        title={title ?? name}
        onClick={onToggle}
        {...rest}
        className={`${CORE} ${SIZE[size]} ${playing ? PLAYING : REST} ${className}`}
      >
        <Glyph aria-hidden="true" className={`${GLYPH[size]} ${glyphTone}`} />
      </button>
    );
  },
);
SurfacePlayKey.displayName = 'SurfacePlayKey';
