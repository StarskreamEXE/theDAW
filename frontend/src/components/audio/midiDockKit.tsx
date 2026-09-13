/**
 * The MIDI dock's key grammar and its flyout.
 *
 * One module so the settings strip, the action rail, the SHAPE row and the
 * Vocal2MIDI header draw every key from the same four states:
 *
 *   rest       a 10% tile with a 1px etched top highlight and a transparent
 *              bottom edge, secondary theme ink; hover brightens with an inset
 *              fill (never a `hover:bg-*`: `bg-white/10` is theme-remapped by an
 *              unlayered rule that a layered hover utility cannot beat).
 *   on         the theme accent (`--et-accent`, the footer transport's latched
 *              ink) and a 1px accent bottom edge. No glow.
 *   recording  red ink, a red bottom edge and a soft red glow. The only key
 *              that glows.
 *   disabled   the cap stays; its glyph and legend drop to 40% (`disabled:*:`),
 *              so every glyph and legend must be an element, never a bare text
 *              node.
 *
 * The bottom edge is always a `border-b` (transparent at rest) so latching a key
 * never shifts the layout, and no key carries a `border-white/N` class: the
 * theme scope floors those to a hard 3:1 line on controls.
 */
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

const KEY_CORE =
  'relative select-none border-b transition-[color,box-shadow,border-color] duration-100 active:shadow-[inset_0_1px_2px_rgba(0,0,0,0.7)] focus-visible:z-10 disabled:cursor-default disabled:*:opacity-40';

export const KEY_REST =
  'bg-white/10 et-ink-2 enabled:hover:et-ink border-b-transparent shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] enabled:hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.1),inset_0_0_0_100px_rgba(255,255,255,0.06)]';
export const KEY_ON =
  'bg-white/10 text-[rgb(var(--et-accent))] border-b-[rgb(var(--et-accent))] shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] enabled:hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.1),inset_0_0_0_100px_rgba(255,255,255,0.06)]';
export const KEY_REC =
  'bg-white/10 text-red-300 border-b-red-500 shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_0_10px_rgba(239,68,68,0.45)]';
/** The transport PLAY key at rest: primary ink, one step brighter than a key. */
export const KEY_PLAY_REST =
  'bg-white/10 et-ink border-b-transparent shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] enabled:hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.1),inset_0_0_0_100px_rgba(255,255,255,0.08)]';

export const keyTone = (s: { on?: boolean; rec?: boolean }): string =>
  s.rec ? KEY_REC : s.on ? KEY_ON : KEY_REST;

/** A key in the 28px strip or the 30px SHAPE row: icon + one-word legend. */
export const STRIP_KEY = `${KEY_CORE} h-5.5 shrink-0 inline-flex items-center gap-1 px-1.5 rounded-xs text-[9px] font-mono font-semibold uppercase tracking-wider whitespace-nowrap`;
/** An icon-only strip key (zoom, the song menu chevron). */
export const STRIP_ICON_KEY = `${KEY_CORE} h-5.5 w-5.5 shrink-0 inline-flex items-center justify-center rounded-xs`;
/** A 16px key that sits inside a field, a flyout or the 22px Voice header. */
export const MINI_KEY = `${KEY_CORE} h-4 shrink-0 inline-flex items-center gap-1 px-1 rounded-xs text-[8px] font-mono font-semibold uppercase tracking-wider whitespace-nowrap`;
export const MINI_ICON_KEY = `${KEY_CORE} h-4 w-4 shrink-0 inline-flex items-center justify-center rounded-xs`;
/** A key in the left action rail: icon over a 7px legend, 24px tall. Inside a
 *  rail marked `data-compact` (a dock too short for every key at full height)
 *  it drops to 22px, which still holds the 12px glyph and the legend. */
export const RAIL_KEY = `${KEY_CORE} h-6 group-data-compact/rail:h-5.5 w-full flex flex-col items-center justify-center gap-px rounded-xs`;
export const RAIL_LEGEND = 'text-[7px] font-mono font-semibold uppercase leading-none';

/** A labelled value well: legend, control, readout. */
export const FIELD =
  'h-5.5 shrink-0 inline-flex items-center gap-1 px-1.5 rounded-xs bg-black/40 border border-white/10';
export const FIELD_LEGEND = 'text-[8px] font-mono font-semibold uppercase tracking-wider et-ink-3 leading-none';
export const FIELD_VALUE = 'text-[10px] font-mono et-ink tabular-nums leading-none text-right';
export const RANGE = 'w-14 h-3 accent-[rgb(var(--et-accent))] cursor-pointer';
/** A native <select> sized for the strip and the SHAPE row. */
export const DOCK_SELECT = 'form-select h-5.5 shrink-0 px-1 text-[10px] font-mono';
/** A flyout card: the popup surface, a themed hairline, a drop shadow. */
export const FLYOUT_CARD =
  'bg-[#0a080f] border border-white/10 rounded-sm shadow-[0_8px_32px_rgba(0,0,0,0.75)]';

export const Sep: React.FC = () => <span aria-hidden="true" className="w-px h-3.5 shrink-0 bg-white/10" />;

type RailKeyProps = Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & {
  icon: React.ReactNode;
  legend: string;
  on?: boolean;
  rec?: boolean;
};

/** One rail key. The legend is decorative; `aria-label` carries the name and
 *  must contain the legend word (label-in-name). */
export const RailKey = React.forwardRef<HTMLButtonElement, RailKeyProps>(
  ({ icon, legend, on, rec, className = '', type = 'button', ...rest }, ref) => (
    <button ref={ref} type={type} {...rest} className={`${RAIL_KEY} ${keyTone({ on, rec })} ${className}`}>
      <span aria-hidden="true" className="flex">{icon}</span>
      <span aria-hidden="true" className={RAIL_LEGEND}>{legend}</span>
    </button>
  ),
);
RailKey.displayName = 'RailKey';

type StripKeyProps = Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & {
  icon?: React.ReactNode;
  legend: string;
  on?: boolean;
  rec?: boolean;
};

export const StripKey = React.forwardRef<HTMLButtonElement, StripKeyProps>(
  ({ icon, legend, on, rec, className = '', type = 'button', ...rest }, ref) => (
    <button ref={ref} type={type} {...rest} className={`${STRIP_KEY} ${keyTone({ on, rec })} ${className}`}>
      {icon && <span aria-hidden="true" className="flex">{icon}</span>}
      <span>{legend}</span>
    </button>
  ),
);
StripKey.displayName = 'StripKey';

/**
 * A small corner target laid over a rail key (the REC key's input menu, the
 * SAVE key's UNLINK). A sibling of the key, never a child: a button cannot hold
 * a button.
 */
export const CORNER_KEY =
  'absolute top-0 right-0 z-10 w-3 h-3 flex items-center justify-center rounded-xs et-ink-3 hover:et-ink hover:shadow-[inset_0_0_0_100px_rgba(255,255,255,0.12)]';

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

/* ── flyouts ────────────────────────────────────────────────────────────── */

export type FlyoutPlacement = 'right' | 'above' | 'below';

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
  id?: string;
  /** `menu` gets arrow-key movement between its `menuitem`s, and Tab leaves it. */
  role?: string;
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
  id,
  role,
  'aria-label': ariaLabel,
  className = '',
  children,
}) => {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
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
    setHost((anchor?.closest('.edit-theme-scope') as HTMLElement | null) ?? document.body);
  }, [open, anchorRef]);

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
    const ch = c.height / z;
    const hostRect = host === document.body ? null : host.getBoundingClientRect();
    const maxX = (hostRect ? hostRect.right : window.innerWidth) / z;
    const maxY = (hostRect ? hostRect.bottom : window.innerHeight) / z;
    const gap = 4;
    const pad = 6;
    let x: number;
    let y: number;
    if (placement === 'right') {
      x = ax + aw + gap;
      y = ay;
    } else {
      x = align === 'end' ? ax + aw - cw : ax;
      y = placement === 'above' ? ay - ch - gap : ay + ah + gap;
    }
    x = Math.max(pad, Math.min(x, maxX - cw - pad));
    y = Math.max(pad, Math.min(y, maxY - ch - pad));
    setPos((prev) => (prev && Math.abs(prev.x - x) < 0.5 && Math.abs(prev.y - y) < 0.5 ? prev : { x, y }));
  }, [anchorRef, host, placement, align]);

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
      style={{ left: pos?.x ?? -9999, top: pos?.y ?? -9999, visibility: pos ? 'visible' : 'hidden' }}
    >
      {children}
    </div>,
    host,
  );
};
