/**
 * UsedInSections — the asset inspector's "Used in" tab body (F23U-3).
 *
 * Self-contained: given one library entry id, it loads where that entry was
 * used (projects, renders) and, when the entry is itself a render output,
 * what it was made from — then renders each as its own section, every
 * openable row a real keyboard-focusable button. It knows nothing about the
 * library list; it never reads a library store or a paged/list endpoint,
 * only the two per-entry lineage endpoints in `usedInApi`.
 *
 * Both loads run together, keyed on `entryId`, guarded by a stale-request
 * token plus a cancelled flag so a slow response for a previous asset can
 * never paint over the one the user is now looking at. The same guarded
 * loader backs the Retry button, so retrying never bypasses that guard.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { fetchUsedIn, fetchSources, createStaleGuard } from '../../lib/lineage/usedInApi';
import {
  projectRows,
  renderRows,
  madeFromRows,
  madeFromHeading,
  type UsedInProjectRow,
  type UsedInRenderRow,
  type MadeFromRow,
} from '../../lib/lineage/usedInModel';
import type { LineageSources, LineageUsedIn } from '../../lib/lineage/lineageTypes';
import { logError } from '../../state/logStore';

// Matches AssetInspectorModal's Setlists section exactly (SECTION const,
// the h3 styling, the ul/li rhythm) so these sections sit beside it without
// a visual seam. Duplicated here rather than imported: AssetInspectorModal
// does not export these, and this ticket does not touch that file.
const SECTION = 'flex flex-col gap-1.5 rounded border border-white/5 bg-white/3 p-2';
const HEADING = 'font-display text-xs font-bold uppercase text-purple-300';
const ROW_LIST = 'flex flex-col gap-0.5';
const PLAIN_ROW = 'flex items-baseline gap-2 text-xs font-bold';
const BUTTON_ROW =
  'flex w-full items-baseline gap-2 rounded text-left text-xs font-bold text-zinc-200 hover:bg-white/5 focus-visible:outline focus-visible:outline-purple-400';
const STATUS_MSG = 'py-6 text-center text-xs font-bold text-zinc-500';
const RETRY_BUTTON =
  'rounded border border-white/10 px-2 py-1 text-xs font-bold text-zinc-200 hover:bg-white/5 focus-visible:outline focus-visible:outline-purple-400';

type UsedInSectionsStatus = 'idle' | 'loading' | 'ready' | 'error';

const ProjectRowItem: React.FC<{ row: UsedInProjectRow }> = ({ row }) => (
  // A project has no entry of its own to open — nothing here is a button.
  <li className={PLAIN_ROW}>
    <span className="min-w-0 flex-1 truncate text-zinc-200">{row.name}</span>
    <span className="shrink-0 text-zinc-500">{row.rendersLabel}</span>
    <span className="shrink-0 tabular-nums text-zinc-500">{row.lastRenderLabel}</span>
  </li>
);

const RenderRowItem: React.FC<{
  row: UsedInRenderRow;
  onOpenEntry?: (entryId: string) => void;
}> = ({ row, onOpenEntry }) => {
  const outputEntryId = row.outputEntryId;
  if (outputEntryId === null) {
    return (
      <li className={PLAIN_ROW}>
        <span className="min-w-0 flex-1 truncate text-zinc-200">
          {row.kindLabel} · {row.projectName}
        </span>
        <span className="shrink-0 tabular-nums text-zinc-500">{row.dateLabel}</span>
        <span className="shrink-0 text-zinc-600 italic">output not in the library</span>
      </li>
    );
  }
  return (
    <li>
      <button type="button" aria-label={row.ariaLabel} onClick={() => onOpenEntry?.(outputEntryId)} className={BUTTON_ROW}>
        <span className="min-w-0 flex-1 truncate">
          {row.kindLabel} · {row.projectName}
        </span>
        <span className="shrink-0 tabular-nums text-zinc-500">{row.dateLabel}</span>
      </button>
    </li>
  );
};

const MadeFromRowItem: React.FC<{
  row: MadeFromRow;
  onOpenEntry?: (entryId: string) => void;
}> = ({ row, onOpenEntry }) => (
  <li>
    <button type="button" aria-label={row.ariaLabel} onClick={() => onOpenEntry?.(row.entryId)} className={BUTTON_ROW}>
      <span className="min-w-0 flex-1 truncate">{row.rangeLabel}</span>
      <span className="shrink-0 text-zinc-500">{row.roleLabel}</span>
    </button>
  </li>
);

export const UsedInSections: React.FC<{
  entryId: string;
  onOpenEntry?: (entryId: string) => void;
}> = ({ entryId, onOpenEntry }) => {
  const [usedIn, setUsedIn] = useState<LineageUsedIn | null>(null);
  const [sources, setSources] = useState<LineageSources | null>(null);
  const [status, setStatus] = useState<UsedInSectionsStatus>('idle');
  const [errorText, setErrorText] = useState('');

  // `load` backs both the entryId-keyed effect below and the Retry button,
  // so a retry goes through the exact same stale-token / cancelled guard as
  // the initial load rather than a second, divergent code path.
  const cancelledRef = useRef(false);
  const staleGuardRef = useRef(createStaleGuard());

  const load = useCallback((id: string) => {
    cancelledRef.current = false;
    const token = staleGuardRef.current.begin();
    setStatus('loading');
    setErrorText('');
    void Promise.all([fetchUsedIn(id), fetchSources(id)]).then(([usedInResult, sourcesResult]) => {
      if (cancelledRef.current || !staleGuardRef.current.isCurrent(token)) return;
      if (!usedInResult.ok || !sourcesResult.ok) {
        let message = '';
        if (!usedInResult.ok) message = usedInResult.error;
        else if (!sourcesResult.ok) message = sourcesResult.error;
        setUsedIn(null);
        setSources(null);
        setErrorText(message);
        setStatus('error');
        logError('library', `UsedInSections could not load lineage for entry ${id}: ${message}`);
        return;
      }
      setUsedIn(usedInResult.data);
      setSources(sourcesResult.data);
      setStatus('ready');
    });
  }, []);

  useEffect(() => {
    load(entryId);
    return () => {
      cancelledRef.current = true;
    };
  }, [entryId, load]);

  const handleRetry = useCallback(() => {
    load(entryId);
  }, [entryId, load]);

  const projectRowsList = useMemo(() => projectRows(usedIn), [usedIn]);
  const renderRowsList = useMemo(() => renderRows(usedIn), [usedIn]);
  const madeFromRowsList = useMemo(() => madeFromRows(sources), [sources]);
  const madeFromHeadingText = useMemo(() => madeFromHeading(sources), [sources]);

  // "Both payloads empty" reads as no projects, no renders, and this entry
  // not being a render output at all (madeFromHeading is '' — see its own
  // doc comment: that is its cue to skip the section, not show it at zero).
  const isEmpty =
    status === 'ready' && projectRowsList.length === 0 && renderRowsList.length === 0 && madeFromHeadingText === '';

  return (
    <div className="flex flex-col gap-2">
      {status === 'loading' || status === 'idle' ? (
        <p className={STATUS_MSG}>
          <Loader2 className="mr-1 inline size-3.5 animate-spin" aria-hidden="true" /> Reading render history…
        </p>
      ) : status === 'error' ? (
        <div role="alert" className={`${STATUS_MSG} flex flex-col items-center gap-2`}>
          <p>{errorText}</p>
          <button
            type="button"
            onClick={handleRetry}
            aria-label="Retry reading where this asset was used"
            className={RETRY_BUTTON}
          >
            Retry
          </button>
        </div>
      ) : isEmpty ? (
        <p className={STATUS_MSG}>Not used in any render yet</p>
      ) : (
        <>
          <section className={SECTION}>
            <h3 className={HEADING}>Projects ({projectRowsList.length})</h3>
            <ul className={ROW_LIST}>
              {projectRowsList.map((row) => (
                <ProjectRowItem key={row.id} row={row} />
              ))}
            </ul>
          </section>
          <section className={SECTION}>
            <h3 className={HEADING}>Renders ({renderRowsList.length})</h3>
            <ul className={ROW_LIST}>
              {renderRowsList.map((row) => (
                <RenderRowItem key={row.id} row={row} onOpenEntry={onOpenEntry} />
              ))}
            </ul>
          </section>
          {madeFromHeadingText !== '' && (
            <section className={SECTION}>
              <h3 className={HEADING}>{madeFromHeadingText}</h3>
              <ul className={ROW_LIST}>
                {madeFromRowsList.map((row) => (
                  <MadeFromRowItem key={row.key} row={row} onOpenEntry={onOpenEntry} />
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
};
