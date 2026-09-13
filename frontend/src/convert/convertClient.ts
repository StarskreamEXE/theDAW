/**
 * Client for the backend generic FFmpeg convert module (`/api/convert`).
 *
 * The catalog (target formats + source-kind -> target-kind rules) is fetched
 * once and cached. Converting a library entry streams the result back as bytes
 * and saves them through saveFile, so the path the user picks is remembered.
 * Large media is read via arrayBuffer() rather than blob() (the latter spills
 * to a disk-backed store that fails under disk pressure — see fetchRetry.ts).
 *
 * The file-name helpers below name any saved copy of a library entry.
 */

import { extOfName, saveFile, type SaveFileResult } from '../lib/saveFile';

export interface ConvertFormat {
  id: string;
  ext: string;
  kind: 'audio' | 'video' | 'image';
  label: string;
  mime: string;
}

export interface ConvertCatalog {
  formats: ConvertFormat[];
  rules: Record<string, string[]>;
}

let _catalog: ConvertCatalog | null = null;
let _inflight: Promise<ConvertCatalog> | null = null;

export async function loadConvertFormats(): Promise<ConvertCatalog> {
  if (_catalog) return _catalog;
  if (_inflight) return _inflight;
  _inflight = (async () => {
    const res = await fetch('/api/convert/formats');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const catalog = (await res.json()) as ConvertCatalog;
    _catalog = catalog;
    _inflight = null;
    return catalog;
  })().catch((e) => {
    _inflight = null;
    throw e;
  });
  return _inflight;
}

/** The target formats that make sense for a given source media kind. */
export function formatsForKind(catalog: ConvertCatalog, kind: string): ConvertFormat[] {
  const allowed = new Set(catalog.rules[kind] ?? ['audio', 'video', 'image']);
  return catalog.formats.filter((f) => allowed.has(f.kind));
}

/**
 * A file name for a library entry saved as `ext` ('wav' or '.wav'): the title
 * with the characters Windows refuses in a name replaced by '_', then the
 * extension unless the title already ends in it.
 */
export function entryFileName(title: string, ext: string, fallback = 'track'): string {
  const dotted = ext ? (ext.startsWith('.') ? ext : `.${ext}`).toLowerCase() : '';
  const safe = (title || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim().slice(0, 120) || fallback;
  return dotted && !safe.toLowerCase().endsWith(dotted) ? `${safe}${dotted}` : safe;
}

/** The name a library entry's own audio file is saved under: its title with
 *  the stored file's extension. */
export function entryAudioFileName(entry: { title: string; audioFilename?: string }): string {
  return entryFileName(entry.title, extOfName(entry.audioFilename ?? ''));
}

/**
 * Convert a library entry to the given format and save the result.
 * Resolves with the save's outcome once the file is written, downloaded or the
 * dialog is cancelled; rejects with a readable message when the conversion
 * itself fails.
 */
export async function convertLibraryEntry(
  entryId: string,
  format: ConvertFormat,
  title: string,
): Promise<SaveFileResult> {
  const res = await fetch(`/api/convert/library/${encodeURIComponent(entryId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ format: format.id }),
  });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const j = await res.json();
      if (j?.detail) detail = String(j.detail);
    } catch {
      /* response had no JSON body */
    }
    throw new Error(detail);
  }

  const buf = await res.arrayBuffer();
  const blob = new Blob([buf], { type: res.headers.get('content-type') ?? format.mime });
  return saveFile({
    blob,
    suggestedName: entryFileName(title, format.ext, 'converted'),
    kind: format.kind,
  });
}
