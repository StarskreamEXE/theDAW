// Open a saved .sway scene in the SWAY tab.
//
// The embedded SwayCommand cockpit shares theDAW's origin and reads projects
// from localStorage: 'sway:projects' is an object keyed by a `swayproject:/`
// path, 'sway:recents' is a list of {path, name} (SwayCommand
// src/renderer/host/browser-bridge.js, readProject / pushRecent). A scene is
// read through GET /api/sway/project, copied into that store under its path,
// then the SWAY tab reloads the cockpit with `?autoplay=<that path>`.
//
// openSwayScene reads a scene under data/sway-projects by name.
// openSwaySceneFromPath reads a .sway anywhere on disk that the backend already
// knows the app saved, installed, picked or downloaded.

import { getJson } from './apiJson';
import { basenameOf } from './placesClient';
import { logError, logInfo } from '../state/logStore';
import { useStatusBarStore } from '../state/statusBarStore';
import { useSwayOpenStore } from '../state/swayOpenStore';
import { useAppUiStore } from '../state/appUiStore';

const PROJECTS_KEY = 'sway:projects';
const RECENTS_KEY = 'sway:recents';
const RECENTS_CAP = 10;

interface SwayProjectResponse {
  name: string;
  path: string;
  doc: unknown;
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as T | null;
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

/** Put the scene the backend returned into the cockpit's store and point the
 *  SWAY tab at it. Throws when browser storage refuses the scene. */
function handToCockpit(data: SwayProjectResponse, fallbackStem: string): void {
  const sceneStem = (typeof data.name === 'string' && data.name.trim()) || fallbackStem;
  const target = `swayproject:/${sceneStem}.sway`;

  const projects = readJson<Record<string, unknown>>(PROJECTS_KEY, {});
  const store = projects && typeof projects === 'object' && !Array.isArray(projects) ? projects : {};
  store[target] = data.doc;
  try {
    window.localStorage.setItem(PROJECTS_KEY, JSON.stringify(store));
  } catch {
    throw new Error('Browser storage is full, so the scene cannot be handed to the cockpit.');
  }

  const recents = readJson<Array<{ path?: string; name?: string }>>(RECENTS_KEY, []);
  const list = (Array.isArray(recents) ? recents : []).filter((r) => r && r.path !== target);
  list.unshift({ path: target, name: `${sceneStem}.sway` });
  try {
    window.localStorage.setItem(RECENTS_KEY, JSON.stringify(list.slice(0, RECENTS_CAP)));
  } catch {
    /* the project entry above is what the cockpit boots from */
  }

  useSwayOpenStore.getState().openTarget(target);
  useAppUiStore.getState().setCenterTab('sway');
  logInfo('sway', `Opening scene ${sceneStem} from ${data.path}`);
}

function reportFailure(label: string, e: unknown): false {
  const msg = e instanceof Error ? e.message : String(e);
  logError('sway', `Could not open scene ${label}: ${msg}`);
  useStatusBarStore.getState().setText(`SCENE OPEN FAILED: ${msg}`);
  return false;
}

/** Load the scene `name` (a file stem under data/sway-projects) into the SWAY tab.
 *  Resolves true when the tab was pointed at it; failures are logged and shown
 *  in the status bar. */
export async function openSwayScene(name: string): Promise<boolean> {
  const stem = name.replace(/\.sway$/i, '');
  try {
    const data = await getJson<SwayProjectResponse>(`/api/sway/project?name=${encodeURIComponent(stem)}`);
    handToCockpit(data, stem);
    return true;
  } catch (e) {
    return reportFailure(stem, e);
  }
}

/** Load the .sway file at `path` into the SWAY tab. The backend answers only for
 *  a .sway it recorded as saved, installed, picked or downloaded. Resolves true
 *  when the tab was pointed at it; failures are logged and shown in the status
 *  bar. */
export async function openSwaySceneFromPath(path: string): Promise<boolean> {
  const fileName = basenameOf(path || '');
  const stem = fileName.replace(/\.sway$/i, '');
  try {
    if (!path || !path.trim()) throw new Error('No scene file was named.');
    const data = await getJson<SwayProjectResponse>(`/api/sway/project?path=${encodeURIComponent(path)}`);
    handToCockpit(data, stem);
    return true;
  } catch (e) {
    return reportFailure(fileName || path, e);
  }
}
