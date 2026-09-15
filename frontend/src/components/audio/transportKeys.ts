/**
 * The footer's key grammar: the matte plate, the transport keys on it, their
 * etched legends, and the workspace action key at the footer's bottom right.
 * PlayerFooter draws the transport from these and LogActionButton
 * (layout/ProcessingLog.tsx) draws the action key, so both read as one set.
 */

/**
 * The matte plate: the plate's own p-px/gap-px well is the hairline grid
 * between keys. It is a div, so its border-white/8 stays a hairline (the
 * scope's button border floor never touches it), and `bg-black/40` /
 * `border-white/8` are both theme-remapped. Never give it overflow-hidden or a
 * clip-path: the keys' focus outline draws outside them.
 */
export const transportPlate =
  'flex items-stretch h-9 p-px gap-px rounded-xs border border-white/8 bg-black/40 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]';

/**
 * A transport key on the matte plate: squared, flat, borderless. A key must
 * NEVER carry a border-white/N class — index.css floors any bordered button to
 * rgb(var(--et-border)) (a >= 3:1 line) and the hairline grid turns hard. Keyboard
 * focus is the scope's 2px ink outline (index.css), drawn OUTSIDE the key,
 * which is why a focused key only lifts itself above its neighbours
 * (relative + z-10) and adds no ring of its own.
 *
 * The key carries no width: each one in PlayerFooter is its widest legend
 * (12px Orbitron bold, below) plus about 4px a side, and the keys either side
 * of PLAY pair up so PLAY stays on the plate's centre.
 *
 * The OFF / ON / DEAD strings below are exclusive — each owns the key's bg and
 * text — because the scope's ink remaps are unlayered: a `disabled:` or
 * `hover:` utility stacked on `text-zinc-400` would lose to the remapped base
 * class, so state switches the whole string, never layers on top of it.
 */
export const transportKey =
  'h-full flex flex-col items-center justify-center gap-0.5 rounded-none first:rounded-l-xs last:rounded-r-xs select-none transition-[color,box-shadow] duration-100 active:shadow-[inset_0_1px_2px_rgba(0,0,0,0.7)] focus-visible:relative focus-visible:z-10 disabled:pointer-events-none';
/**
 * …at rest / toggle OFF: a 5% tile with a 1px etched top highlight (a hairline,
 * not a glow). `bg-white/5`, `text-zinc-400` and `hover:text-zinc-100` are
 * theme-remapped by UNLAYERED rules, which is why hover and press never use a
 * `hover:bg-*` / `active:bg-*` utility: a layered variant loses to the remapped
 * base fill and paints nothing. The hover fill is an inset box-shadow with a
 * 100px spread (a translucent layer over the tile, under the glyph) and the
 * press is the inset shade on the key string; shadows are never remapped.
 * `bg-white/4|6|8` are not remapped at all: never "tune" the tile to those.
 */
export const transportKeyOff =
  'bg-white/5 text-zinc-400 hover:text-zinc-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.08),inset_0_0_0_100px_rgba(255,255,255,0.06)]';
/**
 * …toggle ON: latched IN (inset shade, one tint step up) in the theme's accent
 * ink (`--et-accent`, editThemes.ts withAccent: the theme's own hue, or on a
 * neutral theme the first purple step that reads at 4.5:1 on this tile) — the
 * glyph and legend take currentColor, so nothing else is needed and no light is
 * added. Hover brightens the whole key a step.
 */
export const transportKeyOn =
  'bg-white/10 text-[rgb(var(--et-accent))] hover:brightness-110 shadow-[inset_0_1px_2px_rgba(0,0,0,0.6)] hover:shadow-[inset_0_1px_2px_rgba(0,0,0,0.6),inset_0_0_0_100px_rgba(255,255,255,0.04)]';
/**
 * …disabled: the key keeps its cap — a dead START/END stays a tile in the grid,
 * not a hole — and only its glyph and legend dim, to 40 % of the live ink, so
 * the cue survives every theme (a fixed dead-ink hex read as live on the light
 * themes, and any zinc step is floored up to a live tier by the remaps).
 */
export const transportKeyDead = 'bg-white/5 text-zinc-400 *:opacity-40 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]';

/**
 * The PLAY key: the plate's widest key, one tint step lighter, primary ink.
 * `border-b` is always present (transparent at rest) so the playing edge never
 * shifts layout; neither border-b colour is in the scope's border-floor list,
 * so nothing floors it.
 */
export const transportPlayKey =
  'h-full flex flex-col items-center justify-center gap-0.5 rounded-none select-none border-b transition-[color,box-shadow,border-color] duration-100 active:shadow-[inset_0_1px_2px_rgba(0,0,0,0.7)] focus-visible:relative focus-visible:z-10 disabled:pointer-events-none';
export const transportPlayRest =
  'bg-white/10 text-zinc-100 border-b-transparent shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.1),inset_0_0_0_100px_rgba(255,255,255,0.08)]';
/**
 * …while playing: the same fill and shadow, accent ink and a 1px etched accent
 * bottom edge (sitting 1px above the plate's own hairline) — the grammar of a
 * latched LOOP/RAND, so it reads across the room on the DJ/VJ tabs where this
 * key is the master transport. No glow.
 */
export const transportPlayOn =
  'bg-white/10 text-[rgb(var(--et-accent))] hover:brightness-110 border-b-[rgb(var(--et-accent))] shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.1),inset_0_0_0_100px_rgba(255,255,255,0.06)]';
export const transportPlayDead = 'bg-white/10 text-zinc-100 *:opacity-40 border-b-transparent shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]';

/**
 * The etched legend under each glyph: Orbitron bold at 12px, line-height 1, no
 * tracking (Orbitron is already wide). Decorative (aria-hidden — the key's
 * aria-label is its name, and every name starts with the words its key prints:
 * LOOP and ALL in "Loop all - …", RAND in "Rand: random order", START in "Jump
 * to start"), it inherits the key's ink, so rest / hover / ON / dead all flow
 * through the button's class.
 */
export const keyLabel = 'font-display font-bold text-xs leading-none uppercase whitespace-nowrap';
/** A value printed on a key (a run's percentage): the bold sans in tabular figures. */
export const keyValue = 'font-sans font-bold text-xs leading-none tabular-nums whitespace-nowrap';

/**
 * The workspace action key (CREATE / PROCESS / TRAIN / STOP / CHAIN / SEND): a
 * PLAY-class key alone on its own plate. It shares PLAY's tile, etched top
 * highlight and always-present `border-b`, so a run latches it the way
 * playback latches PLAY — `transportPlayRest` at rest, `transportPlayOn` while
 * running. A busy key is `aria-disabled`, never `disabled`: it keeps keyboard
 * focus, its place in the tab order and the pointer, so the busy CHAIN key
 * still shows its title.
 */
export const actionKey =
  'relative h-full w-full flex flex-col items-center justify-center gap-0.5 rounded-xs select-none border-b transition-[color,box-shadow,border-color] duration-100 focus-visible:z-10 aria-disabled:cursor-default';
/** …the press shade, on a live key only. */
export const actionKeyPress = 'active:shadow-[inset_0_1px_2px_rgba(0,0,0,0.7)]';
/** …a busy run (PROCESS or CHAIN while it renders): the ON ink and edge with no hover and no press. */
export const actionKeyBusy =
  'bg-white/10 text-[rgb(var(--et-accent))] border-b-[rgb(var(--et-accent))] shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]';

/**
 * CREATE's stage caption, hung over the action plate's top edge (the plate is
 * `relative`) into the footer's first row, right of the scrub strip: the strip
 * holds the row's middle three-fifths, so its right fifth is clear. Bold sans
 * at 12px beside a status dot, right-aligned to the plate, and never wider than
 * that fifth less the footer's side padding and a gap before the strip.
 */
export const actionCaption =
  'absolute bottom-full right-0 mb-0.5 flex items-center gap-1.5 max-w-[calc(20vw-2rem)] font-sans font-bold text-xs leading-4 uppercase whitespace-nowrap text-zinc-300';
