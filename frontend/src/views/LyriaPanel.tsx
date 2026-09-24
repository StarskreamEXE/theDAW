import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, ExternalLink, Library, Loader2, RefreshCw } from 'lucide-react';
import { backendHttpBase } from '../lib/backendBase';
import { panelModelDefaults, panelModelOptions } from '../lib/cloudModels';
import { useGenerateParamsStore } from '../state/generateParamsStore';
import { probeLyriaCheckedOut } from '../state/generateStore';
import { useLibraryStore } from '../state/libraryStore';

// INT-002: how often the panel asks the backend to pull anything new out of
// the sidecar's own library. Generations take tens of seconds, so 30 s means a
// finished track shows up in the catalog without the user pressing anything.
const AUTO_SYNC_MS = 30000;
// How long the inline "3 imported" / "Nothing new" result stays up.
const SYNC_NOTE_MS = 4000;

// The Lyria 3 Pro app (StarskreamEXE/lyria-3-pro) is embedded WHOLE and
// unmodified: it ships its own Express server, its own SPA, its own settings
// and library. We spawn it (backend/modules/lyria) and frame it.
//
// Why an iframe rather than absorbing its UI: at its own origin the app's
// relative /api/* fetches resolve against its own server, so it needs no CORS,
// no base URL, and no client rewrite. Its viewport styling, its portals, its
// window event bus, and its Ctrl+Enter binding all apply to its own document
// and cannot collide with ours. Preserving it whole is what removes the work.
//
// This panel is therefore much thinner than VJView: Lyria drives its own
// transport and needs no postMessage bridge.
export const LyriaPanel: React.FC = () => {
  // This panel replaces the whole Make surface, hiding AdvancedGenPanel and the
  // real model dropdown with it. Without a selector here the user would be
  // stranded in the iframe with no route back to SA3 (same reason SunoGenPanel
  // carries one).
  const model = useGenerateParamsStore((s) => s.model);
  const patchParams = useGenerateParamsStore((s) => s.patch);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [url, setUrl] = useState<string | null>(null);
  const [mock, setMock] = useState<boolean | null>(null);
  const [detail, setDetail] = useState('');
  const [popped, setPopped] = useState(false);
  // INT-005: fails open (true) until the probe answers, same convention as
  // generateStore's own model-status gating — never hides the switcher's
  // options on a slow/unreachable probe.
  const [lyriaCheckedOut, setLyriaCheckedOut] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void probeLyriaCheckedOut().then((ok) => { if (!cancelled) setLyriaCheckedOut(ok); });
    return () => { cancelled = true; };
  }, []);

  // INT-002 — pulling the sidecar's generations into theDAW's library.
  const [syncing, setSyncing] = useState(false);
  const [syncNote, setSyncNote] = useState('');
  const syncNoteTimerRef = useRef<number | null>(null);
  // Guards the automatic 30 s tick against the button (and against itself on a
  // slow import): the backend serializes syncs anyway, but a second request
  // would sit there holding a connection for nothing.
  const syncBusyRef = useRef(false);

  const showSyncNote = useCallback((text: string) => {
    setSyncNote(text);
    if (syncNoteTimerRef.current !== null) window.clearTimeout(syncNoteTimerRef.current);
    syncNoteTimerRef.current = window.setTimeout(() => setSyncNote(''), SYNC_NOTE_MS);
  }, []);

  /**
   * Ask the backend to register every new sidecar generation as a library
   * entry. `announce` is the button: an automatic tick reports nothing and
   * never shows a spinner, so a background sync cannot flicker the top bar.
   *
   * `include_mock` is always false here. The sidecar defaults to mock mode
   * (its generations are synthesized sine waves that cost nothing), and
   * filling the user's library with those is not what this button is for.
   */
  const runSync = useCallback(
    async (announce: boolean) => {
      if (syncBusyRef.current) return;
      syncBusyRef.current = true;
      if (announce) setSyncing(true);
      try {
        const r = await fetch('/api/lyria/import-new', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ include_mock: false }),
        });
        if (!r.ok) throw new Error(`backend returned ${r.status}`);
        const j = (await r.json()) as {
          imported?: string[];
          skipped?: number;
          reason?: string;
        };
        const n = j.imported?.length ?? 0;
        // Exactly what sunoStore does when a clip completes: the backend has
        // already registered the entries, so the store only has to re-read.
        if (n > 0) await useLibraryStore.getState().refresh();
        if (announce) {
          if (n > 0) showSyncNote(`${n} imported`);
          else if (j.reason) showSyncNote(j.reason);
          else showSyncNote('Nothing new');
        }
      } catch (e) {
        // A failed sync is not a failed panel — the iframe keeps working.
        if (announce) showSyncNote(e instanceof Error ? e.message : 'Sync failed');
      } finally {
        syncBusyRef.current = false;
        if (announce) setSyncing(false);
      }
    },
    [showSyncNote],
  );

  // One sync the moment the iframe is live, then every 30 s while the panel
  // stays mounted and ready. The interval is cleared on unmount and whenever
  // the panel leaves 'ready', so a backgrounded tab stops polling.
  useEffect(() => {
    if (status !== 'ready') return;
    void runSync(false);
    const t = window.setInterval(() => void runSync(false), AUTO_SYNC_MS);
    return () => window.clearInterval(t);
  }, [status, runSync]);

  useEffect(
    () => () => {
      if (syncNoteTimerRef.current !== null) window.clearTimeout(syncNoteTimerRef.current);
    },
    [],
  );

  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const poppedWindowRef = useRef<Window | null>(null);
  const loadRetriesRef = useRef(0);
  const loadTimerRef = useRef<number | null>(null);
  const MAX_LOAD_RETRIES = 20; // ~40s of 2s retries

  // Same readiness contract as VJView: /api/lyria/url blocks server-side until
  // the child is listening, and we retry quietly while the backend is still
  // binding, so a cold start (npm install on a fresh checkout) renders
  // "Starting…" rather than an error.
  const loadUrl = async (manual = false) => {
    if (manual) loadRetriesRef.current = 0;
    if (loadTimerRef.current !== null) {
      window.clearTimeout(loadTimerRef.current);
      loadTimerRef.current = null;
    }
    setStatus('loading');
    try {
      const r = await fetch('/api/lyria/url');
      if (!r.ok) {
        // The backend hands back the sidecar's own diagnostic (missing
        // checkout, npm absent, startup hang) — surface it rather than a code.
        let msg = `backend returned ${r.status}`;
        try {
          const body = (await r.json()) as { detail?: string };
          if (body.detail) msg = body.detail;
        } catch {
          /* non-JSON error body; keep the status line */
        }
        throw new Error(msg);
      }
      const j = (await r.json()) as { url: string; mock?: boolean };
      setUrl(j.url);
      setMock(j.mock ?? null);
      loadRetriesRef.current = 0;
      setStatus('ready');
      setDetail('');
    } catch (e) {
      if (loadRetriesRef.current < MAX_LOAD_RETRIES) {
        loadRetriesRef.current += 1;
        setStatus('loading');
        loadTimerRef.current = window.setTimeout(() => void loadUrl(), 2000);
      } else {
        setStatus('error');
        setDetail(e instanceof Error ? e.message : String(e));
      }
    }
  };

  useEffect(() => {
    void loadUrl();
    return () => {
      if (loadTimerRef.current !== null) window.clearTimeout(loadTimerRef.current);
    };
  }, []);

  // The sidecar returns an absolute http://127.0.0.1:<port> URL, so this
  // resolve is a no-op today. It is kept because backendHttpBase() is what
  // makes the packaged Electron app (origin app://.) work if the URL ever
  // becomes relative, and costs nothing.
  const lyriaSrc = useMemo(() => {
    if (!url) return null;
    try {
      return new URL(url, backendHttpBase()).toString();
    } catch {
      return url;
    }
  }, [url]);

  const popOut = () => {
    if (!lyriaSrc) return;
    const w = window.open(
      lyriaSrc,
      'thedaw-lyria-window',
      'noopener=no,width=1400,height=900,location=no,menubar=no,toolbar=no,status=no',
    );
    if (!w) {
      setDetail('Pop-out blocked — allow pop-ups for this origin, then try again.');
      window.setTimeout(() => setDetail(''), 6000);
      return;
    }
    poppedWindowRef.current = w;
    setPopped(true);
  };

  const popBackIn = () => {
    poppedWindowRef.current?.close();
    poppedWindowRef.current = null;
    setPopped(false);
  };

  // Snap back when the user closes the popped window directly.
  useEffect(() => {
    if (!popped) return;
    const t = window.setInterval(() => {
      if (poppedWindowRef.current?.closed) {
        poppedWindowRef.current = null;
        setPopped(false);
      }
    }, 1000);
    return () => window.clearInterval(t);
  }, [popped]);

  return (
    <div className="h-full w-full flex flex-col overflow-hidden">
      <div className="flex items-center gap-2 px-2 py-1 border-b border-zinc-800 shrink-0">
        {/* Functional, not decorative: this is the only signal telling the user
            whether GENERATE costs $0.08 or synthesizes a local mock. */}
        {mock !== null && (
          <span
            className={`text-[8px] font-mono uppercase tracking-widest px-1.5 py-0.5 rounded border shrink-0 ${
              mock
                ? 'border-emerald-500/40 text-emerald-300 bg-emerald-500/10'
                : 'border-amber-500/40 text-amber-300 bg-amber-500/10'
            }`}
            title={
              mock
                ? 'Mock mode: generations synthesize a local WAV and cost nothing. Set theDAW_LYRIA_MOCK=0 to use the real Lyria 3 API.'
                : 'Live mode: every generation calls the real Lyria 3 API and costs $0.08 (Pro) or $0.04 (Clip) on your own key.'
            }
          >
            {mock ? 'Mock' : 'Live $0.08'}
          </span>
        )}
        <div className="flex-1" />
        {/* INT-002: Lyria's own library is inside the sidecar. This is the
            hand-off that makes a generation a theDAW entry — catalog, lineage,
            EDIT, stems, export — the way a finished Suno clip already is. */}
        <button
          type="button"
          onClick={() => void runSync(true)}
          disabled={syncing}
          aria-label="Sync Lyria generations to the theDAW library"
          title="Import every new Lyria generation into theDAW's library (catalog, lineage, EDIT, stems, export). Runs automatically every 30 seconds too. Mock generations are never imported."
          className="px-2 py-0.5 rounded border border-zinc-700 hover:bg-white/5 text-zinc-300 text-[9px] font-mono uppercase tracking-widest flex items-center gap-1 shrink-0 disabled:opacity-40"
        >
          {syncing ? (
            <Loader2 className="w-3 h-3 animate-spin" />
          ) : (
            <Library className="w-3 h-3" />
          )}{' '}
          Sync to library
        </button>
        {syncNote && (
          <span
            aria-live="polite"
            className="text-[9px] font-mono uppercase tracking-widest text-zinc-500 shrink-0 max-w-40 truncate"
          >
            {syncNote}
          </span>
        )}
        <div className="relative shrink-0">
          <label htmlFor="lyria-model" className="sr-only">
            Active model
          </label>
          <select
            id="lyria-model"
            name="lyria-model"
            className="appearance-none rounded-full border border-purple-400/30 bg-purple-500/10 hover:bg-purple-500/15 pl-3 pr-7 py-1 text-[10px] font-bold uppercase tracking-wider text-purple-100 outline-none transition-colors cursor-pointer"
            value={model}
            onChange={(e) => {
              const m = e.target.value;
              // FE-006: patching model alone left the RF-Inversion-era
              // steps/cfg defaults stale on an ARC selection (or vice versa)
              // until the real MAKE dropdown was touched — mirror it here.
              patchParams({ model: m, ...panelModelDefaults(m) });
            }}
            style={{ colorScheme: 'dark' }}
            title="Switch the active model. Pick a Stable Audio model to return to the local generator."
          >
            {panelModelOptions(model, lyriaCheckedOut).map((m) => (
              <option
                key={m.value}
                value={m.value}
                className="bg-[#0a080f] text-zinc-200 normal-case tracking-normal"
              >
                {m.label}
              </option>
            ))}
          </select>
          <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-purple-300/70 text-[8px]">
            ▾
          </span>
        </div>
        {status === 'ready' && !popped && (
          <button
            type="button"
            onClick={popOut}
            className="px-2 py-0.5 rounded border border-zinc-700 hover:bg-white/5 text-zinc-300 text-[9px] font-mono uppercase tracking-widest flex items-center gap-1 shrink-0"
            title="Open Lyria in a separate window"
          >
            <ExternalLink className="w-3 h-3" /> Pop out
          </button>
        )}
      </div>

      <div className="flex-1 relative min-h-0">
        {status === 'loading' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-zinc-400">
            <Loader2 className="w-5 h-5 animate-spin text-zinc-500" />
            <span className="text-sm">Starting Lyria…</span>
            <span className="text-[10px] text-zinc-500">First launch can take a minute.</span>
          </div>
        )}
        {status === 'error' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-zinc-300 px-6">
            <AlertCircle className="w-5 h-5 text-zinc-500" />
            <span className="text-sm">Lyria didn’t start.</span>
            {detail && (
              <span className="text-[10px] text-zinc-500 text-center max-w-md font-mono">{detail}</span>
            )}
            <button
              type="button"
              onClick={() => void loadUrl(true)}
              className="mt-1 px-3 py-1.5 rounded border border-zinc-700 hover:bg-white/5 text-zinc-300 text-xs flex items-center gap-1.5"
            >
              <RefreshCw className="w-3 h-3" /> Retry
            </button>
          </div>
        )}
        {status === 'ready' && popped && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-zinc-300">
            <ExternalLink className="w-5 h-5" />
            <span className="text-[10px] font-mono uppercase tracking-widest">
              Lyria is in a separate window
            </span>
            <button
              type="button"
              onClick={popBackIn}
              className="px-3 py-1.5 rounded border border-zinc-700 hover:bg-white/5 text-zinc-300 text-[9px] font-black uppercase tracking-widest"
            >
              Pop back in
            </button>
          </div>
        )}
        {status === 'ready' && !popped && lyriaSrc && (
          <iframe
            ref={iframeRef}
            src={lyriaSrc}
            // Lyria records nothing and captures nothing; it needs autoplay for
            // its transport and clipboard-write for its prompt/lyrics copy
            // affordances. Nothing else is granted.
            allow="autoplay; clipboard-write"
            // sandbox is deliberately NOT set: this is a sibling app we spawn
            // ourselves on loopback, and it needs full window APIs (AudioContext,
            // localStorage for its own settings).
            className="w-full h-full border-0 bg-black"
            title="Lyria 3 Pro"
          />
        )}
      </div>
    </div>
  );
};
