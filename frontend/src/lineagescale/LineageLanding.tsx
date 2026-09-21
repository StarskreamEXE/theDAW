import React, { useCallback, useState } from 'react';
import { ProviderBadge } from '../components/library/ProviderBadge';
import { relationWords } from '../lib/lineageInsights';
import type { LineageSummary, RankingList, RankingRow } from './lineageScaleClient';
import { RANKING_LISTS } from './lineageScaleClient';
import {
  RANKING_HINTS, RANKING_TITLES, formatCount, kindRows, summaryHeadlines,
} from './lineageScaleModel';

/**
 * LineageLanding — the way IN to a 200,000-song lineage.
 *
 * There is no picture of the library here, because there cannot be one: the
 * real graph is 194,833 nodes and 475,174 links, and one connected component
 * holds 81,501 songs. So the landing page is numbers, four ranked lists, and a
 * search box. You pick ONE song, and the focus view draws its neighbourhood.
 *
 * The search goes through the library's own paged `/entries` endpoint (the
 * same one the library list uses), so it costs one page of rows — the library
 * is never loaded.
 */

export interface SearchHit {
  id: string;
  title: string;
  model?: string;
  source?: string;
}

export interface LineageLandingProps {
  summary: LineageSummary | null;
  rankings: Partial<Record<RankingList, RankingRow[]>>;
  rankingErrors?: Partial<Record<RankingList, string>>;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onFocus: (id: string, title: string) => void;
  onSearch: (query: string) => Promise<SearchHit[]>;
}

const SEARCH_INPUT_ID = 'lineage-scale-search';

const Card: React.FC<{ label: string; value: string; hint: string }> = ({ label, value, hint }) => (
  <div className="rounded border border-white/10 bg-white/3 px-3 py-2">
    <div className="text-[9px] font-mono uppercase tracking-widest text-zinc-500">{label}</div>
    <div className="mt-0.5 text-xl tabular-nums text-zinc-100">{value}</div>
    <div className="mt-0.5 text-[9px] font-mono text-zinc-500">{hint}</div>
  </div>
);

const RankedList: React.FC<{
  list: RankingList;
  rows: RankingRow[] | undefined;
  error: string | undefined;
  onFocus: (id: string, title: string) => void;
}> = ({ list, rows, error, onFocus }) => (
  <section aria-label={RANKING_TITLES[list]} className="flex min-h-0 flex-col rounded border border-white/10 bg-black/40">
    <header className="border-b border-white/10 px-3 py-2">
      <h3 className="text-[10px] font-mono uppercase tracking-widest text-zinc-300">{RANKING_TITLES[list]}</h3>
      <p className="mt-0.5 text-[9px] font-mono text-zinc-500">{RANKING_HINTS[list]}</p>
    </header>
    {error ? (
      <p className="px-3 py-4 text-[10px] text-rose-300">{error}</p>
    ) : rows === undefined ? (
      <p className="px-3 py-4 text-[10px] font-mono text-zinc-500">Loading…</p>
    ) : rows.length === 0 ? (
      <p className="px-3 py-4 text-[10px] italic text-zinc-500">Nothing to rank yet.</p>
    ) : (
      <ol className="min-h-0 grow overflow-y-auto">
        {rows.map((row, i) => (
          <li key={row.id}>
            <button
              type="button"
              onClick={() => onFocus(row.id, row.title)}
              aria-label={`${row.title}, ${formatCount(row.count)}, ${row.detail}. Focus this song.`}
              className="flex w-full items-center gap-2 border-b border-white/5 px-3 py-1.5 text-left hover:bg-white/5"
            >
              <span className="w-5 shrink-0 text-right text-[9px] font-mono tabular-nums text-zinc-600">{i + 1}</span>
              <span className="min-w-0 grow">
                <span className="block truncate text-[11px] text-zinc-100">{row.title}</span>
                <span className="block truncate text-[9px] font-mono text-zinc-500">{row.detail}</span>
              </span>
              <span className="shrink-0 text-[11px] tabular-nums text-purple-200">{formatCount(row.count)}</span>
            </button>
          </li>
        ))}
      </ol>
    )}
  </section>
);

export const LineageLanding: React.FC<LineageLandingProps> = ({
  summary, rankings, rankingErrors, loading, error, onRetry, onFocus, onSearch,
}) => {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const runSearch = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const q = query.trim();
      if (!q) {
        setHits(null);
        setSearchError(null);
        return;
      }
      setSearching(true);
      setSearchError(null);
      onSearch(q)
        .then(setHits)
        .catch((err: unknown) => setSearchError(err instanceof Error ? err.message : String(err)))
        .finally(() => setSearching(false));
    },
    [onSearch, query],
  );

  return (
    <div className="flex h-full w-full flex-col gap-3 overflow-y-auto p-3">
      <header>
        <h2 className="text-[11px] font-mono uppercase tracking-widest text-zinc-300">Lineage at scale</h2>
        <p className="mt-0.5 max-w-3xl text-[10px] text-zinc-500">
          A library this size has no single picture — mashups weld unrelated families into clusters tens of
          thousands of songs wide. Start from one song instead: search for it, or pick one below.
        </p>
      </header>

      <form onSubmit={runSearch} className="flex flex-wrap items-center gap-2">
        <label htmlFor={SEARCH_INPUT_ID} className="text-[9px] font-mono uppercase tracking-widest text-zinc-500">
          Find a song
        </label>
        <input
          id={SEARCH_INPUT_ID}
          name={SEARCH_INPUT_ID}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="title…"
          className="w-64 rounded border border-white/10 bg-black/60 px-2 py-1 text-[11px] font-mono text-zinc-200 placeholder-zinc-600 focus:border-purple-400/60 focus:outline-none"
        />
        <button
          type="submit"
          className="rounded border border-purple-500/30 bg-purple-500/15 px-2 py-1 text-[9px] font-mono uppercase tracking-widest text-zinc-200 hover:border-purple-400/60 hover:text-white"
        >
          {searching ? 'Searching…' : 'Search'}
        </button>
        {searchError && <span className="text-[10px] text-rose-300">{searchError}</span>}
      </form>

      {hits !== null && (
        <section aria-label="Search results" className="rounded border border-white/10 bg-black/40">
          {hits.length === 0 ? (
            <p className="px-3 py-3 text-[10px] italic text-zinc-500">No song matched that title.</p>
          ) : (
            <ul className="max-h-48 overflow-y-auto">
              {hits.map((hit) => (
                <li key={hit.id}>
                  <button
                    type="button"
                    onClick={() => onFocus(hit.id, hit.title)}
                    aria-label={`${hit.title}. Focus this song.`}
                    className="flex w-full items-center gap-2 border-b border-white/5 px-3 py-1.5 text-left hover:bg-white/5"
                  >
                    <span className="min-w-0 grow truncate text-[11px] text-zinc-100">{hit.title}</span>
                    <ProviderBadge entry={{ model: hit.model, source: hit.source }} className="shrink-0" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {error ? (
        <div className="rounded border border-rose-500/30 bg-rose-500/10 px-3 py-3">
          <p className="text-[10px] text-rose-200">{error}</p>
          <button
            type="button"
            onClick={onRetry}
            className="mt-2 rounded border border-white/10 px-2 py-1 text-[9px] font-mono uppercase tracking-widest text-zinc-200 hover:border-white/25 hover:text-white"
          >
            Try again
          </button>
        </div>
      ) : summary === null ? (
        <p className="px-1 py-6 text-[10px] font-mono text-zinc-500">
          {loading ? 'Counting the library…' : 'No lineage summary yet.'}
        </p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
            {summaryHeadlines(summary).map((h) => (
              <Card key={h.key} label={h.label} value={h.value} hint={h.hint} />
            ))}
          </div>

          <section aria-label="Relationship kinds" className="rounded border border-white/10 bg-black/40 px-3 py-2">
            <h3 className="text-[9px] font-mono uppercase tracking-widest text-zinc-500">Relationship kinds</h3>
            <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
              {kindRows(summary.by_kind).map(([kind, n]) => (
                <li key={kind} className="text-[10px] font-mono text-zinc-400">
                  {relationWords(kind)}{' '}
                  <span className="tabular-nums text-zinc-200">{formatCount(n)}</span>
                </li>
              ))}
            </ul>
            <p className="mt-1 text-[9px] font-mono text-zinc-600">
              {formatCount(summary.links_raw)} stored links become {formatCount(summary.links_distinct)} drawn
              relationships — the same relationship is often recorded several times.
            </p>
          </section>
        </>
      )}

      {/* The ranked lists are four independent requests and are rendered
          whatever the summary did: one failed count must not take away the
          four ways in. */}
      <div className="grid min-h-0 grid-cols-1 gap-2 lg:grid-cols-2">
        {RANKING_LISTS.map((list) => (
          <RankedList
            key={list}
            list={list}
            rows={rankings[list]}
            error={rankingErrors?.[list]}
            onFocus={onFocus}
          />
        ))}
      </div>
    </div>
  );
};

export default LineageLanding;
