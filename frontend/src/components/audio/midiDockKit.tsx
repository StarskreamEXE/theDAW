/**
 * The MIDI dock's key grammar, its tooltip and its flyout.
 *
 * One module so the settings strip, the action rail, the SHAPE row and the
 * Vocal2MIDI header draw every key from the same four states:
 *
 *   rest       a 10% tile with a 1px etched top highlight and a transparent
 *              bottom edge, secondary theme ink; hover brightens with an inset
 *              fill (never a `hover:bg-*`: `bg-white/10` is theme-remapped by an
 *              unlayered rule that a layered hover utility cannot beat).
 *   on         the theme accent (`--et-accent`, the footer transport's latched
 *              ink; `et-accent-legend` takes it a step darker on light themes so
 *              the legend holds 4.5:1 on the tile) and a 1px accent bottom
 *              edge. No glow.
 *   recording  red ink, a red bottom edge and a soft red glow. The only key
 *              that glows.
 *   disabled   the cap stays; its glyph and legend drop to 40% (`disabled:*:`,
 *              and `aria-disabled:*:` for a key that is only unavailable while
 *              a job runs, which keeps keyboard focus; lib/dockKey), so every
 *              glyph and legend must be an element, never a bare text node.
 *
 * The bottom edge is always a `border-b` (transparent at rest) so latching a key
 * never shifts the layout, and no key carries a `border-white/N` class: the
 * theme scope floors those to a hard 3:1 line on controls.
 *
 * Every word in the dock is 12px. Legends and headings are Orbitron
 * (`font-display`, bold); values, selects, menu rows and list rows are the sans
 * at 600 or heavier, digits in tabular figures. A key that runs a command or
 * opens a card shows its glyph alone and names itself in a DockTip; a key that
 * shows a setting or a state keeps its word.
 */
import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { focusFate, keyAvailability } from '../../lib/dockKey';
import {
  DOCK_TIP_DELAY_MS,
  clearAsides,
  clearObstacle,
  createTipLatch,
  floorCap,
  floorLimit,
  joinIds,
  placeDockTip,
  tipBounds,
  tipDescribedBy,
  type DockTipPlacement,
  type TipBounds,
} from '../../lib/dockTip';

const KEY_CORE =
  'relative select-none border-b transition-[color,box-shadow,border-color] duration-100 not-aria-disabled:active:shadow-[inset_0_1px_2px_rgba(0,0,0,0.7)] focus-visible:z-10 disabled:cursor-default disabled:*:opacity-40 aria-disabled:cursor-default aria-disabled:*:opacity-40';

export const KEY_REST =
  'bg-white/10 et-ink-2 enabled:not-aria-disabled:hover:et-ink border-b-transparent shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] enabled:not-aria-disabled:hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.1),inset_0_0_0_100px_rgba(255,255,255,0.06)]';
export const KEY_ON =
  'bg-white/10 et-accent-legend border-b-[rgb(var(--et-accent))] shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] enabled:not-aria-disabled:hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.1),inset_0_0_0_100px_rgba(255,255,255,0.06)]';
export const KEY_REC =
  'bg-white/10 text-red-300 border-b-red-500 shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_0_10px_rgba(239,68,68,0.45)]';
/** The transport PLAY key at rest: primary ink, one step brighter than a key. */
export const KEY_PLAY_REST =
  'bg-white/10 et-ink border-b-transparent shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] enabled:not-aria-disabled:hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.1),inset_0_0_0_100px_rgba(255,255,255,0.08)]';

export const keyTone = (s: { on?: boolean; rec?: boolean }): string =>
  s.rec ? KEY_REC : s.on ? KEY_ON : KEY_REST;

/** A key in the 34px strip or the 36px SHAPE row: an optional 14px glyph and a
 *  12px word, 26px tall. */
export const STRIP_KEY = `${KEY_CORE} h-6.5 shrink-0 inline-flex items-center gap-1 px-1.5 rounded-xs text-[12px] font-display font-bold uppercase whitespace-nowrap`;
/** An icon-only strip or row key: a 14px glyph in a 26px square. */
export const STRIP_ICON_KEY = `${KEY_CORE} h-6.5 w-6.5 shrink-0 inline-flex items-center justify-center rounded-xs`;
/** The glyph size inside STRIP_ICON_KEY. */
export const STRIP_GLYPH = 'w-3.5 h-3.5';
/** A 20px key that sits inside a field or the 22px Voice header: a 12px word. */
export const MINI_KEY = `${KEY_CORE} h-5 shrink-0 inline-flex items-center gap-1 px-1 rounded-xs text-[12px] font-display font-bold uppercase whitespace-nowrap`;
/** The glyph size inside MINI_ICON_KEY. */
export const MINI_GLYPH = 'w-3 h-3';
/** A 20px key whose word is a value (the groove's PICK): the bold sans. */
export const MINI_WORD_KEY = `${KEY_CORE} h-5 shrink-0 inline-flex items-center px-1.5 rounded-xs text-[12px] font-bold uppercase whitespace-nowrap`;
export const MINI_ICON_KEY = `${KEY_CORE} h-5 w-5 shrink-0 inline-flex items-center justify-center rounded-xs`;
/** A key inside a flyout card: a 12px legend. */
export const FLYOUT_KEY = `${KEY_CORE} h-5.5 shrink-0 inline-flex items-center gap-1.5 px-2 rounded-xs text-[12px] font-display font-bold uppercase whitespace-nowrap`;
/** One row of a menu flyout: icon + a 12px word in the sans. */
export const MENU_KEY = `${KEY_CORE} h-5.5 w-full shrink-0 inline-flex items-center gap-1.5 px-2 rounded-xs text-[12px] font-semibold whitespace-nowrap`;
/** Rail key heights in CSS px, full and compact; MidiPanel derives the rail's
 *  compact switch from them. */
export const RAIL_KEY_PX = 28;
export const RAIL_KEY_COMPACT_PX = 21;
/** A key in the left action rail: a 16px glyph, its word in a DockTip. 28px
 *  tall; inside a rail marked `data-compact` (a dock too short for every key at
 *  full height) it drops to 21px, which still holds the glyph and keeps all nine
 *  keys in view at the dock's default height from 1280x720 up. */
export const RAIL_KEY = `${KEY_CORE} h-7 group-data-compact/rail:h-5.25 w-full flex items-center justify-center rounded-xs`;
/** The glyph size inside RAIL_KEY. */
export const RAIL_GLYPH = 'w-4 h-4';

/** A labelled value well: legend, control, readout. 26px, level with the keys. */
export const FIELD =
  'h-6.5 shrink-0 inline-flex items-center gap-1 px-1.5 rounded-xs bg-black/40 border border-white/10';
/**
 * A field that gives up width when its row runs short: legend, a RANGE_FILL
 * range and a readout on a grid whose middle track runs from 48px down to 32px.
 * Its min-content is the 32px form, so it never narrows past that and its
 * readout stays inside it; legend and readout keep their widths.
 */
export const FIELD_SHRINK =
  'h-6.5 shrink inline-grid grid-cols-[auto_minmax(32px,48px)_auto] items-center gap-1 px-1.5 rounded-xs bg-black/40 border border-white/10';
/** FIELD_SHRINK whose range track also takes the row's spare width (the METER
 *  face's SYNC and ACCENT); cap it with a max width. */
export const FIELD_GROW =
  'h-6.5 shrink grow inline-grid grid-cols-[auto_minmax(32px,1fr)_auto] items-center gap-1 px-1.5 rounded-xs bg-black/40 border border-white/10';
export const FIELD_LEGEND = 'shrink-0 text-[12px] font-display font-bold uppercase et-ink-3 leading-none';
/** "100" is 21px at 12px bold in tabular figures, so a range's readout is w-5.5. */
export const FIELD_VALUE = 'shrink-0 whitespace-nowrap text-[12px] font-bold et-ink tabular-nums leading-none text-right';
/** A bare <select> inside a FIELD (STYLE, GROUPS). */
export const FIELD_SELECT = 'h-5 bg-transparent border-none outline-none text-[12px] font-semibold et-ink tabular-nums cursor-pointer';
export const FLYOUT_LEGEND = 'text-[12px] font-display font-bold uppercase et-ink-3 leading-none';
export const FLYOUT_VALUE = 'text-[12px] font-bold et-ink tabular-nums leading-none text-right';
/** A 48px range in a fixed FIELD (the strip's QUANT and SWING). */
export const RANGE = 'w-12 min-w-8 shrink h-3 accent-[rgb(var(--et-accent))] cursor-pointer';
/** The range inside FIELD_SHRINK or FIELD_GROW: it fills its grid track and adds
 *  nothing to the field's intrinsic width, so the track alone sets it. */
export const RANGE_FILL = 'w-0 min-w-full h-3 accent-[rgb(var(--et-accent))] cursor-pointer';
/** A native <select> sized for the strip and the SHAPE row. */
export const DOCK_SELECT = 'form-select h-6.5 shrink-0 px-1 text-[12px] font-semibold tabular-nums';
/** A native <select> across a flyout card (the REC key's input device): the sans, never the settings modal's mono. */
export const FLYOUT_SELECT =
  'min-w-0 w-full rounded border border-white/10 bg-black/40 px-1.5 py-1 font-sans text-[12px] font-semibold tabular-nums text-zinc-200 outline-none focus:border-[rgb(var(--et-accent)/0.6)] disabled:opacity-50';
/** A flyout card: the popup surface, a themed hairline, a drop shadow. */
export const FLYOUT_CARD =
  'bg-[#0a080f] border border-white/10 rounded-sm shadow-[0_8px_32px_rgba(0,0,0,0.75)]';

export const Sep: React.FC = () => <span aria-hidden="true" className="w-px h-4 shrink-0 bg-white/10" />;

/* ── the dock tooltip ───────────────────────────────────────────────────── */

/** A ref that fills two refs, the forwarded one and a component's own. A new
 *  ref object hands the node over again; nothing is written during render. */
function useMergedRef<T>(a: React.Ref<T> | undefined, b: React.Ref<T> | undefined): React.RefCallback<T> {
  return useCallback(
    (node: T | null) => {
      for (const r of [a, b]) {
        if (typeof r === 'function') r(node);
        else if (r) (r as React.MutableRefObject<T | null>).current = node;
      }
    },
    [a, b],
  );
}

/** The nearest enabled, tabbable key before `key` (else after it), first inside
 *  its field or group, then inside the row around that. */
function nearestEnabledKey(key: HTMLButtonElement): HTMLButtonElement | null {
  const usable = (b: HTMLButtonElement) => b !== key && !b.disabled && b.tabIndex >= 0 && b.getClientRects().length > 0;
  let scope = key.parentElement;
  for (let level = 0; scope && level < 2; level += 1, scope = scope.parentElement) {
    const keys = Array.from(scope.querySelectorAll('button'));
    const at = keys.indexOf(key);
    for (let i = at - 1; i >= 0; i -= 1) if (usable(keys[i])) return keys[i];
    for (let i = at + 1; i < keys.length; i += 1) if (usable(keys[i])) return keys[i];
  }
  return null;
}

/**
 * Keeps keyboard focus in its field when a limit key's own press disables it (a
 * stepper at its end, the last meter change, Remove on bar 1): `pass` is set on
 * those keys only. The browser blurs a disabled button and focus falls to the
 * page; when that is where it landed, it moves to the nearest enabled key beside
 * the disabled one. Any other key a store change disables lets focus fall
 * (lib/dockKey `focusFate`), so focus never jumps to an unrelated key.
 */
function useFocusOnDisable(ref: React.RefObject<HTMLButtonElement | null>, pass: boolean): void {
  useEffect(() => {
    const key = ref.current;
    if (!key || !pass) return;
    let raf = 0;
    const onBlur = (e: FocusEvent) => {
      if (e.relatedTarget || focusFate(keyAvailability(key.disabled), pass) !== 'neighbour') return;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const active = document.activeElement;
        if (active && active !== document.body) return;
        nearestEnabledKey(key)?.focus({ preventScroll: true });
      });
    };
    key.addEventListener('blur', onBlur);
    return () => {
      cancelAnimationFrame(raf);
      key.removeEventListener('blur', onBlur);
    };
  }, [ref, pass]);
}

/** The floating assistant orb's box in the host's zoomed CSS px, or null when it is not shown. */
function orbBounds(z: number): TipBounds | null {
  const orb = document.querySelector('.aether-orb-toggle');
  if (!orb) return null;
  const o = orb.getBoundingClientRect();
  if (o.width <= 0 || o.height <= 0) return null;
  return { left: o.left / z, top: o.top / z, right: o.right / z, bottom: o.bottom / z };
}

/** The dock shows one tooltip at a time: a card that opens closes the one that was open. */
const TIP_LATCH = createTipLatch();

/** A DOM-safe id for a tooltip; React's own ids carry characters CSS selectors reject. */
function useTipId(): string {
  return `dock-tip-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
}

interface DockTipProps {
  anchorRef: React.RefObject<HTMLElement | null>;
  id: string;
  /** The key's word, printed in Orbitron. */
  word: string;
  /** What the key does, in the sans, wrapping at 260px. */
  description?: string;
  placement?: DockTipPlacement;
  /** True while the key's own flyout is open: the tip stays shut. */
  suppressed?: boolean;
}

/**
 * The dock's tooltip: a key's word and, when it has one, what it does.
 *
 * It opens 350ms after a pointer comes to rest on its key and at once when the
 * key takes keyboard focus (`:focus-visible`), and closes when the pointer
 * leaves, the key blurs, a pointer presses anywhere on the key, or Escape is
 * pressed. Escape is read in the capture phase and left untouched, so the card
 * or field it was meant for still gets it. The card never takes focus and
 * never catches the pointer. Only one card is open in the dock: a card opened
 * by focus closes when the pointer opens another key's card, and the other way round.
 *
 * Like DockFlyout it portals into the nearest `.edit-theme-scope`, which keeps
 * the theme's tokens, and divides every coordinate by that root's
 * `data-layout-zoom`. It stays in the DOM while shut (`hidden`), so the key's
 * `aria-describedby` always resolves.
 */
export const DockTip: React.FC<DockTipProps> = ({ anchorRef, id, word, description, placement = 'above', suppressed = false }) => {
  const tipRef = useRef<HTMLDivElement | null>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const suppressedRef = useRef(suppressed);

  useLayoutEffect(() => {
    setHost((anchorRef.current?.closest('.edit-theme-scope') as HTMLElement | null) ?? document.body);
  }, [anchorRef]);

  useEffect(() => {
    suppressedRef.current = suppressed;
    if (suppressed) setOpen(false);
  }, [suppressed]);

  // An open card holds the dock's one tooltip; opening this one closes the other.
  const close = useCallback(() => setOpen(false), []);
  useEffect(() => {
    if (!open) return;
    TIP_LATCH.claim(close);
    return () => TIP_LATCH.release(close);
  }, [open, close]);

  useEffect(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    let timer = 0;
    const cancel = () => {
      window.clearTimeout(timer);
      timer = 0;
    };
    const hide = () => {
      cancel();
      setOpen(false);
    };
    const onEnter = (e: PointerEvent) => {
      if (e.pointerType === 'touch' || suppressedRef.current) return;
      cancel();
      timer = window.setTimeout(() => {
        timer = 0;
        if (!suppressedRef.current) setOpen(true);
      }, DOCK_TIP_DELAY_MS);
    };
    const onFocus = () => {
      if (suppressedRef.current) return;
      let keyboard = false;
      try {
        keyboard = anchor.matches(':focus-visible');
      } catch {
        keyboard = false;
      }
      if (keyboard) {
        cancel();
        setOpen(true);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') hide();
    };
    anchor.addEventListener('pointerenter', onEnter);
    anchor.addEventListener('pointerleave', hide);
    anchor.addEventListener('pointerdown', hide);
    anchor.addEventListener('focus', onFocus);
    anchor.addEventListener('blur', hide);
    window.addEventListener('keydown', onKey, true);
    return () => {
      cancel();
      anchor.removeEventListener('pointerenter', onEnter);
      anchor.removeEventListener('pointerleave', hide);
      anchor.removeEventListener('pointerdown', hide);
      anchor.removeEventListener('focus', onFocus);
      anchor.removeEventListener('blur', hide);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [anchorRef]);

  const place = useCallback(() => {
    const anchor = anchorRef.current;
    const tip = tipRef.current;
    if (!anchor || !tip || !host) return;
    // A key scrolled away or hidden (the rail's far end, the ARP face) has no box.
    if (!anchor.isConnected || anchor.getClientRects().length === 0) {
      setOpen(false);
      return;
    }
    const z = parseFloat(host.getAttribute('data-layout-zoom') ?? '') || 1;
    const a = anchor.getBoundingClientRect();
    const t = tip.getBoundingClientRect();
    const hostRect = host === document.body ? null : host.getBoundingClientRect();
    const bounds = tipBounds({ width: window.innerWidth, height: window.innerHeight }, hostRect, z);
    const size = { width: t.width / z, height: t.height / z };
    const placed = placeDockTip({ left: a.left / z, top: a.top / z, width: a.width / z, height: a.height / z }, size, bounds, placement);
    // The orb paints over every dock layer, so the card keeps off it.
    const p = clearObstacle(placed, size, orbBounds(z), bounds);
    setPos((prev) => (prev && Math.abs(prev.x - p.x) < 0.5 && Math.abs(prev.y - p.y) < 0.5 ? prev : { x: p.x, y: p.y }));
  }, [anchorRef, host, placement]);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, place, word, description]);

  if (!host) return null;
  return createPortal(
    <div
      ref={tipRef}
      id={id}
      role="tooltip"
      hidden={!open}
      data-dock-tip=""
      className={`fixed z-210 pointer-events-none w-max max-w-69 flex flex-col gap-1 px-2 py-1.5 ${FLYOUT_CARD}`}
      style={{ left: pos?.x ?? -9999, top: pos?.y ?? -9999, visibility: pos ? 'visible' : 'hidden' }}
    >
      <span className="text-[12px] leading-4 font-display font-bold uppercase et-ink">{word}</span>
      {description && (
        <span id={`${id}-desc`} className="text-[12px] leading-4 font-semibold et-ink-2">
          {description}
        </span>
      )}
    </div>,
    host,
  );
};

interface UseDockTipOptions {
  word: string;
  description?: string;
  /** The trigger's `aria-label`; its visible word when it has none. */
  label?: string;
  /** Ids the trigger already points `aria-describedby` at. */
  describedBy?: string;
  /** The trigger's `aria-expanded`, or any other flyout the key opens (a
   *  right-click menu): while true the tip stays shut. */
  expanded?: boolean | 'true' | 'false';
  placement?: DockTipPlacement;
}

/**
 * A DockTip for any key. Put `anchorRef` on the key, `describedBy` in its
 * `aria-describedby`, render `tip` beside it, and leave `title` off the key and
 * its ancestors. `describedBy` names only the part of the tip the key's name
 * does not already say.
 */
export function useDockTip({ word, description, label, describedBy, expanded, placement = 'above' }: UseDockTipOptions): {
  anchorRef: React.RefObject<HTMLButtonElement | null>;
  describedBy: string | undefined;
  tip: React.ReactNode;
} {
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const id = useTipId();
  return {
    anchorRef,
    describedBy: joinIds(describedBy, tipDescribedBy(label ?? word, word, description, id)),
    tip: (
      <DockTip
        anchorRef={anchorRef}
        id={id}
        word={word}
        description={description}
        placement={placement}
        suppressed={expanded === true || expanded === 'true'}
      />
    ),
  };
}

type RailKeyProps = Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'title'> & {
  icon: React.ReactNode;
  /** The key's word, shown in its DockTip. `aria-label` names the key and contains it. */
  legend: string;
  description?: string;
  on?: boolean;
  rec?: boolean;
  /** True while a flyout the key opens without `aria-expanded` (a right-click menu) is up. */
  tipSuppressed?: boolean;
} & KeyAvailabilityProps;

/** How a key is out of action, beside the native `disabled` (lib/dockKey). */
interface KeyAvailabilityProps {
  /** Out of action while a job runs (REC converting, ANALYZE, a bounce): the
   *  key reads as unavailable (`aria-disabled`) and ignores presses, but stays
   *  an enabled button, so it keeps keyboard focus and its tip. */
  unavailable?: boolean;
  /** A limit key its own press can disable (a stepper's end, the last meter
   *  change): focus then moves to the nearest enabled key in its field. */
  passFocusOnDisable?: boolean;
}

const isTrue = (v: boolean | 'true' | 'false' | undefined): boolean => v === true || v === 'true';

/** One rail key: a 16px glyph; its word and what it does open in a DockTip to its right. */
export const RailKey = React.forwardRef<HTMLButtonElement, RailKeyProps>(
  ({ icon, legend, description, on, rec, tipSuppressed, unavailable, passFocusOnDisable = false, disabled, onClick, className = '', type = 'button', ...rest }, ref) => {
    const { anchorRef, describedBy, tip } = useDockTip({
      word: legend,
      description,
      label: rest['aria-label'],
      describedBy: rest['aria-describedby'],
      expanded: !!tipSuppressed || isTrue(rest['aria-expanded']),
      placement: 'right',
    });
    useFocusOnDisable(anchorRef, passFocusOnDisable);
    const setRef = useMergedRef(ref, anchorRef);
    const avail = keyAvailability(disabled, unavailable);
    return (
      <>
        <button
          ref={setRef}
          type={type}
          {...rest}
          disabled={avail.disabled}
          aria-disabled={avail.ariaDisabled ?? rest['aria-disabled']}
          onClick={avail.pressable ? onClick : undefined}
          aria-label={rest['aria-label'] ?? legend}
          aria-describedby={describedBy}
          className={`${RAIL_KEY} ${keyTone({ on, rec })} ${className}`}
        >
          <span aria-hidden="true" className="flex">{icon}</span>
        </button>
        {tip}
      </>
    );
  },
);
RailKey.displayName = 'RailKey';

type StripKeyProps = Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'title'> & {
  icon?: React.ReactNode;
  /** The key's word: printed, or only in the DockTip when `iconOnly`. */
  legend: string;
  /** What the key does, in its DockTip. */
  description?: string;
  /** An action key: the glyph alone, the word in the DockTip. */
  iconOnly?: boolean;
  on?: boolean;
  rec?: boolean;
  /** A key inside a flyout card (FLYOUT_KEY). */
  flyout?: boolean;
  /** A 20px key inside a field (MINI_ICON_KEY, or MINI_WORD_KEY for a word). */
  mini?: boolean;
  legendClassName?: string;
  /** True while a flyout the key opens without `aria-expanded` is up. */
  tipSuppressed?: boolean;
} & KeyAvailabilityProps;

/** A strip, row, field or flyout key. It gets a DockTip when it is icon-only or has a description. */
export const StripKey = React.forwardRef<HTMLButtonElement, StripKeyProps>(
  (
    { icon, legend, description, iconOnly, on, rec, flyout, mini, legendClassName, tipSuppressed, unavailable, passFocusOnDisable = false, disabled, onClick, className = '', type = 'button', ...rest },
    ref,
  ) => {
    const withTip = !!iconOnly || !!description;
    const name = rest['aria-label'] ?? (iconOnly ? legend : undefined);
    const { anchorRef, describedBy, tip } = useDockTip({
      word: legend,
      description,
      label: name ?? legend,
      describedBy: rest['aria-describedby'],
      expanded: !!tipSuppressed || isTrue(rest['aria-expanded']),
    });
    useFocusOnDisable(anchorRef, passFocusOnDisable);
    const setRef = useMergedRef(ref, anchorRef);
    const avail = keyAvailability(disabled, unavailable);
    const cap = flyout
      ? FLYOUT_KEY
      : mini
        ? iconOnly
          ? MINI_ICON_KEY
          : MINI_WORD_KEY
        : iconOnly
          ? STRIP_ICON_KEY
          : STRIP_KEY;
    return (
      <>
        <button
          ref={setRef}
          type={type}
          {...rest}
          disabled={avail.disabled}
          aria-disabled={avail.ariaDisabled ?? rest['aria-disabled']}
          onClick={avail.pressable ? onClick : undefined}
          aria-label={name}
          aria-describedby={withTip ? describedBy : rest['aria-describedby']}
          className={`${cap} ${keyTone({ on, rec })} ${className}`}
        >
          {icon && <span aria-hidden="true" className="flex">{icon}</span>}
          {!iconOnly && <span className={legendClassName}>{legend}</span>}
        </button>
        {withTip && tip}
      </>
    );
  },
);
StripKey.displayName = 'StripKey';

type MenuKeyProps = Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & {
  icon?: React.ReactNode;
  legend: string;
};

/** One row of a menu flyout (the song menu, EXPORT, the linked clip). */
export const MenuKey = React.forwardRef<HTMLButtonElement, MenuKeyProps>(
  ({ icon, legend, className = '', type = 'button', role = 'menuitem', ...rest }, ref) => (
    <button ref={ref} type={type} role={role} {...rest} className={`${MENU_KEY} ${KEY_REST} ${className}`}>
      {icon && <span aria-hidden="true" className="flex">{icon}</span>}
      <span>{legend}</span>
    </button>
  ),
);
MenuKey.displayName = 'MenuKey';

/** A scroll cue's chevron key: 24x12, the only part of a cue that takes the pointer. */
const CUE_KEY = 'pointer-events-auto w-6 h-3 shrink-0 flex items-center justify-center et-ink-2 hover:et-ink';

/**
 * A scroll cue's chevron key (the ARP face's columns and STYLE grid, the MAP
 * card's binding list). `word`, what it scrolls to, is its DockTip and sits in
 * its name, so the tip adds no description. Pointer only, as on the rail:
 * keyboard focus scrolls a key into view on its own. `idle` keeps the key's
 * slot but hides it, for the way a list has nothing more, so the other
 * direction's key never moves into its place.
 */
export const CueKey: React.FC<{ dir: 1 | -1; name: string; word: string; onGo: () => void; idle?: boolean }> = ({ dir, name, word, onGo, idle = false }) => {
  const { anchorRef, describedBy, tip } = useDockTip({ word, label: name });
  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        tabIndex={-1}
        onClick={onGo}
        aria-label={name}
        aria-describedby={describedBy}
        className={`${CUE_KEY} ${idle ? 'invisible' : ''}`}
      >
        {dir === 1 ? <ChevronDown aria-hidden="true" className="w-3 h-3" /> : <ChevronUp aria-hidden="true" className="w-3 h-3" />}
      </button>
      {tip}
    </>
  );
};

/**
 * A 12px corner target laid over a rail key (the REC key's input menu, the
 * SAVE key's UNLINK): a dark well with a 1px edge in the theme's line ink, so
 * the target reads as its own key, and a glyph in secondary ink
 * (CORNER_GLYPH). A sibling of the key, never a child: a button cannot hold a
 * button. It sits 1px right of the key, in the rail's 2px side padding, so
 * the key's glyph needs less of a shift to clear it (CORNER_CLEAR_GLYPH). A
 * transparent 1px ring around the box takes the pointer too, so a press on the
 * box's fractional edge at a layout zoom still reaches the corner; the ring ends
 * at the rail's inner edge.
 */
export const CORNER_KEY =
  "absolute top-0 -right-px z-10 w-3 h-3 flex items-center justify-center rounded-xs bg-black/60 et-ink-2 shadow-[inset_0_0_0_1px_rgb(var(--et-line)/0.32)] hover:et-ink hover:shadow-[inset_0_0_0_1px_rgb(var(--et-line)/0.5),inset_0_0_0_100px_rgba(255,255,255,0.12)] after:absolute after:-inset-px";
/** The glyph inside CORNER_KEY: a 12px box, so nothing overhangs the rail. */
export const CORNER_GLYPH = 'w-3 h-3 shrink-0 pointer-events-none';
/**
 * The REC corner's chevron, cropped so its ink is 10px tall in the 12px box
 * and set 1px up and right of centre, clear of the REC key's glyph. Pass as
 * the lucide icon's `viewBox` with `strokeWidth={3}`.
 */
export const CORNER_CHEVRON_VIEWBOX = '1.5 4.5 18 18';
/**
 * The glyph of a rail key that carries a CORNER_KEY (REC, a linked SAVE): 2px
 * left and 1px down of centre, as far as its ink needs to end left of the
 * corner's well, so it stays near the centre line the rail's other glyphs share.
 * Pass on the lucide icon.
 */
export const CORNER_CLEAR_GLYPH = '-translate-x-0.5 translate-y-0.25';

/** Remembered on/off preference; storage can be blocked, so every access is guarded. */
export function useStoredToggle(key: string, initial: boolean): [boolean, (next: boolean) => void] {
  const [value, setValue] = useState<boolean>(() => {
    try {
      const raw = window.localStorage.getItem(key);
      return raw === null ? initial : raw === '1';
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (next: boolean) => {
      setValue(next);
      try {
        window.localStorage.setItem(key, next ? '1' : '0');
      } catch {
        /* storage blocked: the choice lasts for this session only */
      }
    },
    [key],
  );
  return [value, set];
}

/* ── the floating assistant orb ─────────────────────────────────────────────
   The app's orb (`.aether-orb-toggle`) is a fixed 112px box, welded to the
   bottom-left corner until the user drags it, which is exactly where the SHAPE
   row and the foot of the action rail sit. It swallows clicks across its whole
   box, so the dock measures it and pads itself clear. */

export interface OrbClearance {
  /** CSS px the orb reaches in from the element's left edge (0 = clear). */
  left: number;
  right: number;
  bottom: number;
}

const NO_CLEARANCE: OrbClearance = { left: 0, right: 0, bottom: 0 };
/** An orb this close to an edge is treated as parked on it. Viewport px. */
const ORB_EDGE_REACH = 48;
/** A box-corner graze thinner than this is not worth giving up space for. Viewport px. */
const ORB_MIN_OVERLAP = 4;
const ORB_GAP = 6;

const sameClearance = (a: OrbClearance, b: OrbClearance) =>
  a.left === b.left && a.right === b.right && a.bottom === b.bottom;

/**
 * How far the orb reaches into `ref`'s box, in that element's own CSS px (the
 * Shell root's zoom is divided out). Pad the element's inside by these amounts:
 * padding never moves the element's own box, so the measurement cannot chase
 * itself. An orb dragged into the middle of the element counts as no clearance.
 */
export function useOrbClearance(ref: React.RefObject<HTMLElement | null>): OrbClearance {
  const [clearance, setClearance] = useState<OrbClearance>(NO_CLEARANCE);

  useEffect(() => {
    let raf = 0;
    let settle = 0;
    let watched: Element | null = null;
    let mo: MutationObserver | null = null;

    const measure = () => {
      const el = ref.current;
      const orb = document.querySelector('.aether-orb-toggle');
      let next = NO_CLEARANCE;
      if (el && orb) {
        const zoomHost = el.closest('[data-layout-zoom]');
        const z = parseFloat(zoomHost?.getAttribute('data-layout-zoom') ?? '') || 1;
        const e = el.getBoundingClientRect();
        const o = orb.getBoundingClientRect();
        const overlapX = Math.min(o.right, e.right) - Math.max(o.left, e.left);
        const overlapY = Math.min(o.bottom, e.bottom) - Math.max(o.top, e.top);
        const overlaps = o.width > 0 && e.width > 0 && overlapX >= ORB_MIN_OVERLAP && overlapY >= ORB_MIN_OVERLAP;
        if (overlaps) {
          next = {
            left: o.left - e.left < ORB_EDGE_REACH ? Math.ceil((o.right - e.left) / z + ORB_GAP) : 0,
            right: e.right - o.right < ORB_EDGE_REACH ? Math.ceil((e.right - o.left) / z + ORB_GAP) : 0,
            bottom: e.bottom - o.bottom < ORB_EDGE_REACH ? Math.ceil((e.bottom - o.top) / z + ORB_GAP) : 0,
          };
        }
      }
      setClearance((prev) => (sameClearance(prev, next) ? prev : next));
    };
    const schedule = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(measure);
    };
    // The orb mounts after boot and can remount; follow whichever one is live.
    const watchOrb = () => {
      const orb = document.querySelector('.aether-orb-toggle');
      if (orb !== watched) {
        mo?.disconnect();
        mo = null;
        watched = orb;
        if (orb) {
          // A drag writes the transform on every move; a corner re-stick glides
          // for 900ms, so measure again once the glide has landed.
          mo = new MutationObserver(() => {
            schedule();
            window.clearTimeout(settle);
            settle = window.setTimeout(schedule, 950);
          });
          mo.observe(orb, { attributes: true, attributeFilter: ['style', 'class'] });
        }
      }
      schedule();
    };

    watchOrb();
    const el = ref.current;
    const ro = el && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(schedule) : null;
    if (ro && el) ro.observe(el);
    window.addEventListener('resize', schedule);
    // The dock animates open and the footer can change height; a slow poll
    // catches movement no observer reports.
    const poll = window.setInterval(watchOrb, 1000);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(settle);
      window.clearInterval(poll);
      window.removeEventListener('resize', schedule);
      ro?.disconnect();
      mo?.disconnect();
    };
  }, [ref]);

  return clearance;
}

/* ── the Library edge tab ───────────────────────────────────────────────────
   The Shell's Library tab (`[data-edge-tab]`) floats on the window's right
   edge, vertically centred, over every panel. A dock taller than its default
   reaches up under it, where it covers the strip's MAP key and the Voice
   column's keys. The dock pads itself clear of it on the right. */

/** The edge tab's width while hovered (Shell: `w-6 hover:w-8`), in its own CSS px. */
const EDGE_TAB_HOVER_PX = 32;

/**
 * CSS px the Library edge tab reaches in from `ref`'s right edge (0 = clear),
 * measured at the tab's hovered width so hovering it never moves the dock.
 * Pad the element's right side by it: padding never moves the element's own
 * box, so the measurement cannot chase itself.
 */
export function useEdgeTabClearance(ref: React.RefObject<HTMLElement | null>): number {
  const [right, setRight] = useState(0);

  useEffect(() => {
    let raf = 0;
    const measure = () => {
      const el = ref.current;
      const tab = document.querySelector('[data-edge-tab]');
      let next = 0;
      if (el && tab) {
        const z = parseFloat(el.closest('[data-layout-zoom]')?.getAttribute('data-layout-zoom') ?? '') || 1;
        const tz = parseFloat(tab.closest('[data-layout-zoom]')?.getAttribute('data-layout-zoom') ?? '') || 1;
        const e = el.getBoundingClientRect();
        const t = tab.getBoundingClientRect();
        const left = Math.min(t.left, t.right - EDGE_TAB_HOVER_PX * tz);
        const overlapY = Math.min(t.bottom, e.bottom) - Math.max(t.top, e.top);
        if (t.height > 0 && e.width > 0 && overlapY >= 1 && left < e.right && t.right > e.left) {
          next = Math.ceil((e.right - left) / z + ORB_GAP);
        }
      }
      setRight((prev) => (prev === next ? prev : next));
    };
    const schedule = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(measure);
    };
    schedule();
    const el = ref.current;
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    if (ro && el) {
      ro.observe(el);
      // The dock grows upward: its height changes while the strip keeps its size and only moves.
      const scope = el.closest('[data-keyscope]');
      if (scope && scope !== el) ro.observe(scope);
    }
    window.addEventListener('resize', schedule);
    const poll = window.setInterval(schedule, 1000);
    return () => {
      cancelAnimationFrame(raf);
      window.clearInterval(poll);
      window.removeEventListener('resize', schedule);
      ro?.disconnect();
    };
  }, [ref]);

  return right;
}

/* ── flyouts ────────────────────────────────────────────────────────────── */

export type FlyoutPlacement = 'right' | 'above' | 'below';

/** The least room a floor may leave a below card; with less, the card keeps its own height. */
const FLOOR_MIN_PX = 80;

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const isShown = (el: HTMLElement) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';

/** Focusable, rendered elements inside `root`, in document order. */
const focusablesIn = (root: HTMLElement): HTMLElement[] =>
  Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(isShown);

const menuItemsIn = (root: HTMLElement): HTMLElement[] =>
  Array.from(root.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])')).filter(isShown);

/** The first tabbable element after `ref` in document order, skipping `ref`'s
 *  own subtree and the (portaled) card. */
const nextTabbableAfter = (ref: HTMLElement, card: HTMLElement): HTMLElement | null => {
  for (const el of document.querySelectorAll<HTMLElement>(FOCUSABLE)) {
    if (el.tabIndex < 0 || card.contains(el) || ref.contains(el)) continue;
    if (!(ref.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
    if (isShown(el)) return el;
  }
  return null;
};

interface DockFlyoutProps {
  open: boolean;
  anchorRef: React.RefObject<HTMLElement | null>;
  /** Where focus goes back to when the card closes, and the control whose Tab
   *  leads into the card. Defaults to the anchor; pass it when the anchor is not
   *  itself focusable (the REC key's wrapper). */
  returnFocusRef?: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  placement: FlyoutPlacement;
  /** For above/below: line the card's start or end up with the anchor's. */
  align?: 'start' | 'end';
  /** False keeps the card open through outside clicks (the MIDI mapper's LEARN
   *  waits on a hardware knob, not a click). Escape and the anchor still close it. */
  closeOnOutside?: boolean;
  /** For `above`: the card's top stays below the lowest bottom edge of the
   *  shown elements matching this selector inside the anchor's
   *  `[data-keyscope]` (the roll's ruler and the Voice header). A card taller
   *  than the room left scrolls. */
  ceilingSelector?: string;
  /** The card's bottom stays 4px above the nearest top edge of the shown
   *  elements matching this selector that are not wholly above the anchor,
   *  inside the anchor's `[data-keyscope]` (the SHAPE row). A `below` card
   *  taller than the room scrolls; an `above` card from a key inside the row
   *  rises clear of the row's top edge; a `right` card clamped down onto the
   *  row rises clear of it. */
  floorSelector?: string;
  /** Shown elements matching this selector inside the anchor's `[data-keyscope]`
   *  (the Voice column, the artifact rail) that the card keeps off: a card that
   *  would cover one moves to its left. */
  asideSelector?: string;
  id?: string;
  /** `menu` gets arrow-key movement between its `menuitem`s, and Tab leaves it. */
  role?: string;
  /** The element the card portals into, in place of the anchor's nearest
   *  `.edit-theme-scope`. For an anchor whose scope is a containing block for
   *  fixed descendants (the footer's backdrop blur) the card would be placed
   *  against that box. The element must cover the viewport: the card clamps
   *  itself to its box. */
  portalInto?: HTMLElement | null;
  'aria-label'?: string;
  className?: string;
  children: React.ReactNode;
}

/**
 * A card that opens beside its anchor and is never clipped by the dock.
 *
 * The dock body is `overflow-hidden` and only a few hundred pixels tall, so a
 * popover rendered in place loses its bottom half. The card portals into the
 * nearest `.edit-theme-scope` (the Shell root), which keeps the theme's tokens
 * and ink remaps, and positions itself `fixed`. That root carries CSS `zoom`,
 * and inside it both `getBoundingClientRect()` (viewport px) and a fixed
 * element's `left/top` (scaled by the zoom) disagree by that factor, so every
 * coordinate is divided by the root's published `data-layout-zoom`.
 *
 * Portaled, the card is the last thing in the app's DOM, so keyboard order is
 * put back by hand: opening moves focus to the card's first control, Tab from
 * the trigger enters the card, Tab past its last control lands on whatever
 * follows the trigger, Shift+Tab before its first returns to the trigger, and
 * closing hands focus back to the trigger when it was inside the card. Escape
 * acts only when focus is in the card or on its trigger.
 */
export const DockFlyout: React.FC<DockFlyoutProps> = ({
  open,
  anchorRef,
  returnFocusRef,
  onClose,
  placement,
  align = 'start',
  closeOnOutside = true,
  ceilingSelector,
  floorSelector,
  asideSelector,
  id,
  role,
  portalInto,
  'aria-label': ariaLabel,
  className = '',
  children,
}) => {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  /** The card's height cap in CSS px while a ceiling leaves it too little room; null = its own height. */
  const [maxH, setMaxH] = useState<number | null>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  // Focus bookkeeping: whether focus was last inside the card, whether this
  // open already placed focus, and whether the close was an outside click
  // (which must not pull focus back to the trigger).
  const focusInCardRef = useRef(false);
  const placedFocusRef = useRef(false);
  const skipReturnRef = useRef(false);

  useLayoutEffect(() => {
    if (!open) {
      setHost(null);
      setPos(null);
      return;
    }
    const anchor = anchorRef.current;
    setHost(portalInto ?? (anchor?.closest('.edit-theme-scope') as HTMLElement | null) ?? document.body);
  }, [open, anchorRef, portalInto]);

  const place = useCallback(() => {
    const anchor = anchorRef.current;
    const card = cardRef.current;
    if (!anchor || !card || !host) return;
    const z = parseFloat(host.getAttribute('data-layout-zoom') ?? '') || 1;
    const a = anchor.getBoundingClientRect();
    const c = card.getBoundingClientRect();
    const ax = a.left / z;
    const ay = a.top / z;
    const aw = a.width / z;
    const ah = a.height / z;
    const cw = c.width / z;
    let ch = c.height / z;
    const hostRect = host === document.body ? null : host.getBoundingClientRect();
    const maxX = (hostRect ? hostRect.right : window.innerWidth) / z;
    const maxY = (hostRect ? hostRect.bottom : window.innerHeight) / z;
    const gap = 4;
    const pad = 6;
    const scope = anchor.closest('[data-keyscope]') ?? document;
    /** The shown boxes matching `sel` inside the anchor's key scope, in the host's zoomed px. */
    const shown = (sel: string): TipBounds[] =>
      Array.from(scope.querySelectorAll<HTMLElement>(sel))
        .map((el) => el.getBoundingClientRect())
        .filter((r) => r.width > 0 && r.height > 0)
        .map((r) => ({ left: r.left / z, top: r.top / z, right: r.right / z, bottom: r.bottom / z }));
    const floors = floorSelector ? shown(floorSelector) : [];
    // The lowest the card's bottom may reach: 4px above the SHAPE row, for a key
    // inside the row as much as for one above it. It depends only on where the
    // anchor and the floor are, never on the card.
    const floorEdge = floorSelector ? floorLimit(ay, floors, gap) : null;
    // An above card ends `gap` over its anchor, or over the floor that holds it.
    const aboveBottom = floorEdge == null ? ay - gap : Math.min(ay - gap, floorEdge);
    // A ceiling caps an above card at the room between the ceiling and that
    // bottom. The card's own height is read from its content (scrollHeight plus
    // its borders, both unzoomed), so a cap already applied never feeds back.
    let cap: number | null = null;
    if (ceilingSelector && placement === 'above') {
      const ceiling = Math.max(-Infinity, ...shown(ceilingSelector).map((r) => r.bottom));
      const natural = card.scrollHeight + (card.offsetHeight - card.clientHeight);
      if (Number.isFinite(ceiling)) {
        const room = Math.floor(aboveBottom - (ceiling + gap));
        if (natural > room && room > 0) cap = room;
      }
      ch = cap ?? natural;
    }
    // A floor caps a below card at the room down to it; a card shorter than the
    // room is untouched by it.
    if (floorSelector && placement === 'below') {
      cap = floorCap(ay + ah + gap, floors.map((r) => r.top), gap, FLOOR_MIN_PX);
      if (cap != null) ch = Math.min(ch, cap);
    }
    setMaxH((prev) => (prev === cap ? prev : cap));
    let x: number;
    let y: number;
    if (placement === 'right') {
      x = ax + aw + gap;
      // A right card only rises off the floor, never takes a cap: a card with a
      // scrolling list inside would shrink under a cap and read shorter next time.
      y = floorEdge == null ? ay : Math.min(ay, floorEdge - ch);
    } else {
      x = align === 'end' ? ax + aw - cw : ax;
      y = placement === 'above' ? aboveBottom - ch : ay + ah + gap;
    }
    x = Math.max(pad, Math.min(x, maxX - cw - pad));
    y = Math.max(pad, Math.min(y, maxY - ch - pad));
    // The orb paints over every dock layer and takes the pointer, so a card
    // clamped down onto it (IMPORT's, from the rail's foot) moves up clear of it.
    const minX = (hostRect ? Math.max(0, hostRect.left) : 0) / z;
    const minY = (hostRect ? Math.max(0, hostRect.top) : 0) / z;
    const inside = { left: minX, top: minY, right: maxX, bottom: maxY };
    // Side columns the card would cover (the Voice column under MAP) push it left.
    // A column that holds the anchor itself is never one to clear.
    if (asideSelector) {
      const asides = shown(asideSelector).filter((r) => !(ax >= r.left && ax + aw <= r.right && ay >= r.top && ay + ah <= r.bottom));
      ({ x, y } = clearAsides({ x, y }, { width: cw, height: ch }, asides, inside, gap, pad));
    }
    ({ x, y } = clearObstacle({ x, y }, { width: cw, height: ch }, orbBounds(z), inside, gap, pad));
    setPos((prev) => (prev && Math.abs(prev.x - x) < 0.5 && Math.abs(prev.y - y) < 0.5 ? prev : { x, y }));
  }, [anchorRef, host, placement, align, ceilingSelector, floorSelector, asideSelector]);

  useLayoutEffect(() => {
    if (!open || !host) return;
    place();
    const card = cardRef.current;
    const ro = typeof ResizeObserver === 'undefined' || !card ? null : new ResizeObserver(() => place());
    if (ro && card) ro.observe(card);
    window.addEventListener('resize', place);
    // A scroll anywhere (the rail, the dock) moves the anchor.
    window.addEventListener('scroll', place, true);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, host, place]);

  // Opening moves focus into the card, once it is placed (a hidden card cannot
  // take focus). A menu focuses its first enabled item.
  useEffect(() => {
    if (!open) {
      placedFocusRef.current = false;
      return;
    }
    if (!pos || placedFocusRef.current) return;
    const card = cardRef.current;
    if (!card) return;
    placedFocusRef.current = true;
    const first = (role === 'menu' ? menuItemsIn(card) : focusablesIn(card))[0];
    (first ?? card).focus({ preventScroll: true });
  }, [open, pos, role]);

  // Track whether focus is inside the card, and hand it back to the trigger on
  // close. The cleanup runs after the card has left the DOM, so focus that was
  // inside it has fallen to <body>; focus someone else took is left alone.
  useEffect(() => {
    if (!open) return;
    skipReturnRef.current = false;
    const onFocusIn = (e: FocusEvent) => {
      focusInCardRef.current = !!cardRef.current?.contains(e.target as Node);
    };
    document.addEventListener('focusin', onFocusIn);
    return () => {
      document.removeEventListener('focusin', onFocusIn);
      const had = focusInCardRef.current;
      focusInCardRef.current = false;
      if (!had || skipReturnRef.current) return;
      const active = document.activeElement;
      if (active && active !== document.body && active.isConnected) return;
      (returnFocusRef?.current ?? anchorRef.current)?.focus({ preventScroll: true });
    };
  }, [open, anchorRef, returnFocusRef]);

  useEffect(() => {
    if (!open) return;
    const trigger = () => returnFocusRef?.current ?? anchorRef.current;
    const inTrigger = (n: Node | null) =>
      !!n && (!!anchorRef.current?.contains(n) || !!returnFocusRef?.current?.contains(n));

    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (cardRef.current?.contains(t) || inTrigger(t)) return;
      skipReturnRef.current = true;
      onCloseRef.current();
    };

    /** Leave the card by keyboard: back to the trigger, or on to what follows it. */
    const leave = (back: boolean) => {
      const card = cardRef.current;
      const t = trigger();
      const target = back ? t : t && card ? nextTabbableAfter(t, card) : null;
      if (closeOnOutside) {
        skipReturnRef.current = true;
        onCloseRef.current();
      }
      target?.focus();
    };

    const onKey = (e: KeyboardEvent) => {
      const card = cardRef.current;
      if (!card) return;
      const active = document.activeElement;
      const inCard = card.contains(e.target as Node) || card.contains(active);

      if (e.key === 'Escape') {
        // Only an Escape meant for this card: pressed inside it, on its trigger,
        // or with focus nowhere (a click-opened card). A mapper left open while
        // the user works elsewhere ignores Escapes aimed at other things.
        const nowhere = closeOnOutside && (!active || active === document.body);
        if (!inCard && !inTrigger(e.target as Node) && !inTrigger(active) && !nowhere) return;
        skipReturnRef.current = true;
        onCloseRef.current();
        trigger()?.focus({ preventScroll: true });
        return;
      }

      if (e.key === 'Tab' && !e.altKey && !e.ctrlKey && !e.metaKey) {
        if (!inCard) {
          // The card reads as the next thing after its trigger.
          const t = trigger();
          if (!e.shiftKey && t && active === t) {
            const first = (role === 'menu' ? menuItemsIn(card) : focusablesIn(card))[0];
            if (first) {
              e.preventDefault();
              first.focus();
            }
          }
          return;
        }
        if (role === 'menu') {
          e.preventDefault();
          leave(e.shiftKey);
          return;
        }
        const items = focusablesIn(card);
        const i = items.indexOf(active as HTMLElement);
        if (!e.shiftKey && (items.length === 0 || i === items.length - 1)) {
          e.preventDefault();
          leave(false);
        } else if (e.shiftKey && i <= 0) {
          e.preventDefault();
          leave(true);
        } else if (!e.shiftKey && i === -1) {
          e.preventDefault();
          items[0].focus();
        }
        return;
      }

      if (role === 'menu' && inCard && (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End')) {
        const items = menuItemsIn(card);
        if (items.length === 0) return;
        e.preventDefault();
        const i = items.indexOf(active as HTMLElement);
        const last = items.length - 1;
        const next =
          e.key === 'Home' ? 0 : e.key === 'End' ? last : e.key === 'ArrowDown' ? (i >= last ? 0 : i + 1) : i <= 0 ? last : i - 1;
        items[next].focus();
      }
    };

    if (closeOnOutside) window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, closeOnOutside, anchorRef, returnFocusRef, role]);

  if (!open || !host) return null;
  return createPortal(
    <div
      ref={cardRef}
      id={id}
      role={role}
      aria-label={ariaLabel}
      tabIndex={-1}
      className={`fixed z-200 ${className}`}
      style={{
        left: pos?.x ?? -9999,
        top: pos?.y ?? -9999,
        visibility: pos ? 'visible' : 'hidden',
        ...(maxH != null ? { maxHeight: maxH, overflowY: 'auto' as const } : {}),
      }}
    >
      {children}
    </div>,
    host,
  );
};
