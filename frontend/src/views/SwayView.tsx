/**
 * SWAY tab -- the embedded SwayCommand cockpit plus theDAW's own Sway plumbing.
 *
 * SwayCommand (github.com/danieljtrujillo/SwayCommand) is a standalone Electron
 * app. Its renderer also builds as a plain static bundle, which theDAW's backend
 * serves at /sway-app and this view shows in an iframe -- the same shape as the
 * VJ tab, and for the same reasons: one origin, no Node on the target machine,
 * identical behaviour packaged and in Docker.
 *
 * Three things here are load-bearing rather than stylistic:
 *
 *   1. The iframe src is RELATIVE ('/sway-app/'), not an absolute backend URL.
 *      Chromium throttles a cross-origin hidden iframe to zero rAF callbacks,
 *      and SwayCommand's transport clock runs on rAF -- so a cross-origin embed
 *      freezes its timeline the moment the user switches tabs. Relative also
 *      keeps Web MIDI attribution and storage on theDAW's own origin.
 *
 *   2. The trailing slash is required. Without it the document base is '/' and
 *      the cockpit's relative asset loads (its AudioWorklet in particular)
 *      resolve against theDAW's root and 404.
 *
 *   3. Visibility must be pushed to the child. DAWCenterPanel warms a tab and
 *      then never unmounts it, so effect cleanups here never run on tab switch.
 *      Without an explicit visible:false the cockpit renders WebGL at full rate
 *      for the rest of the session behind whatever tab you are actually using.
 *
 * theDAW owns the only navigator.requestMIDIAccess() in the app (see App.tsx);
 * hardware reaches the cockpit by relay over postMessage, never by the iframe
 * opening its own MIDI access.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ChevronDown, FolderOpen, Loader2, RefreshCw, Waves } from 'lucide-react';
import { subscribeToMidi } from '../state/midiBus';
import { getAnalyser } from '../state/playerStore';
import { logError, logInfo, logWarn } from '../state/logStore';
import { describeHttpError } from '../lib/httpError';
import { getJson } from '../lib/apiJson';
import { basenameOf, dirnameOf, isLocalClient, pathKey, placesApi, type PlaceItem } from '../lib/placesClient';
import { pickFile } from '../lib/storageClient';
import { openSwayScene, openSwaySceneFromPath } from '../lib/swayOpen';
import { useMidiDevicesStore } from '../state/midiDevicesStore';
import { useMidiTriggerStore } from '../state/midiTriggerStore';
import { useStatusBarStore } from '../state/statusBarStore';
import { useSwayOpenStore } from '../state/swayOpenStore';

/** Where the cockpit is mounted. Must match backend/modules/sway/sidecar.py. */
const SWAY_SRC = '/sway-app/';

/** The template the cockpit boots into when the user has no saved project. */
const DEFAULT_TEMPLATE = 'will-i-dream';

/**
 * The iframe URL, with `?autoplay=` so the cockpit boots STRAIGHT into a
 * loaded project. This is load-bearing, not cosmetic: without a loaded
 * project the cockpit's + TRACK button and transport are silent no-ops
 * (its addTrack/play guard on a null timeline), and without the autoplay
 * param its boot shows the SYSTEM splash modal over the deck. The cockpit
 * shares theDAW's localStorage (same origin), so the most recent
 * cockpit-saved project (`swayproject:/` paths resolve from
 * localStorage['sway:projects']) wins over the default template; transient
 * `swaydrop:/` handles die on reload and are skipped.
 *
 * An explicit `requested` target (a scene opened through openSwayScene) boots
 * the cockpit into that project.
 */
function swayBootSrc(requested?: string | null): string {
  let target: string = requested || DEFAULT_TEMPLATE;
  if (!requested) {
    try {
      const recents = JSON.parse(window.localStorage.getItem('sway:recents') ?? '[]') as Array<{ path?: string }>;
      const saved = Array.isArray(recents)
        ? recents.find((r) => typeof r?.path === 'string' && r.path.startsWith('swayproject:/'))
        : null;
      if (saved?.path) target = saved.path;
    } catch {
      /* unreadable recents — boot the default template */
    }
  }
  return `${SWAY_SRC}?autoplay=${encodeURIComponent(target)}`;
}

interface SwayProjectRow {
  name: string;
  path: string;
  mtime: number;
}

const SCENE_MENU_ID = 'sway-open-scene';

const SWAY_FILE_FILTER = 'SwayCommand scene (*.sway)|*.sway|All files (*.*)|*.*';

interface SceneEntry {
  key: string;
  label: string;
  detail: string | null;
  title: string;
  action: boolean;
  choose: () => void;
}

/** Opens a .sway file picked in the native dialog. A failure is logged and
 *  shown in the status bar; a cancel does nothing. */
async function chooseSceneFile(): Promise<void> {
  try {
    const picked = await pickFile({ kind: 'sway', filter: SWAY_FILE_FILTER });
    if (picked.cancelled || !picked.path) return;
    if (!/\.sway$/i.test(picked.path)) {
      useStatusBarStore.getState().setText('SCENE OPEN FAILED: Choose a file that ends in .sway.');
      return;
    }
    await openSwaySceneFromPath(picked.path);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logError('sway', `Could not choose a scene file: ${msg}`);
    useStatusBarStore.getState().setText(`SCENE OPEN FAILED: ${msg}`);
  }
}

/**
 * "Open scene", in three parts:
 *   - the .sway scenes saved under data/sway-projects, newest first, opened by
 *     name through openSwayScene;
 *   - .sway files elsewhere that known places can serve (a Save a copy, a
 *     cockpit save that was downloaded), opened by path;
 *   - on the machine the backend runs on, a row that picks a .sway file in the
 *     native dialog.
 * The lists are read each time the menu opens, so a scene saved, installed or
 * downloaded a moment ago is already in it.
 */
const SceneMenu: React.FC = () => {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<SwayProjectRow[] | null>(null);
  const [files, setFiles] = useState<PlaceItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [activeIdx, setActiveIdx] = useState(0);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const focusPendingRef = useRef(false);
  const seqRef = useRef(0);
  const listId = `${SCENE_MENU_ID}-listbox`;

  const close = useCallback((restoreFocus: boolean) => {
    seqRef.current += 1;
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  const toggle = () => {
    if (open) {
      close(false);
      return;
    }
    const seq = ++seqRef.current;
    setOpen(true);
    setActiveIdx(0);
    setRows(null);
    setFiles([]);
    setError(null);
    focusPendingRef.current = true;
    const saved = getJson<{ projects?: SwayProjectRow[] }>('/api/sway/projects').then(
      (j) => ({ rows: Array.isArray(j.projects) ? j.projects : [], error: null as string | null }),
      (e: unknown) => ({
        rows: [] as SwayProjectRow[],
        error: e instanceof Error ? e.message : String(e),
      }),
    );
    void Promise.all([saved, placesApi.recent({ kind: 'sway', exts: ['.sway'] })]).then(
      ([scenes, recent]) => {
        if (seq !== seqRef.current) return;
        // A scene in data/sway-projects is listed once, by name.
        const inFolder = new Set(scenes.rows.map((r) => pathKey(r.path)));
        setFiles(recent.filter((it) => it.servable && !inFolder.has(pathKey(it.path))));
        setError(scenes.error);
        setRows(scenes.rows);
      },
    );
  };

  // Move focus into the list once it is read, so arrow keys work at once.
  useEffect(() => {
    if (!open || !rows || !focusPendingRef.current) return;
    focusPendingRef.current = false;
    optionRefs.current[0]?.focus({ preventScroll: true });
  }, [open, rows]);

  // Escape, a click outside, or a click into the cockpit closes it. A click in
  // the iframe never reaches this window as a mousedown; the window blurs.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!(e.target instanceof Node && wrapRef.current?.contains(e.target))) close(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      close(true);
    };
    const onBlur = () => close(false);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', onBlur);
    };
  }, [open, close]);

  const entries: SceneEntry[] = rows
    ? [
        ...rows.map((row) => ({
          key: `scene:${row.path}`,
          label: row.name,
          detail: new Date(row.mtime * 1000).toLocaleString(),
          title: row.path,
          action: false,
          choose: () => void openSwayScene(row.name),
        })),
        ...files.map((it) => ({
          key: `file:${it.path}`,
          label: it.name || basenameOf(it.path),
          detail: dirnameOf(it.path),
          title: it.path,
          action: false,
          choose: () => void openSwaySceneFromPath(it.path),
        })),
        // The native dialog opens on the backend's machine, so a browser on
        // another device gets no row for it.
        ...(isLocalClient()
          ? [
              {
                key: 'choose-file',
                label: 'Choose a .sway file',
                detail: null,
                title: 'Opens a .sway file you choose and loads it.',
                action: true,
                choose: () => void chooseSceneFile(),
              },
            ]
          : []),
      ]
    : [];

  const choose = (entry: SceneEntry) => {
    close(false);
    entry.choose();
  };

  const onListKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const n = entries.length;
    if (!n) return;
    const current = Math.min(activeIdx, n - 1);
    let next = -1;
    if (e.key === 'ArrowDown') next = (current + 1) % n;
    else if (e.key === 'ArrowUp') next = (current - 1 + n) % n;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = n - 1;
    if (next < 0) return;
    e.preventDefault();
    setActiveIdx(next);
    optionRefs.current[next]?.focus();
  };

  const loaded = rows !== null;
  const active = Math.min(activeIdx, Math.max(0, entries.length - 1));
  optionRefs.current.length = entries.length;
  const emptyNote = !loaded
    ? null
    : error
      ? `Could not read the saved scenes: ${error}`
      : rows.length === 0 && files.length === 0
        ? 'No scenes are saved yet.'
        : null;

  return (
    <div ref={wrapRef} className="relative">
      <button
        ref={triggerRef}
        id={SCENE_MENU_ID}
        type="button"
        onClick={toggle}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open && entries.length > 0 ? listId : undefined}
        title="Lists saved and recent scenes and loads the one you choose."
        className="inline-flex items-center gap-1 rounded border border-zinc-800 bg-black/40 px-1.5 py-0.5 text-[9px] font-mono text-zinc-200 outline-none hover:border-fuchsia-500/50 focus-visible:border-fuchsia-500/50"
      >
        <FolderOpen className="h-3 w-3 text-fuchsia-300" />
        Open scene
        <ChevronDown className="h-3 w-3 text-zinc-500" />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-20 mt-1 min-w-56 max-w-sm rounded border border-fuchsia-500/30 bg-[#0a080f] shadow-2xl">
          {!loaded ? (
            <p role="status" className="flex items-center gap-1 px-2 py-1.5 text-[9px] font-mono text-zinc-500">
              <Loader2 className="h-3 w-3 animate-spin" /> Reading the saved scenes…
            </p>
          ) : (
            <>
              {emptyNote && (
                <p
                  role="status"
                  className="border-b border-white/5 px-2 py-1.5 text-[9px] font-mono leading-relaxed text-zinc-500"
                >
                  {emptyNote}
                </p>
              )}
              {entries.length > 0 && (
                <div
                  id={listId}
                  role="listbox"
                  aria-label="Scenes"
                  onKeyDown={onListKeyDown}
                  className="flex max-h-72 flex-col overflow-y-auto"
                >
                  {entries.map((entry, i) => (
                    <button
                      key={entry.key}
                      ref={(el) => {
                        optionRefs.current[i] = el;
                      }}
                      id={`${SCENE_MENU_ID}-opt-${i}`}
                      type="button"
                      role="option"
                      aria-selected={i === active}
                      tabIndex={i === active ? 0 : -1}
                      onFocus={() => setActiveIdx(i)}
                      onClick={() => choose(entry)}
                      title={entry.title}
                      className="flex w-full flex-col items-start border-b border-white/5 px-2 py-1 text-left last:border-b-0 hover:bg-fuchsia-500/15 focus:outline-none focus-visible:bg-fuchsia-500/15"
                    >
                      {entry.action ? (
                        <span className="flex max-w-full items-center gap-1 text-[10px] font-mono text-fuchsia-200">
                          <FolderOpen className="h-3 w-3 shrink-0" aria-hidden="true" />
                          {entry.label}
                        </span>
                      ) : (
                        <span className="max-w-full truncate text-[10px] font-mono text-zinc-100">{entry.label}</span>
                      )}
                      {entry.detail && (
                        <span className="max-w-full truncate text-[8px] font-mono text-zinc-500">{entry.detail}</span>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
};

/** Wire-protocol version for every frame exchanged with the cockpit. */
const PROTOCOL = 1;

/** Analysis frames per second pushed to the cockpit. It smooths internally. */
const ANALYSIS_HZ = 30;

type EmbedState = 'checking' | 'ready' | 'unavailable' | 'error';

/**
 * What drives the cockpit's visuals. theDAW's master is the reason to embed at
 * all -- the visuals react to what you are actually making. An input device is
 * what standalone does, kept here for performing to an external source.
 */
type AudioSource = 'thedaw' | 'input';

interface SwayUrlResponse {
  url: string | null;
  mode: string;
  detail?: string | null;
  build?: { sha?: string; builtAt?: string; version?: string } | null;
}

export const SwayView: React.FC = () => {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [embedState, setEmbedState] = useState<EmbedState>('checking');
  const [detail, setDetail] = useState<string | null>(null);
  const [build, setBuild] = useState<SwayUrlResponse['build']>(null);
  const [audioSource, setAudioSource] = useState<AudioSource>('thedaw');
  const [childReady, setChildReady] = useState(false);

  // Readiness is a ref, not just state: the analysis and MIDI loops read it on
  // every frame and a state value captured in a closure would be stale.
  const readyRef = useRef(false);
  // Frames posted before the cockpit says hello are queued, not dropped -- the
  // handshake and the first MIDI event can race.
  const pendingRef = useRef<Record<string, unknown>[]>([]);

  const post = useCallback((payload: Record<string, unknown>) => {
    const w = iframeRef.current?.contentWindow;
    if (!w) return;
    if (!readyRef.current) {
      // Bounded: a cockpit that never reports ready must not grow this forever.
      if (pendingRef.current.length < 128) pendingRef.current.push(payload);
      return;
    }
    try {
      w.postMessage(payload, window.location.origin);
    } catch {
      /* mid-navigation; the next frame retries */
    }
  }, []);

  // --- which project the cockpit boots into ---------------------------------
  // The cockpit reads its boot project only from its URL, so the src is fixed
  // per open request and per probe. Reading recents on every render would
  // change the src, and reload the cockpit, each time the cockpit saved a
  // project.
  //
  // Every probe (the first one and each Retry) bumps `rev`, so an iframe
  // mounted after it reads recents again. An open request boots its scene
  // until a probe runs after it; openSwayScene also put that scene at the top
  // of recents, so the read after a Retry still finds it unless the cockpit
  // has since loaded or saved another project.
  const openRequest = useSwayOpenStore((s) => s.request);
  const [probeMark, setProbeMark] = useState<{ rev: number; nonce: number | null }>({
    rev: 0,
    nonce: null,
  });
  const requestedTarget =
    openRequest && openRequest.nonce !== probeMark.nonce ? openRequest.target : null;
  const bootSrc = useMemo(
    () => swayBootSrc(requestedTarget),
    // probeMark.rev is read by swayBootSrc through localStorage, not as a value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [requestedTarget, probeMark.rev],
  );
  // Keyed on the nonce, so a second request for the same scene reloads too.
  const frameKey = openRequest?.nonce ?? 0;

  // A new request mounts a new iframe. Its document has not said hello, and
  // frames queued for the old one do not apply to it.
  useEffect(() => {
    if (!openRequest) return;
    readyRef.current = false;
    pendingRef.current = [];
    setChildReady(false);
  }, [openRequest]);

  // --- is there a build to show? -------------------------------------------
  const probe = useCallback(async () => {
    // The next iframe reads recents again; a request already booted gives way.
    setProbeMark((p) => ({
      rev: p.rev + 1,
      nonce: useSwayOpenStore.getState().request?.nonce ?? null,
    }));
    setEmbedState('checking');
    try {
      const res = await fetch('/api/sway/url');
      if (!res.ok) {
        setEmbedState('error');
        // "GET /api/sway/url returned HTTP 502." named the request and hid the
        // cause. /api/sway/url never returns 502 -- that status comes from a
        // hop in FRONT of the backend (the packaged app's proxy, or Vite's),
        // meaning the backend was unreachable rather than the cockpit missing.
        // describeHttpError says which hop failed and what to do about it.
        setDetail(await describeHttpError(res));
        return;
      }
      const data = (await res.json()) as SwayUrlResponse;
      if (!data.url) {
        setEmbedState('unavailable');
        setDetail(data.detail ?? 'No SwayCommand build is staged.');
        return;
      }
      setBuild(data.build ?? null);
      setDetail(null);
      setEmbedState('ready');
    } catch (err) {
      setEmbedState('error');
      setDetail(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void probe();
  }, [probe]);

  // --- handshake ------------------------------------------------------------
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      // Two guards, both required: the right window AND the right origin. The
      // cockpit is same-origin, so asserting it costs nothing and shuts out any
      // other frame on the page.
      if (e.source !== iframeRef.current?.contentWindow) return;
      if (e.origin !== window.location.origin) return;
      const d = e.data as { type?: string; v?: number } | null;
      if (!d || typeof d.type !== 'string') return;

      switch (d.type) {
        case 'sway/ready': {
          readyRef.current = true;
          setChildReady(true);
          logInfo('sway', 'SwayCommand cockpit reported ready');
          const queued = pendingRef.current;
          pendingRef.current = [];
          post({ type: 'sway/host-ready', v: PROTOCOL, host: 'theDAW' });
          for (const frame of queued) post(frame);
          break;
        }
        default:
          break;
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [post]);

  // A reloaded iframe has not said hello yet; re-gate until it does.
  const handleIframeLoad = useCallback(() => {
    readyRef.current = false;
    setChildReady(false);
  }, []);

  // --- visibility: this tab is warmed and never unmounted -------------------
  const [docVisible, setDocVisible] = useState(() => !document.hidden);
  useEffect(() => {
    const onVis = () => setDocVisible(!document.hidden);
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  // This view only renders inside DAWCenterPanel's warm block, which hides it
  // with display:none rather than unmounting. An IntersectionObserver would
  // report nothing useful for a display:none subtree, so ask the element.
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [tabVisible, setTabVisible] = useState(true);
  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const check = () => setTabVisible(el.offsetParent !== null);
    check();
    const id = window.setInterval(check, 500);
    return () => window.clearInterval(id);
  }, []);

  const active = docVisible && tabVisible;

  useEffect(() => {
    post({ type: 'sway/visibility', v: PROTOCOL, visible: active });
  }, [active, childReady, post]);

  // --- MIDI relay -----------------------------------------------------------
  // theDAW holds the only MIDIAccess. Relaying raw bytes means the cockpit's
  // own decoding, its factory map and its learned overrides all apply
  // unchanged, with no duplicated semantics on this side.
  useEffect(() => {
    if (embedState !== 'ready') return;
    return subscribeToMidi((msg) => {
      if (!readyRef.current || !active) return;
      post({ type: 'sway/midi', v: PROTOCOL, data: msg.data, t: msg.t });
    });
  }, [embedState, active, post]);

  // --- audio analysis -------------------------------------------------------
  // childReady is a dependency so a cockpit reloaded into another scene is told
  // its audio source again once it says hello.
  useEffect(() => {
    if (embedState !== 'ready') return;
    if (audioSource !== 'thedaw') {
      // The cockpit opens its own input device in this mode; tell it to.
      post({ type: 'sway/audio-source', v: PROTOCOL, source: 'input' });
      return;
    }
    post({ type: 'sway/audio-source', v: PROTOCOL, source: 'host' });
    if (!active) return;

    let raf = 0;
    let lastPost = 0;
    const postDt = 1000 / ANALYSIS_HZ;
    let analyser: AnalyserNode;
    try {
      analyser = getAnalyser();
    } catch (err) {
      logWarn('sway', `analysis bridge unavailable: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    const buf = new Uint8Array(analyser.frequencyBinCount);
    const lowEnd = Math.floor(buf.length * 0.05);
    const midEnd = Math.floor(buf.length * 0.3);
    const SPEC_BINS = 256;
    const specBlock = Math.max(1, Math.floor(buf.length / SPEC_BINS));
    const spec = new Array<number>(SPEC_BINS);

    const tick = () => {
      raf = requestAnimationFrame(tick);
      if (!readyRef.current) return;
      const now = performance.now();
      if (now - lastPost < postDt) return;
      lastPost = now;
      analyser.getByteFrequencyData(buf);
      let bassSum = 0;
      let midSum = 0;
      let highSum = 0;
      for (let i = 0; i < lowEnd; i++) bassSum += buf[i];
      for (let i = lowEnd; i < midEnd; i++) midSum += buf[i];
      for (let i = midEnd; i < buf.length; i++) highSum += buf[i];
      for (let i = 0; i < SPEC_BINS; i++) {
        let sum = 0;
        const start = i * specBlock;
        for (let j = 0; j < specBlock; j++) sum += buf[start + j] ?? 0;
        spec[i] = sum / specBlock / 255;
      }
      post({
        type: 'sway/analysis',
        v: PROTOCOL,
        bass: lowEnd > 0 ? bassSum / lowEnd / 255 : 0,
        mid: midEnd - lowEnd > 0 ? midSum / (midEnd - lowEnd) / 255 : 0,
        high: buf.length - midEnd > 0 ? highSum / (buf.length - midEnd) / 255 : 0,
        volume: (bassSum + midSum + highSum) / (buf.length * 255),
        spectrum: spec,
        t: now,
      });
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [embedState, audioSource, active, childReady, post]);

  const buildLabel = useMemo(() => {
    if (!build) return null;
    const sha = build.sha ? build.sha.slice(0, 7) : null;
    return [build.version, sha].filter(Boolean).join(' @ ') || null;
  }, [build]);

  // What is ACTUALLY hooked up, from the host's own MIDIAccess — the cockpit
  // can only ever say "theDAW (relayed)" because raw bytes are relayed to it,
  // so the real device names have to be surfaced on this side. midiEnabled
  // matters too: with the master gate off there IS no relay, and saying
  // "linked" while hardware is silently ignored is exactly the kind of lie
  // this header used to tell.
  const midiEnabled = useMidiTriggerStore((s) => s.enabled);
  const midiInputs = useMidiDevicesStore((s) => s.inputs);
  const hardwareLabel = useMemo(() => {
    if (!midiEnabled) return 'MIDI off';
    if (midiInputs.length === 0) return 'no MIDI device';
    const sway = midiInputs.find((n) => /sway|audima/i.test(n));
    if (sway) return `Sway: ${sway}`;
    return midiInputs.join(', ');
  }, [midiEnabled, midiInputs]);
  const hardwareTone = !midiEnabled
    ? 'text-amber-400'
    : midiInputs.length === 0
      ? 'text-zinc-500'
      : 'text-emerald-400';

  return (
    <div ref={hostRef} className="absolute inset-0 flex bg-black">
      {/* The SWAY tab is the SwayCommand cockpit, nothing else. theDAW's own
          Sway rail (routing selects, per-dim learn rows, the MIDI enable
          button) used to sit alongside it and duplicated what the cockpit
          already does properly. Its plumbing is unchanged and still feeds
          PERFORM — only the redundant UI is gone. */}
      <div className="relative min-w-0 grow">
        <div data-tour="sway-bar" className="absolute inset-x-0 top-0 z-10 flex items-center gap-2 border-b border-white/10 bg-black/70 px-2 py-1 backdrop-blur">
          <Waves className="h-3 w-3 shrink-0 text-fuchsia-300" />
          <span className="text-[9px] font-black uppercase tracking-[0.2em] text-fuchsia-200">SwayCommand</span>

          <label htmlFor="sway-audio-source" className="ml-3 text-[8px] font-bold uppercase tracking-wider text-zinc-400">
            Audio
          </label>
          <select
            id="sway-audio-source"
            name="sway-audio-source"
            value={audioSource}
            onChange={(e) => setAudioSource(e.target.value as AudioSource)}
            className="rounded border border-zinc-800 bg-black/40 px-1.5 py-0.5 text-[9px] font-mono text-zinc-200 outline-none focus:border-fuchsia-500/50"
          >
            <option value="thedaw">theDAW master</option>
            <option value="input">Input device</option>
          </select>

          <SceneMenu />

          <span className={`ml-auto text-[8px] font-mono ${hardwareTone}`}>{hardwareLabel}</span>
          <span className="text-[8px] font-mono text-zinc-600">
            · {embedState === 'ready' ? (childReady ? 'linked' : 'loading…') : embedState}
            {buildLabel ? ` · ${buildLabel}` : ''}
          </span>
        </div>

        {embedState === 'ready' ? (
          <iframe
            key={frameKey}
            ref={iframeRef}
            src={bootSrc}
            title="SwayCommand"
            onLoad={handleIframeLoad}
            // midi: the cockpit's own learn UI reads relayed frames, but the
            // permissions policy must still allow it for any direct use.
            // microphone: the 'Input device' audio source.
            allow="midi; microphone; autoplay; fullscreen"
            className="absolute inset-0 h-full w-full border-0 bg-black pt-6"
          />
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-8 pt-6 text-center">
            {embedState === 'checking' ? (
              <span className="text-[10px] font-mono uppercase tracking-widest text-zinc-500">
                Looking for a SwayCommand build…
              </span>
            ) : (
              <>
                <AlertTriangle className="h-5 w-5 text-amber-400" />
                <p className="max-w-lg text-[11px] font-mono leading-relaxed text-zinc-300">
                  {detail ?? 'The SwayCommand cockpit is not available.'}
                </p>
                <p className="max-w-lg text-[10px] font-mono leading-relaxed text-zinc-500">
                  SwayCommand also runs as its own desktop application; this tab embeds the same
                  cockpit inside theDAW.
                </p>
                <button
                  type="button"
                  onClick={() => void probe()}
                  className="mt-1 inline-flex items-center gap-1 rounded border border-white/15 px-2 py-1 text-[9px] font-mono uppercase tracking-widest text-zinc-300 hover:border-fuchsia-400/50 hover:text-fuchsia-200"
                >
                  <RefreshCw className="h-3 w-3" /> Retry
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
