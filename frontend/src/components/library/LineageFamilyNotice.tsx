/**
 * The lineage family a library panel shows, and the line that says when the
 * screen route cut it.
 *
 * INFO, the asset inspector and the catalogue each list a song's relatives
 * from `/api/library/{id}/lineage`, which stops at the server's node cap. This
 * hook reads that answer and, on request, the whole family from
 * `/lineage/full`; the notice says the family was cut and offers the whole
 * one, so a count of relatives is never a count of the first 600 posing as
 * the family.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Network } from 'lucide-react';
import { readFamily, readWholeFamily, type FamilyRead } from '../../lib/lineageFamily';

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export interface LineageFamilyState {
  /** The family as last read for this song, or null until a read lands. */
  family: FamilyRead | null;
  /** The screen read is in flight. */
  loading: boolean;
  /** The screen read failed, with the reason. */
  error: string | null;
  /** The whole family is being read. */
  wholeBusy: boolean;
  /** Reading the whole family failed, with the reason. */
  wholeError: string | null;
  /** Read the whole family, replacing the capped one when it lands. */
  loadWhole: () => void;
}

interface Held {
  entryId: string;
  family: FamilyRead | null;
  error: string | null;
}

interface WholeHeld {
  entryId: string;
  busy: boolean;
  error: string | null;
}

/**
 * The family of `entryId` within `depth` generations. `enabled` false holds
 * the read back (a panel whose tab is not shown); what was read for a song is
 * kept until the song changes. Every answer is tagged with the song it was
 * asked for, so one that lands after the panel moved on is never shown.
 */
export function useLineageFamily(entryId: string | null, depth: number, enabled = true): LineageFamilyState {
  const [held, setHeld] = useState<Held | null>(null);
  const [whole, setWhole] = useState<WholeHeld | null>(null);
  const shownRef = useRef(entryId);
  shownRef.current = entryId;

  const current = held && held.entryId === entryId ? held : null;

  useEffect(() => {
    if (!entryId || !enabled || current) return undefined;
    let live = true;
    readFamily(entryId, depth).then(
      (family) => {
        if (live) setHeld({ entryId, family, error: null });
      },
      (e: unknown) => {
        if (live) setHeld({ entryId, family: null, error: message(e) });
      },
    );
    return () => {
      live = false;
    };
  }, [entryId, depth, enabled, current]);

  const loadWhole = useCallback(() => {
    if (!entryId) return;
    const asked = entryId;
    setWhole({ entryId: asked, busy: true, error: null });
    readWholeFamily(asked, depth).then(
      (read) => {
        if (shownRef.current !== asked) return;
        setHeld({ entryId: asked, family: read.family, error: null });
        setWhole({ entryId: asked, busy: false, error: null });
      },
      (e: unknown) => {
        if (shownRef.current !== asked) return;
        setWhole({ entryId: asked, busy: false, error: message(e) });
      },
    );
  }, [entryId, depth]);

  const wholeNow = whole && whole.entryId === entryId ? whole : null;
  return {
    family: current?.family ?? null,
    loading: Boolean(entryId) && enabled && !current,
    error: current?.error ?? null,
    wholeBusy: wholeNow?.busy ?? false,
    wholeError: wholeNow?.error ?? null,
    loadWhole,
  };
}

const LOAD_KEY =
  'flex items-center gap-1.5 rounded border border-amber-400/40 px-2 py-1 text-xs font-bold text-amber-100 transition-colors hover:border-amber-300/70 hover:text-white disabled:opacity-60';

/**
 * One line about how much of the family is on screen, or nothing when all of
 * it is and there is nothing to say.
 *
 *  * capped: the nearest N of a larger family, and the key that loads the
 *    whole family.
 *  * deeper than the depth: relatives further out are not listed. Loading the
 *    whole family walks the same depth, so no key is offered for this.
 *  * the whole family, loaded on request: says so, so the press visibly did
 *    something.
 */
export const LineageFamilyNotice: React.FC<{
  family: FamilyRead;
  busy: boolean;
  error: string | null;
  onLoadWhole: () => void;
}> = ({ family, busy, error, onLoadWhole }) => {
  const shown = family.nodes.length.toLocaleString('en-US');
  if (family.capped) {
    return (
      <div role="status" className="flex flex-col gap-1 rounded border border-amber-400/30 bg-amber-500/10 px-2 py-1.5">
        <p className="text-xs font-bold text-amber-200">Showing the nearest {shown} of a larger family.</p>
        <button type="button" className={`${LOAD_KEY} self-start`} onClick={onLoadWhole} disabled={busy} aria-busy={busy}>
          {busy ? (
            <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <Network className="size-3.5" aria-hidden="true" />
          )}
          {busy ? 'Loading the whole family…' : 'Load the whole family'}
        </button>
        {error && (
          <p role="alert" className="text-xs font-bold text-red-300">
            Could not load the whole family: {error}
          </p>
        )}
      </div>
    );
  }
  const further = family.truncated
    ? ` Relatives further than ${family.depth} generations are not listed.`
    : '';
  if (family.whole) {
    return (
      <p role="status" className="text-xs font-bold text-zinc-400">
        The whole family is loaded: {shown} in all.{further}
      </p>
    );
  }
  if (further) return <p className="text-xs font-bold text-zinc-400">{further.trim()}</p>;
  return null;
};
