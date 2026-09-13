// Known places client -- thin wrappers over /api/places.
//
// The backend remembers every file path the app itself touched: a download the
// desktop shell finished, a Save As, a native pick, an asset install, a project
// save. These helpers read that memory back so an import control can offer the
// file straight away and a picker can open in the folder it was last used in.
//
// Read helpers (folder, recent, record) answer with an empty value when the
// backend cannot, so a control that only offers a shortcut never breaks the
// control it sits beside. Actions the user asked for (reveal, projectsDir,
// setProjectsDir) throw with the backend's own message.

import { getJson, postJson, putJson } from './apiJson';
import { describeHttpError } from './httpError';

export interface PlaceItem {
  path: string;
  name: string;
  kind: string;
  source: string;
  /** Unix seconds when the path was recorded. */
  at: number;
  /** True when /api/places/file will serve this path's bytes. */
  servable: boolean;
}

/** Fired on `window` whenever this client learns a new path was recorded. */
export const PLACES_CHANGED_EVENT = 'thedaw:places-changed';

export function notifyPlacesChanged(): void {
  if (typeof window === 'undefined') return;
  try {
    window.dispatchEvent(new Event(PLACES_CHANGED_EVENT));
  } catch {
    /* no event support (non-DOM runtime): nothing is listening */
  }
}

export const placesApi = {
  /** The folder a picker for `kind` should open in, or null when none is known. */
  async folder(kind: string): Promise<string | null> {
    try {
      const data = await getJson<{ kind: string; folder: string | null }>(
        `/api/places/folder?kind=${encodeURIComponent(kind)}`,
      );
      return data.folder ?? null;
    } catch {
      return null;
    }
  },

  /** Recently recorded paths that still exist, newest first. */
  async recent(opts?: { kind?: string; exts?: string[]; limit?: number }): Promise<PlaceItem[]> {
    const params = new URLSearchParams();
    if (opts?.kind) params.set('kind', opts.kind);
    const exts = normalizeExts(opts?.exts);
    if (exts.length) params.set('exts', exts.join(','));
    if (opts?.limit) params.set('limit', String(opts.limit));
    const qs = params.toString();
    try {
      const data = await getJson<{ items?: PlaceItem[] }>(`/api/places/recent${qs ? `?${qs}` : ''}`);
      return Array.isArray(data.items) ? data.items : [];
    } catch {
      return [];
    }
  },

  /** Remember a path the client learned about. Resolves `{recorded: false}` on any failure. */
  async record(path: string, kind?: string): Promise<{ recorded: boolean; kind: string | null }> {
    try {
      const data = await postJson<{ recorded: boolean; kind: string | null }>('/api/places/record', {
        path,
        kind: kind || undefined,
      });
      if (data.recorded) notifyPlacesChanged();
      return data;
    } catch {
      return { recorded: false, kind: null };
    }
  },

  /** Show the path selected in the OS file manager. Throws when it is missing. */
  async reveal(path: string): Promise<void> {
    await postJson<{ status: string; path: string }>('/api/places/reveal', { path });
  },

  /** URL that serves a servable recorded file's bytes. */
  fileUrl(path: string): string {
    return `/api/places/file?path=${encodeURIComponent(path)}`;
  },

  /** The folder new projects and installed project assets go to. */
  async projectsDir(): Promise<string> {
    const data = await getJson<{ path: string }>('/api/places/projects-dir');
    return data.path;
  },

  /** Store a new projects folder. The path must be absolute. */
  async setProjectsDir(path: string): Promise<string> {
    const data = await putJson<{ path: string }>('/api/places/projects-dir', { path });
    return data.path;
  },
};

/** Lowercase extensions with a leading dot; MIME types and wildcards are dropped. */
export function normalizeExts(exts: string[] | undefined): string[] {
  if (!exts) return [];
  const out: string[] = [];
  for (const raw of exts) {
    const e = raw.trim().toLowerCase();
    if (!e || e.includes('/') || e.includes('*')) continue;
    const dotted = e.startsWith('.') ? e : `.${e}`;
    if (!out.includes(dotted)) out.push(dotted);
  }
  return out;
}

/** Fetch a servable recorded file as a File named after it. */
export async function fileFromPlace(item: PlaceItem): Promise<File> {
  const res = await fetch(placesApi.fileUrl(item.path));
  if (!res.ok) throw new Error(await describeHttpError(res));
  const blob = await res.blob();
  return new File([blob], item.name || basenameOf(item.path), { type: blob.type });
}

/** The folder part of a Windows or POSIX path; '' for a bare file name. */
export function dirnameOf(p: string): string {
  if (!p) return '';
  const isSep = (c: string) => c === '/' || c === '\\';
  // Drop trailing separators, keeping a bare root ('/' or 'C:\').
  let end = p.length;
  while (end > 1 && isSep(p[end - 1]) && !(end === 3 && p[1] === ':')) end -= 1;
  const body = p.slice(0, end);
  const i = Math.max(body.lastIndexOf('/'), body.lastIndexOf('\\'));
  if (i < 0) return '';
  if (i === 0) return body[0];
  if (i === 2 && body[1] === ':') return body.slice(0, 3);
  return body.slice(0, i);
}

/** The last segment of a Windows or POSIX path. */
export function basenameOf(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, '');
  const i = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return i < 0 ? trimmed : trimmed.slice(i + 1);
}

/** True when this page runs on the machine the backend runs on. */
export function isLocalClient(): boolean {
  if (typeof window === 'undefined') return false;
  const api = (window as unknown as { electronAPI?: { isElectron?: boolean } }).electronAPI;
  if (api?.isElectron) return true;
  const host = window.location?.hostname ?? '';
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
}
