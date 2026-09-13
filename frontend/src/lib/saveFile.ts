// Save a file where the user chooses, and remember where it went.
//
// On the machine the backend runs on, a save opens the native Save As dialog
// (it starts in the folder last used for this kind of file), the bytes are
// written to the chosen path by POST /api/places/save, and the path is shown in
// the status bar. The backend records the path, so the next import control and
// picker for that kind already know it.
//
// A remote browser has no access to the backend machine's disk, and a platform
// without a native dialog answers 501; both get an ordinary browser download. A
// backend started before /api/places/save existed answers that route with 404,
// and the file is downloaded the same way.
//
// The suggested name is made safe for a Windows file name here, so callers can
// pass a track title as it is.

import { pickSave, storageErrorStatus } from './storageClient';
import { isLocalClient, notifyPlacesChanged, basenameOf } from './placesClient';
import { describeHttpError } from './httpError';
import { useStatusBarStore } from '../state/statusBarStore';
import { logError, logInfo } from '../state/logStore';

export interface SaveFileOptions {
  /** Where the bytes come from when `blob` is not given (same-origin URL). */
  url?: string;
  blob?: Blob;
  /** File name offered in the dialog; its extension sets the default type. */
  suggestedName: string;
  /** known_paths kind; derived from `suggestedName` when omitted. */
  kind?: string;
  /** Windows-style dialog filter, e.g. "MIDI (*.mid)|*.mid|All files (*.*)|*.*". */
  filter?: string;
  title?: string;
}

export interface SaveFileResult {
  path: string | null;
  cancelled: boolean;
  downloaded: boolean;
}

// Mirrors kind_for_path in backend/lib/known_paths.py. Keep the two in step.
const KIND_BY_EXT: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  const add = (kind: string, exts: string) => {
    for (const e of exts.split(' ')) map[e] = kind;
  };
  add('tasmo', '.tasmo');
  add('gan', '.gan');
  add('sway', '.sway');
  add('ares', '.ares');
  add('daw-project', '.als .rpp .rpp-bak .flp .aup3 .aup .sesx .bwproject .dawproject .avc .logicx .cpr .ptx .pts .swayproj');
  add('audio', '.wav .wave .w64 .rf64 .bwf .caf .aif .aiff .aifc .mp3 .flac .ogg .oga .opus .m4a .aac .wma .webm .weba');
  add('midi', '.mid .midi .smf');
  add('score', '.musicxml .mxl .xml .abc .krn .pdf .svg .alphatex');
  add('lyrics', '.lrc .txt');
  add('json', '.json');
  add('image', '.png .jpg .jpeg .gif .webp .bmp .avif');
  add('video', '.mp4 .mov .mkv .m4v .avi .ogv');
  add('zip', '.zip');
  add('checkpoint', '.safetensors .ckpt .pt .bin');
  add('apk', '.apk');
  return map;
})();

/** Lowercase extension with its dot ('.wav'), or '' when the name has none. */
export function extOfName(name: string): string {
  const base = basenameOf(name);
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(i).toLowerCase() : '';
}

/** The known_paths kind for a file name, by extension. */
export function kindForName(name: string): string {
  return KIND_BY_EXT[extOfName(name)] ?? 'file';
}

// Characters Windows refuses in a file name. Control characters (code points
// below 32) are refused too, and checked by number.
const WINDOWS_FORBIDDEN = '<>:"/\\|?*';

/** `name` as a file name every platform accepts: forbidden characters become
 *  '_', trailing dots and spaces go, and an empty result becomes 'download'. */
export function safeFileName(name: string): string {
  let out = '';
  for (const ch of name) {
    out += ch.charCodeAt(0) < 32 || WINDOWS_FORBIDDEN.includes(ch) ? '_' : ch;
  }
  const cleaned = out.trim().replace(/[. ]+$/, '');
  return cleaned || 'download';
}

function defaultFilter(ext: string): string | undefined {
  if (!ext) return undefined;
  return `${ext.slice(1).toUpperCase()} file (*${ext})|*${ext}|All files (*.*)|*.*`;
}

function anchorDownload(opts: SaveFileOptions): SaveFileResult {
  const href = opts.blob ? URL.createObjectURL(opts.blob) : opts.url;
  if (!href) return { path: null, cancelled: false, downloaded: false };
  const a = document.createElement('a');
  a.href = href;
  a.download = opts.suggestedName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  if (opts.blob) setTimeout(() => URL.revokeObjectURL(href), 10000);
  logInfo('files', `Downloading ${opts.suggestedName}`);
  return { path: null, cancelled: false, downloaded: true };
}

function failed(opts: SaveFileOptions, e: unknown): SaveFileResult {
  const msg = e instanceof Error ? e.message : String(e);
  logError('files', `Could not save ${opts.suggestedName}: ${msg}`);
  useStatusBarStore.getState().setText(`SAVE FAILED: ${msg}`);
  return { path: null, cancelled: false, downloaded: false };
}

export async function saveFile(options: SaveFileOptions): Promise<SaveFileResult> {
  const opts = { ...options, suggestedName: safeFileName(options.suggestedName) };
  if (!opts.blob && !opts.url) return failed(opts, new Error('There is nothing to save.'));
  if (!isLocalClient()) return anchorDownload(opts);

  const kind = opts.kind ?? kindForName(opts.suggestedName);
  const ext = extOfName(opts.suggestedName);

  let picked: { path: string | null; cancelled: boolean };
  try {
    picked = await pickSave({
      kind,
      initialName: opts.suggestedName,
      defaultExt: ext ? ext.slice(1) : undefined,
      filter: opts.filter ?? defaultFilter(ext),
      title: opts.title,
    });
  } catch (e) {
    if (storageErrorStatus(e) === 501) return anchorDownload(opts);
    return failed(opts, e);
  }
  if (picked.cancelled || !picked.path) return { path: null, cancelled: true, downloaded: false };

  // A url source can take a while to build (a bundle zip); say where it is going.
  useStatusBarStore.getState().setText(`SAVING: ${picked.path}`);
  try {
    let blob = opts.blob;
    if (!blob) {
      const src = await fetch(opts.url as string);
      if (!src.ok) throw new Error(await describeHttpError(src));
      blob = await src.blob();
    }
    const form = new FormData();
    form.append('file', blob, opts.suggestedName);
    form.append('path', picked.path);
    form.append('kind', kind);
    const res = await fetch('/api/places/save', { method: 'POST', body: form });
    if (res.status === 501 || res.status === 404) return anchorDownload({ ...opts, blob });
    if (!res.ok) throw new Error(await describeHttpError(res));
    const data = (await res.json()) as { path?: string };
    const path = data.path || picked.path;
    useStatusBarStore.getState().setText(`SAVED: ${path}`);
    logInfo('files', `Saved ${opts.suggestedName} to ${path}`);
    notifyPlacesChanged();
    return { path, cancelled: false, downloaded: false };
  } catch (e) {
    return failed(opts, e);
  }
}
