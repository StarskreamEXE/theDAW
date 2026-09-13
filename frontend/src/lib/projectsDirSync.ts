// Which projects folder a client shows, and whether it hands its own to the backend.
//
// The backend holds the one projects folder that asset installs, backups and
// every client use. A browser may still hold a folder it chose before the
// backend kept one (localStorage 'thedaw-projects-dir'). That folder is handed
// over once, and only while no client has set a folder on the backend. Once
// one has, every client shows the backend's folder, so a second browser with an
// old value cannot replace a folder the user chose in another client.

export interface BackendProjectsDir {
  path: string;
  /** True when a client stored a folder on the backend. */
  configured: boolean;
}

export interface ProjectsDirInput {
  /** This client's stored folder ('' when none). */
  local: string;
  backend: BackendProjectsDir;
  /** True once this client's folder reached the backend or was replaced by it. */
  synced: boolean;
}

export interface ProjectsDirDecision {
  /** The folder the client shows. */
  show: string;
  /** The folder to store on the backend, or null for no request. */
  push: string | null;
  /** Set the synced flag now. A push sets it only after the backend accepts it. */
  markSynced: boolean;
}

/** A drive path ('C:\x') or a single-rooted path ('/x', '\x'). Shares ('\\server',
 *  '//server') and device paths ('\\?\', '\\.\') are refused by the backend. */
export function looksAbsolute(p: string): boolean {
  const s = p.trim();
  if (/^[a-zA-Z]:[\\/]/.test(s)) return true;
  return /^[\\/](?![\\/])/.test(s);
}

export function decideProjectsDir({ local, backend, synced }: ProjectsDirInput): ProjectsDirDecision {
  const localDir = local.trim();
  const backendDir = (backend.path ?? '').trim();
  if (backend.configured) {
    return { show: backendDir || localDir, push: null, markSynced: true };
  }
  if (!synced && localDir && looksAbsolute(localDir) && localDir !== backendDir) {
    return { show: localDir, push: localDir, markSynced: false };
  }
  return { show: backendDir || localDir, push: null, markSynced: true };
}
