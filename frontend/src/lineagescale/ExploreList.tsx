import React from 'react';
import { ProviderBadge } from '../components/library/ProviderBadge';
import { formatDuration } from './lineageScaleModel';
import {
  clampPageOffset, pageOf, pageTotal, rangeLabel, rowCountLabel,
} from './exploreModel';
import type { ExplorePage, ExploreRow, ExploreSpec } from './exploreModel';

/**
 * ExploreList — one page of one list, and the pager under it.
 *
 * A row is a provider badge, a title, the number the list was ranked by, and
 * two named buttons. Both are real <button>s, so Enter and Space reach them
 * from the keyboard without this file inventing a key handler, and neither is
 * wrapped in a <label> — a <label> does not name a non-native control
 * (project CLAUDE.md rule 3).
 *
 * Paging rather than virtualising: a page is 50 rows and the server counts the
 * rest, so the browser holds 50 rows whether the list is 50 songs or 173,877.
 */

export interface ExploreListProps {
  spec: ExploreSpec;
  page: ExplorePage | null;
  loading: boolean;
  error: string | null;
  idPrefix: string;
  onOffset: (offset: number) => void;
  onFocus: (id: string, title: string) => void;
  onCopyId: (id: string) => void;
  onOpenFamily: (id: string, title: string) => void;
  onRetry?: () => void;
}

const cell = 'px-2 py-1.5 align-middle';

const Row: React.FC<{
  spec: ExploreSpec;
  row: ExploreRow;
  onFocus: (id: string, title: string) => void;
  onCopyId: (id: string) => void;
  onOpenFamily: (id: string, title: string) => void;
}> = ({ spec, row, onFocus, onCopyId, onOpenFamily }) => {
  const isFamily = spec.list === 'families';
  const count = rowCountLabel(spec, row);
  const primaryLabel = isFamily
    ? `Open the family of ${row.title}`
    : `${row.title}. Focus this song.`;
  return (
    <tr className="border-b border-white/5 hover:bg-white/5">
      <td className={`${cell} w-8`}>
        <ProviderBadge entry={{ model: row.model, source: row.source }} />
      </td>
      <td className={`${cell} max-w-0`}>
        <button
          type="button"
          aria-label={primaryLabel}
          onClick={() =>
            isFamily
              ? onOpenFamily(row.root_id || row.id, row.title)
              : onFocus(row.id, row.title)
          }
          className="block w-full truncate text-left text-[11px] text-zinc-100 hover:text-white"
        >
          {row.title}
        </button>
        <span className="block truncate text-[9px] font-mono text-zinc-600">{row.id}</span>
      </td>
      <td className={`${cell} text-right text-[10px] tabular-nums text-purple-200`}>{count}</td>
      <td className={`${cell} text-right text-[9px] font-mono text-zinc-500`}>
        {formatDuration(row.duration_sec)}
      </td>
      <td className={`${cell} text-right whitespace-nowrap`}>
        <button
          type="button"
          aria-label={`${row.title}. Focus this song.`}
          onClick={() => onFocus(row.id, row.title)}
          className="rounded border border-white/10 px-1.5 py-0.5 text-[9px] font-mono uppercase tracking-widest text-zinc-300 hover:border-purple-400/60 hover:text-white"
        >
          Focus
        </button>
        <button
          type="button"
          aria-label={`Copy the id of ${row.title}`}
          onClick={() => onCopyId(row.id)}
          className="ml-1 rounded border border-white/10 px-1.5 py-0.5 text-[9px] font-mono uppercase tracking-widest text-zinc-300 hover:border-white/25 hover:text-white"
        >
          Copy id
        </button>
      </td>
    </tr>
  );
};

export const ExploreList: React.FC<ExploreListProps> = ({
  spec, page, loading, error, idPrefix, onOffset, onFocus, onCopyId, onOpenFamily, onRetry,
}) => {
  if (error) {
    return (
      <div className="rounded border border-rose-500/30 bg-rose-500/10 px-3 py-3">
        <p className="text-[10px] text-rose-200">{error}</p>
        <button
          type="button"
          aria-label="Try this list again"
          onClick={() => onRetry?.()}
          className="mt-2 rounded border border-white/10 px-2 py-1 text-[9px] font-mono uppercase tracking-widest text-zinc-200 hover:border-white/25 hover:text-white"
        >
          Try again
        </button>
      </div>
    );
  }
  if (page === null) {
    return (
      <p className="px-1 py-6 text-[10px] font-mono text-zinc-500">
        {loading ? 'Reading the library…' : 'Nothing read yet.'}
      </p>
    );
  }
  if (page.rows.length === 0) {
    return (
      <p className="px-1 py-6 text-[10px] italic text-zinc-500">
        No song in this list{page.total === 0 ? '' : ' on this page'}.
      </p>
    );
  }

  const limit = page.limit || 50;
  const pages = pageTotal(page.total, limit);
  const current = pageOf(page.offset, limit);
  const pageInputId = `${idPrefix}-page`;

  return (
    <div className="flex min-h-0 flex-col gap-2">
      <div className="min-h-0 grow overflow-y-auto rounded border border-white/10 bg-black/40">
        <table className="w-full table-fixed border-collapse">
          <caption className="sr-only">{`${page.total} rows`}</caption>
          <tbody>
            {page.rows.map((row) => (
              <Row
                key={row.id}
                spec={spec}
                row={row}
                onFocus={onFocus}
                onCopyId={onCopyId}
                onOpenFamily={onOpenFamily}
              />
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[9px] font-mono tabular-nums text-zinc-500">
          {rangeLabel(page.offset, limit, page.total, page.rows.length)}
        </span>
        <span className="grow" />
        <button
          type="button"
          aria-label="Previous page"
          disabled={current <= 1 || loading}
          onClick={() => onOffset(Math.max(0, page.offset - limit))}
          className="rounded border border-white/10 px-2 py-0.5 text-[9px] font-mono uppercase tracking-widest text-zinc-300 disabled:opacity-40 hover:border-white/25 hover:text-white"
        >
          Prev
        </button>
        <label
          htmlFor={pageInputId}
          className="text-[9px] font-mono uppercase tracking-widest text-zinc-500"
        >
          Page
        </label>
        <input
          id={pageInputId}
          name={pageInputId}
          type="number"
          min={1}
          max={pages}
          value={current}
          onChange={(e) => onOffset(clampPageOffset(Number(e.target.value), limit, page.total))}
          className="w-16 rounded border border-white/10 bg-black/60 px-1 py-0.5 text-[10px] font-mono tabular-nums text-zinc-200 focus:border-purple-400/60 focus:outline-none"
        />
        <span className="text-[9px] font-mono tabular-nums text-zinc-500">{`of ${pages}`}</span>
        <button
          type="button"
          aria-label="Next page"
          disabled={current >= pages || loading}
          onClick={() => onOffset(page.offset + limit)}
          className="rounded border border-white/10 px-2 py-0.5 text-[9px] font-mono uppercase tracking-widest text-zinc-300 disabled:opacity-40 hover:border-white/25 hover:text-white"
        >
          Next
        </button>
      </div>
    </div>
  );
};

export default ExploreList;
