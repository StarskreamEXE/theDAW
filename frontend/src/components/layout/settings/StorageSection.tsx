/**
 * Storage: every model/data location on one line each (label · path · size ·
 * Open), the Hugging Face cache as an expandable row, and the VJ export folder.
 */
import React, { useEffect, useRef, useState } from 'react';
import { ChevronRight, FolderOpen, HardDrive, Loader2, RefreshCw } from 'lucide-react';
import { postJson } from '../../../lib/apiJson';
import { fetchHfCache, fetchLocations, formatBytes, openLocation, type HfRepo, type StorageLocation } from '../../../lib/storageClient';
import { useFeatureToggleStore } from '../../../state/featureToggleStore';
import { BTN_GHOST, CARD, SectionHeader } from './shared';

const VJ_FOLDER_TIP =
  'Where VJ recordings are saved. A relative path sits inside the project; Browse fills an absolute folder such as D:\\Renders. Each take adds its record-bar subfolder, then ffmpeg transcodes to the chosen codec.';

/** Hover detail for a location's size: every model in the directory. */
const locationInventoryTitle = (loc: StorageLocation): string | undefined => {
  const models = loc.models ?? [];
  if (!models.length) return loc.files != null ? `${loc.files} files` : undefined;
  const lines = models.slice(0, 14).map((m) =>
    `${m.recommended ? '★ ' : ''}${m.name} — ${formatBytes(m.bytes)}\n    ${m.path}${m.note ? `\n    ${m.note}` : ''}`);
  if (models.length > 14) lines.push(`…and ${models.length - 14} more`);
  return lines.join('\n');
};

export const StorageSection: React.FC = () => {
  const [locations, setLocations] = useState<StorageLocation[]>([]);
  const [hfRepos, setHfRepos] = useState<HfRepo[]>([]);
  const [hfTotal, setHfTotal] = useState(0);
  const [hfOpen, setHfOpen] = useState(false);
  const [sizesLoading, setSizesLoading] = useState(false);

  const load = React.useCallback((refresh = false) => {
    setSizesLoading(true);
    fetchLocations(refresh).then(setLocations).catch(() => setLocations([])).finally(() => setSizesLoading(false));
    fetchHfCache().then((d) => { setHfRepos(d.repos); setHfTotal(d.total_bytes); }).catch(() => setHfRepos([]));
  }, []);
  useEffect(() => { load(); }, [load]);

  // VJ export root: mirrored locally so typing doesn't PATCH per keystroke;
  // committed on blur / Enter.
  const exportRoot = useFeatureToggleStore((s) => s.settings.vj?.export_root ?? 'exports/vj');
  const patchFeatures = useFeatureToggleStore((s) => s.patch);
  const refreshFeatures = useFeatureToggleStore((s) => s.refresh);
  const [vjExportRoot, setVjExportRoot] = useState(exportRoot);
  useEffect(() => { setVjExportRoot(exportRoot); }, [exportRoot]);
  const pendingCommit = useRef<Promise<boolean> | null>(null);
  const commitVjExportRoot = () => {
    const v = vjExportRoot.trim() || 'exports/vj';
    if (v !== exportRoot) pendingCommit.current = patchFeatures({ vj: { export_root: v } });
  };

  // Browse asks the VJ module for the folder: its picker opens at the current
  // export folder and stores the folder the user chooses as the setting.
  const [vjPicking, setVjPicking] = useState(false);
  const [vjPickError, setVjPickError] = useState<string | null>(null);
  const browseVjExportRoot = async () => {
    if (vjPicking) return;
    setVjPicking(true);
    setVjPickError(null);
    try {
      // Clicking Browse blurs the field first; let that commit land so the
      // picker opens at the folder that was just typed.
      await pendingCommit.current;
      const res = await postJson<{ cancelled?: boolean; path?: string }>('/api/vj/export-folder/pick');
      if (!res.cancelled && res.path) {
        setVjExportRoot(res.path);
        await refreshFeatures();
      }
    } catch (e) {
      setVjPickError(e instanceof Error ? e.message : String(e));
    } finally {
      setVjPicking(false);
    }
  };

  const row = `${CARD} flex items-center gap-2 px-2 py-0.5 min-w-0`;
  return (
    <section aria-labelledby="settings-storage-title">
      <SectionHeader icon={<HardDrive className="w-3.5 h-3.5 text-purple-400" />} title="Storage"
        tip="Where models and data live on this PC (and inside WSL for Magenta). Hover a size for the models inside; Open shows the folder in Explorer. Sizes are cached for a minute — Refresh re-walks them.">
        {sizesLoading && <RefreshCw className="w-3 h-3 animate-spin text-zinc-400" />}
        <button type="button" onClick={() => load(true)} className={`${BTN_GHOST} ml-auto`} title="Re-walk every location">
          Refresh
        </button>
      </SectionHeader>
      <span id="settings-storage-title" className="sr-only">Storage</span>
      <div className="flex flex-col gap-1">
        {locations.map((loc) => (
          <div key={loc.key} className={row}>
            <span className="text-xs text-zinc-200 truncate shrink-0 max-w-[38%]" title={loc.label}>{loc.label}</span>
            <span className="text-[11px] font-mono text-zinc-500 truncate flex-1 min-w-0" title={loc.path ?? undefined}>{loc.path ?? 'not found'}</span>
            <span
              className={`text-[11px] font-mono text-zinc-300 tabular-nums shrink-0 ${loc.models?.length ? 'cursor-help underline decoration-dotted decoration-zinc-600 underline-offset-2' : ''}`}
              title={locationInventoryTitle(loc)}
            >
              {loc.exists ? formatBytes(loc.bytes) : '—'}
            </span>
            {loc.exists && loc.path && (
              <button
                type="button"
                onClick={() => { void openLocation(loc.path as string).catch(() => undefined); }}
                className={BTN_GHOST}
                aria-label={`Open ${loc.label} in Explorer`}
              >
                Open
              </button>
            )}
          </div>
        ))}

        {/* Hugging Face cache — an expandable row */}
        <div className={CARD}>
          <button
            type="button"
            onClick={() => setHfOpen((v) => !v)}
            aria-expanded={hfOpen}
            aria-controls="settings-hf-cache-list"
            className="w-full flex items-center gap-2 px-2 py-0.5 text-left"
          >
            <ChevronRight className={`w-3 h-3 text-zinc-400 shrink-0 transition-transform ${hfOpen ? 'rotate-90' : ''}`} />
            <span className="text-xs text-zinc-200 flex-1 min-w-0 truncate">Hugging Face cache · {hfRepos.length} repos</span>
            <span className="text-[11px] font-mono text-zinc-300 tabular-nums shrink-0">{formatBytes(hfTotal)}</span>
          </button>
          <div id="settings-hf-cache-list" hidden={!hfOpen} className="flex flex-col gap-0.5 px-2 pb-1.5 max-h-40 overflow-y-auto">
            {hfRepos.map((r) => (
              <div key={r.repo_id} className="flex items-center gap-2 px-1.5 py-0.5 rounded border border-white/5">
                <span className="text-[11px] font-mono text-zinc-300 truncate flex-1" title={r.path}>{r.repo_id}</span>
                <span className="text-[11px] font-mono text-zinc-400 tabular-nums shrink-0">{formatBytes(r.bytes)}</span>
                <button
                  type="button"
                  onClick={() => { void openLocation(r.path).catch(() => undefined); }}
                  className={BTN_GHOST}
                  aria-label={`Open ${r.repo_id} in Explorer`}
                >
                  Open
                </button>
              </div>
            ))}
            {hfRepos.length === 0 && <p className="text-[11px] text-zinc-400 px-1.5 py-0.5">The cache is empty.</p>}
          </div>
        </div>

        {/* VJ recordings folder */}
        <div className={`${CARD} px-2 py-1`}>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <label
              htmlFor="settings-vj-export-root"
              title={VJ_FOLDER_TIP}
              className="text-[9px] font-mono uppercase tracking-wider text-zinc-400 shrink-0 cursor-help"
            >
              VJ folder
            </label>
            <div className="flex gap-1.5 flex-1 min-w-0">
              <input
                id="settings-vj-export-root"
                name="settings-vj-export-root"
                type="text"
                value={vjExportRoot}
                title={VJ_FOLDER_TIP}
                onChange={(e) => setVjExportRoot(e.target.value)}
                onBlur={commitVjExportRoot}
                onKeyDown={(e) => { if (e.key === 'Enter') commitVjExportRoot(); }}
                spellCheck={false}
                placeholder="exports/vj"
                className="min-w-0 flex-1 bg-black/40 border border-white/10 rounded px-2 py-1.5 text-[10px] font-mono text-zinc-200 focus:border-purple-500/50 focus:outline-none"
              />
              <button
                type="button"
                onClick={() => void browseVjExportRoot()}
                disabled={vjPicking}
                aria-label="Choose the VJ recordings folder"
                title="Choose the VJ recordings folder"
                className="shrink-0 inline-flex items-center justify-center gap-1.5 rounded border border-white/10 bg-white/5 px-2.5 py-1.5 text-[9px] font-black uppercase tracking-widest text-zinc-300 hover:border-purple-400/40 hover:bg-purple-500/15 hover:text-purple-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {vjPicking ? <Loader2 className="w-3 h-3 animate-spin" /> : <FolderOpen className="w-3 h-3" />}
                Browse
              </button>
            </div>
            {vjPickError && <p className="w-full text-[8px] text-red-300 leading-relaxed">{vjPickError}</p>}
          </div>
        </div>
      </div>
    </section>
  );
};
