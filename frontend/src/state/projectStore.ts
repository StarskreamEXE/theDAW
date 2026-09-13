import { create } from 'zustand';
import {
  projectApi,
  type ProjectManifest,
  type RecentItem,
  type TasmoProjectInput,
  type TasmoProjectLoaded,
  type TasmoTrackInput,
} from '../lib/projectClient';
import { placesApi } from '../lib/placesClient';
import { decideProjectsDir, looksAbsolute, type BackendProjectsDir } from '../lib/projectsDirSync';
import { mergeRecentProjects } from '../lib/recentProjects';
import type { PerformRoutingSnapshot } from './performRouting';
import { logError, logInfo, logWarn } from './logStore';
import { useStatusBarStore } from './statusBarStore';
import { useEditorStore } from './editorStore';
import {
  loadProjectIntoEditor,
  captureEditorSession,
  captureControllerMappings,
} from '../lib/projectImport';

type ProjectTab = 'save' | 'open';

interface ProjectState {
  isOpen: boolean;
  tab: ProjectTab;
  busy: boolean;
  error: string | null;
  recent: RecentItem[];

  // Save form
  projectName: string;
  tempo: number;
  embedAudio: boolean;
  savePath: string;
  pendingTracks: TasmoTrackInput[];
  sourceDaw: string | null;
  importWarnings: string[];
  // Perform-tab routing carried from a Perform save seed, so save() persists it
  // into the .tasmo alongside the imported project structure.
  pendingPerformRouting: PerformRoutingSnapshot | null;
  lastSaved: { path: string; manifest: ProjectManifest } | null;

  // Open form
  openPath: string;
  loaded: { project: TasmoProjectLoaded; manifest: ProjectManifest } | null;

  // Default folder for .tasmo saves (changeable; persisted in localStorage).
  defaultDir: string;

  open: (tab?: ProjectTab, seed?: TasmoProjectInput) => void;
  close: () => void;
  setTab: (tab: ProjectTab) => void;
  setProjectName: (name: string) => void;
  setTempo: (tempo: number) => void;
  setEmbedAudio: (embed: boolean) => void;
  setSavePath: (path: string) => void;
  setOpenPath: (path: string) => void;
  setDefaultDir: (dir: string) => void;
  ensureDefaultDir: () => Promise<void>;
  prefillSavePath: () => Promise<void>;
  refreshRecent: () => Promise<void>;
  save: () => Promise<void>;
  loadPath: (path?: string) => Promise<void>;
  clearError: () => void;
}

const PROJECTS_DIR_KEY = 'thedaw-projects-dir';
// Set once this browser's folder has reached the backend, or the backend's
// folder has replaced it. From then on the backend's projects folder is the one
// every client and asset install uses.
const PROJECTS_DIR_SYNCED_KEY = 'thedaw-projects-dir-synced';

const readLocal = (key: string): string => {
  try {
    return localStorage.getItem(key) || '';
  } catch {
    return '';
  }
};

const writeLocal = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore — non-persistent fallback */
  }
};

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

const applyDefaultDir = (dir: string) => {
  writeLocal(PROJECTS_DIR_KEY, dir);
  useProjectStore.setState({ defaultDir: dir });
};

// The folder field calls setDefaultDir on every keystroke; only the value the
// user stops on is sent to the backend.
const PUSH_DELAY_MS = 600;
let pushTimer: ReturnType<typeof setTimeout> | null = null;

const pushProjectsDir = (dir: string) => {
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = null;
  const target = dir.trim();
  if (!target || !looksAbsolute(target)) return;
  pushTimer = setTimeout(() => {
    pushTimer = null;
    placesApi.setProjectsDir(target).then(
      () => writeLocal(PROJECTS_DIR_SYNCED_KEY, '1'),
      (e: unknown) => logWarn('project', `Projects folder ${target} was not stored: ${errMsg(e)}`),
    );
  }, PUSH_DELAY_MS);
};

// Boot, an asset install, the backup dialog and a save prefill can all ask at
// once; they share one read, so a handover is never sent twice.
let ensureInFlight: Promise<void> | null = null;

// The backend holds the projects folder, so asset installs and every client
// use the same one. decideProjectsDir says whether this browser shows the
// backend's folder or hands its own over.
async function syncProjectsDir(): Promise<void> {
  const state = () => useProjectStore.getState();
  const before = state().defaultDir;
  let backend: BackendProjectsDir;
  try {
    const res = await placesApi.projectsDir();
    backend = {
      path: typeof res?.path === 'string' ? res.path : '',
      configured: res?.configured === true,
    };
  } catch {
    // A backend without /api/places: keep this browser's folder, or take the
    // project module's default.
    if (state().defaultDir.trim()) return;
    try {
      const res = await projectApi.defaultDir();
      if (res?.path && !state().defaultDir.trim()) applyDefaultDir(res.path);
    } catch {
      /* no backend default available */
    }
    return;
  }
  // The user changed the folder while the request ran; that edit is the one
  // on its way to the backend.
  if (state().defaultDir !== before || pushTimer) return;
  const decision = decideProjectsDir({
    local: before,
    backend,
    synced: Boolean(readLocal(PROJECTS_DIR_SYNCED_KEY)),
  });
  if (decision.push) {
    try {
      const stored = await placesApi.setProjectsDir(decision.push);
      writeLocal(PROJECTS_DIR_SYNCED_KEY, '1');
      if (state().defaultDir === before) applyDefaultDir(stored);
    } catch (e) {
      // Keep this browser's folder and try again the next time it is needed.
      logWarn('project', `Projects folder ${decision.push} was not stored: ${errMsg(e)}`);
    }
    return;
  }
  if (decision.markSynced) writeLocal(PROJECTS_DIR_SYNCED_KEY, '1');
  if (decision.show && decision.show !== before) applyDefaultDir(decision.show);
}

// A slower, older refresh must not replace the list a newer one set.
let recentSeq = 0;

const status = (text: string) => useStatusBarStore.getState().setText(text);

export const useProjectStore = create<ProjectState>()((set, get) => ({
  isOpen: false,
  tab: 'save',
  busy: false,
  error: null,
  recent: [],

  projectName: 'Untitled',
  tempo: 120,
  embedAudio: false,
  savePath: '',
  pendingTracks: [],
  sourceDaw: null,
  importWarnings: [],
  pendingPerformRouting: null,
  lastSaved: null,

  openPath: '',
  loaded: null,

  defaultDir: readLocal(PROJECTS_DIR_KEY),

  open: (tab = 'save', seed) => {
    if (seed) {
      set({
        projectName: seed.project_name || 'Untitled',
        tempo: seed.tempo ?? 120,
        pendingTracks: seed.tracks ?? [],
        sourceDaw: seed.source_daw ?? null,
        importWarnings: seed.import_warnings ?? [],
        pendingPerformRouting: seed.perform_routing ?? null,
        lastSaved: null,
      });
    }
    set({ isOpen: true, tab, error: null });
    void get().refreshRecent();
    if (tab === 'save') void get().prefillSavePath();
  },

  close: () => set({ isOpen: false }),
  setTab: (tab) => {
    set({ tab, error: null });
    if (tab === 'save') void get().prefillSavePath();
  },
  setProjectName: (projectName) => set({ projectName }),
  setTempo: (tempo) => set({ tempo: Number.isFinite(tempo) ? tempo : 120 }),
  setEmbedAudio: (embedAudio) => set({ embedAudio }),
  setSavePath: (savePath) => set({ savePath, error: null }),
  setOpenPath: (openPath) => set({ openPath, error: null }),

  setDefaultDir: (defaultDir) => {
    applyDefaultDir(defaultDir);
    pushProjectsDir(defaultDir);
  },

  ensureDefaultDir: () => {
    if (!ensureInFlight) {
      ensureInFlight = syncProjectsDir()
        .catch((e: unknown) => logWarn('project', `Projects folder was not read: ${errMsg(e)}`))
        .finally(() => {
          ensureInFlight = null;
        });
    }
    return ensureInFlight;
  },

  // Prefill the save path from the default folder + project name, so the user can
  // hit Save without browsing (and still change it). No-op if a path is set.
  prefillSavePath: async () => {
    if (get().savePath.trim()) return;
    await get().ensureDefaultDir();
    const dir = get().defaultDir.trim();
    if (!dir || get().savePath.trim()) return;
    const name =
      (get().projectName || 'project').replace(/[^a-zA-Z0-9 _-]/g, '').trim() || 'project';
    const sep = dir.includes('\\') ? '\\' : '/';
    const base = dir.endsWith(sep) ? dir : dir + sep;
    set({ savePath: `${base}${name}.tasmo` });
  },

  // Every .tasmo the app wrote or opened: the project router's list, plus the
  // .tasmo files known places holds, such as a Save a copy of a project asset.
  refreshRecent: async () => {
    const seq = ++recentSeq;
    const [projects, places] = await Promise.all([
      projectApi.recent().then(
        (rows) => (Array.isArray(rows) ? rows : []),
        (e: unknown) => {
          logError('project', e instanceof Error ? e.message : 'Failed to list recent projects.');
          return null;
        },
      ),
      placesApi.recent({ exts: ['.tasmo'] }),
    ]);
    if (seq !== recentSeq) return;
    // Neither list answered: keep the rows already shown.
    if (projects === null && places.length === 0) return;
    set({ recent: mergeRecentProjects(projects ?? [], places) });
  },

  save: async () => {
    const {
      projectName,
      tempo,
      embedAudio,
      savePath,
      pendingTracks,
      sourceDaw,
      importWarnings,
      pendingPerformRouting,
    } = get();
    if (!savePath.trim()) {
      set({ error: 'Choose where to save the .tasmo file.' });
      return;
    }
    const name = projectName.trim() || 'Untitled';
    const path = savePath.trim();
    set({ busy: true, error: null });
    try {
      // Two distinct save paths:
      //  - An imported DAW project (pendingTracks seeded): save that structure,
      //    linking/embedding the sample files already on disk.
      //  - Otherwise: capture the LIVE EDIT session, embedding each clip's audio
      //    bytes (editor clips are in-memory blobs with no path to link).
      let res: { path: string; manifest: ProjectManifest };
      if (pendingTracks.length > 0) {
        const project: TasmoProjectInput = {
          project_name: name,
          tempo,
          tracks: pendingTracks,
          source_daw: sourceDaw,
          import_warnings: importWarnings,
          controller_mappings: captureControllerMappings(),
          perform_routing: pendingPerformRouting,
        };
        logInfo('project', `POST /api/project/save — ${path} embed=${embedAudio}`);
        res = await projectApi.save(project, path, embedAudio);
      } else {
        const session = captureEditorSession();
        if (session.clipCount === 0) {
          set({
            busy: false,
            error:
              'Nothing to save yet — the EDIT timeline is empty. Generate, import, or record audio first.',
          });
          status('PROJECT SAVE SKIPPED: timeline is empty');
          return;
        }
        const project: TasmoProjectInput = {
          project_name: name,
          tempo: session.bpm,
          tracks: session.tracks,
          controller_mappings: session.controllerMappings ?? null,
        };
        logInfo(
          'project',
          `POST /api/project/save-session — ${path} (${session.tracks.length} tracks, ${session.clipCount} clips embedded)`,
        );
        res = await projectApi.saveSession(project, path, session.files);
      }
      set({ busy: false, lastSaved: { path: res.path, manifest: res.manifest } });
      // The document now matches what is on disk — clear the unsaved-changes guard.
      useEditorStore.getState().markSaved();
      status(`PROJECT SAVED (${res.manifest.audio_mode}): ${res.path}`);
      void get().refreshRecent();
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Save failed.';
      set({ busy: false, error: msg });
      status(`PROJECT SAVE FAILED: ${msg}`);
      logError('project', msg);
    }
  },

  loadPath: async (path) => {
    const target = (path ?? get().openPath).trim();
    if (!target) {
      set({ error: 'Choose a .tasmo file to open.' });
      return;
    }
    set({ busy: true, error: null, openPath: target });
    try {
      logInfo('project', `POST /api/project/load — ${target}`);
      const res = await projectApi.load(target);
      set({ loaded: res });
      // Actually bring the project into theDAW: build tracks + clips on the EDIT
      // timeline (this is what "Open" must do — a preview alone isn't opening it).
      // The helper also switches the center view to EDIT.
      const summary = await loadProjectIntoEditor(res.project);
      const skippedNote = summary.skipped
        ? ` (${summary.skipped} clip(s) skipped — missing audio or empty MIDI)`
        : '';
      // The project is now open in theDAW; close the modal and report via the
      // status bar + log (a warning there stays visible after the modal closes).
      set({ busy: false, isOpen: false, error: null });
      status(
        `PROJECT OPENED: ${res.project.project_name} — ${summary.tracks} track(s), ${summary.clips} clip(s)${skippedNote}`,
      );
      void get().refreshRecent();
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Open failed.';
      set({ busy: false, error: msg });
      status(`PROJECT OPEN FAILED: ${msg}`);
      logError('project', msg);
    }
  },

  clearError: () => set({ error: null }),
}));
