// Open a saved .sway scene in the SWAY tab.
//
// The embedded SwayCommand cockpit shares theDAW's origin and reads projects
// from localStorage: 'sway:projects' is an object keyed by a `swayproject:/`
// path, 'sway:recents' is a list of {path, name} (SwayCommand
// src/renderer/host/browser-bridge.js, readProject / pushRecent). A scene on
// disk under data/sway-projects is copied into that store under its path, then
// the SWAY tab reloads the cockpit with `?autoplay=<that path>`.

import { getJson } from './apiJson';
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

/** Load the scene `name` (a file stem under data/sway-projects) into the SWAY tab.
 *  Resolves true when the tab was pointed at it; failures are logged and shown
 *  in the status bar. */
export async function openSwayScene(name: string): Promise<boolean> {
  const stem = name.replace(/\.sway$/i, '');
  try {
    const data = await getJson<SwayProjectResponse>(`/api/sway/project?name=${encodeURIComponent(stem)}`);
    const sceneStem = (typeof data.name === 'string' && data.name.trim()) || stem;
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
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logError('sway', `Could not open scene ${stem}: ${msg}`);
    useStatusBarStore.getState().setText(`SCENE OPEN FAILED: ${msg}`);
    return false;
  }
}
