import React, { useEffect, useMemo, useState } from 'react';
import { useStatusNoticeStore } from '../../state/statusNoticeStore';
import { useEditThemeStore } from '../../state/editThemeStore';
import { resolveEditThemeVars } from '../../lib/editThemes';
import { BUBBLE_TONE, bubbleText, noticeLabel, noticeSurface, useShownNotice } from './OrbTipBubble';

/**
 * The orb's status bubble below the xl breakpoint.
 *
 * The footer speech bubble (OrbTipBubble) is hidden under 1280px wide, and the
 * orb is on screen at every width. Below xl this bubble floats by the orb while
 * a status notice is up, so a status shows on screen as well as in the LOG. It
 * renders nothing while no notice is up. The live region that announces
 * notices is OrbTipBubble's, which stays mounted at every width.
 *
 * Where it sits (floatPlacement):
 * - With the orb in the footer's bottom-left corner (where it is pinned until
 *   its first click), the bubble sits in the footer row right of the orb, over
 *   the now-playing title, and grows upward. The page's controls above the
 *   footer stay clickable.
 * - With the orb anywhere else, it sits above the orb, clear of the sign a
 *   pinned orb wears above itself, or below the orb when the orb is near the
 *   top of the window. It stays inside the viewport.
 *
 * The bubble and its tail are the theme's opaque popup surface with the tone's
 * tint laid over it (noticeSurface). App mounts the orb outside Shell, so this
 * carries the theme scope itself. The scope's root rule paints --et-root-bg, so
 * the wrapper clears its background.
 */

interface OrbStatusFloatProps {
  /** The orb box's top-left corner, as GantasmoOrb reports it. */
  position: { x: number; y: number };
  /** The orb box's size in px. */
  orbBox: number;
  /** Open the LOG. A click on the bubble calls it. */
  onOpenLog?: () => void;
}

/** w-60 */
const WIDTH = 240;
const MIN_WIDTH = 160;
const EDGE = 8;
/** Room above the orb for the "Click me" sign a pinned orb wears there. */
const SIGN_ROOM = 36;
/** An orb whose top is above this line gets the bubble underneath it. */
const ROOM_ABOVE = 140;
/** The footer's height (PlayerFooter h-16): an orb whose box reaches into it rests on the footer. */
const FOOTER_H = 64;
/** An orb whose left edge is this close to the window's left edge is in the footer corner. */
const CORNER_X = 48;
/**
 * Room the bubble leaves between the window's centre line and its right edge:
 * half the transport, the footer grid's gap, and the like and menu buttons
 * that end the now-playing track.
 */
const CENTRE_CLEARANCE = 170;

export type FloatPlacement =
  | { kind: 'footer'; left: number; width: number }
  | { kind: 'above'; left: number; bottom: number; tailLeft: number }
  | { kind: 'below'; left: number; top: number; tailLeft: number };

/** Where the bubble goes for an orb at `position` in a window of `viewport`. */
export function floatPlacement(
  position: { x: number; y: number },
  orbBox: number,
  viewport: { width: number; height: number },
): FloatPlacement {
  if (position.x <= CORNER_X && position.y + orbBox >= viewport.height - FOOTER_H) {
    const left = Math.max(0, position.x) + orbBox + EDGE;
    const width = Math.max(MIN_WIDTH, Math.min(WIDTH, viewport.width / 2 - CENTRE_CLEARANCE - left));
    return { kind: 'footer', left, width };
  }
  const left = Math.max(EDGE, Math.min(viewport.width - WIDTH - EDGE, position.x));
  const tailLeft = Math.max(12, Math.min(WIDTH - 20, position.x + orbBox / 2 - left - 4));
  return position.y >= ROOM_ABOVE
    ? { kind: 'above', left, bottom: viewport.height - position.y + SIGN_ROOM, tailLeft }
    : { kind: 'below', left, top: position.y + orbBox + EDGE, tailLeft };
}

export const OrbStatusFloat: React.FC<OrbStatusFloatProps> = ({ position, orbBox, onOpenLog }) => {
  const [hovered, setHovered] = useState(false);
  const [notice, release] = useShownNotice(hovered);
  const themeId = useEditThemeStore((s) => s.themeId);
  const themeImage = useEditThemeStore((s) => s.customImage);
  const theme = useMemo(() => resolveEditThemeVars(themeId, themeImage), [themeId, themeImage]);

  // The button leaves the page with its notice, and a button that leaves the
  // page under the pointer never gets its mouseleave. A hover left set would
  // hold every later notice on screen past its time.
  useEffect(() => {
    if (!notice) setHovered(false);
  }, [notice]);

  if (!notice || typeof window === 'undefined') return null;

  const place = floatPlacement(position, orbBox, { width: window.innerWidth, height: window.innerHeight });
  const tone = BUBBLE_TONE[notice.level];
  const surface = noticeSurface(tone);

  const style: React.CSSProperties = {
    ...(theme.vars as React.CSSProperties),
    background: 'transparent',
    left: place.left,
  };
  let frame: string;
  let tail: string;
  let tailStyle: React.CSSProperties | undefined;
  if (place.kind === 'footer') {
    style.bottom = 0;
    style.width = place.width;
    frame = 'min-h-12 flex flex-col justify-center';
    tail = '-left-1 top-1/2 -translate-y-1/2 border-b border-l';
  } else if (place.kind === 'above') {
    style.bottom = place.bottom;
    frame = 'w-60 max-w-[calc(100vw-16px)]';
    tail = '-bottom-1 border-r border-b';
    tailStyle = { left: place.tailLeft };
  } else {
    style.top = place.top;
    frame = 'w-60 max-w-[calc(100vw-16px)]';
    tail = '-top-1 border-t border-l';
    tailStyle = { left: place.tailLeft };
  }

  return (
    <div
      className={`edit-theme-scope fixed z-60 xl:hidden ${frame}`}
      data-et-light={theme.light ? '1' : undefined}
      data-placement={place.kind}
      style={style}
    >
      <button
        type="button"
        aria-label={noticeLabel(notice, Boolean(onOpenLog))}
        title={notice.text}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onClick={() => {
          setHovered(false);
          release();
          useStatusNoticeStore.getState().dismiss();
          onOpenLog?.();
        }}
        className={`relative block w-full text-left rounded-2xl border px-3 py-1.5 cursor-pointer ${surface}`}
      >
        {/* The tail points at the orb. */}
        <span aria-hidden="true" className={`absolute size-2 rotate-45 ${tail} ${surface}`} style={tailStyle} />
        <span className={`flex items-start gap-1.5 text-xs font-semibold leading-4 ${tone.text}`}>
          <span aria-hidden="true" className={`mt-1 size-2 shrink-0 rounded-full ${tone.dot}`} />
          <span className="min-w-0 line-clamp-4 wrap-anywhere">{bubbleText(notice.text)}</span>
        </span>
      </button>
    </div>
  );
};

export default OrbStatusFloat;
