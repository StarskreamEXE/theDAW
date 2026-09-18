/**
 * A side rail that folds to a thin strip, so the view beside it can take the
 * whole width.
 *
 * Folded, the rail is a 32px strip with its name written down it, and the
 * whole strip is one button: a click anywhere on it opens the rail. Open, the
 * rail hands its fold key to the caller, who puts it in the rail's own header
 * at the INNER edge (the side that meets the view), so the pointer travels as
 * little as possible between reading the view and folding the rail.
 *
 * The rail stays mounted while folded (it is only hidden), so whatever it
 * holds keeps its state. Whether it is folded is remembered per viewer under
 * `storageKey`.
 */
import React, { useState } from 'react';
import { ChevronsLeft, ChevronsRight } from 'lucide-react';

const readFolded = (key: string): boolean => {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
};

/** The fold key's look, shared by the key in the header and the chevron on
 *  the strip. */
const KEY_BOX =
  'size-7 shrink-0 rounded border border-white/15 flex items-center justify-center et-ink-2 transition-colors';

export const CollapsibleRail: React.FC<{
  /** The open rail's element id, which both keys point at. */
  id: string;
  /** Which edge of the view the rail sits on. */
  side: 'left' | 'right';
  /** What the folded strip says, written down it. */
  name: string;
  /** What the rail is, for the keys' labels ("the notation rail"). */
  label: string;
  /** Where the folded state is remembered. */
  storageKey: string;
  /** The open rail's width, border and ground. */
  className: string;
  /** The open rail's element: an `aside` when it is the view's side panel. */
  as?: 'div' | 'aside';
  /** The rail's contents, given the fold key to place at the inner edge of
   *  its header. */
  children: (foldKey: React.ReactNode) => React.ReactNode;
}> = ({ id, side, name, label, storageKey, className, as: Rail = 'div', children }) => {
  const [folded, setFolded] = useState(() => readFolded(storageKey));
  const setAndRemember = (next: boolean) => {
    setFolded(next);
    try {
      localStorage.setItem(storageKey, next ? '1' : '0');
    } catch {
      /* private mode: the state still holds for this session */
    }
  };

  // The chevrons point the way the rail will move: toward the edge to fold,
  // away from it to open.
  const FoldIcon = side === 'left' ? ChevronsLeft : ChevronsRight;
  const OpenIcon = side === 'left' ? ChevronsRight : ChevronsLeft;

  const foldKey = (
    <button
      type="button"
      className={`${KEY_BOX} hover:border-[rgb(var(--et-accent)/0.5)] hover:et-ink outline-none focus-visible:ring-1 focus-visible:ring-[rgb(var(--et-accent)/0.6)]`}
      onClick={() => setAndRemember(true)}
      aria-expanded={true}
      aria-controls={id}
      aria-label={`Hide ${label}`}
      title={`Hide ${label}`}
    >
      <FoldIcon className="size-3.5" aria-hidden="true" />
    </button>
  );

  return (
    <>
      {folded && (
        <button
          type="button"
          className={`group w-8 shrink-0 flex flex-col items-center gap-3 py-1.5 bg-black/30 border-white/15 ${
            side === 'left' ? 'border-r' : 'border-l'
          } et-ink-2 transition-colors hover:bg-white/5 hover:et-ink outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[rgb(var(--et-accent)/0.6)]`}
          onClick={() => setAndRemember(false)}
          aria-expanded={false}
          aria-controls={id}
          aria-label={`Show ${label}`}
          title={`Show ${label}`}
        >
          <span className={`${KEY_BOX} group-hover:border-[rgb(var(--et-accent)/0.5)] group-hover:et-ink`} aria-hidden="true">
            <OpenIcon className="size-3.5" />
          </span>
          <span className="font-display text-xs font-bold uppercase [writing-mode:vertical-rl] select-none" aria-hidden="true">
            {name}
          </span>
        </button>
      )}
      <Rail id={id} hidden={folded} className={className}>
        {children(foldKey)}
      </Rail>
    </>
  );
};
