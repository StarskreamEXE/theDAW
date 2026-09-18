/**
 * A library track's facts as DETAILS and the library's INFO tab show them: the
 * analysis row, the notation identity, and the formatters both use.
 */

/** One row of `/api/analysis/{id}`. The route answers `{status: 'pending'}`
 *  for a track nothing has analysed yet. */
export interface AnalysisRow {
  bpm: number | null;
  key: string | null;
  scale: string | null;
  key_confidence: number | null;
  pitch_mean_hz: number | null;
  pitch_std_hz: number | null;
  loudness_lufs: number | null;
  rms_db: number | null;
  bars_estimated: number | null;
  genre: string | null;
  genre_confidence: number | null;
  embedded_tags_json: string | null;
  ffprobe_json: string | null;
  analyzed_at: number | null;
}

/** Artist / song as the notation module reads this entry: `auto_*` is what was
 * parsed out of the filename, `override_*` is what the user typed here (empty
 * when nothing has been corrected). */
export interface NotationIdentity {
  override_artist: string;
  override_title: string;
  auto_artist: string;
  auto_title: string;
}

export const fmtDuration = (sec: number): string => {
  if (!Number.isFinite(sec) || sec <= 0) return '--:--';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.floor((sec % 1) * 1000);
  return `${m}:${s.toString().padStart(2, '0')}.${ms.toString().padStart(3, '0').slice(0, 2)}`;
};

export const fmtSize = (bytes: number): string => {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
};

export const fmtDate = (iso: string): string => {
  try {
    const d = new Date(iso);
    return d.toLocaleString();
  } catch { return iso; }
};

/** The first sung line of a lyric (markers like [Chorus] skipped). */
export const firstLyricLine = (text: string): string => {
  for (const raw of (text || '').split(/\r?\n/)) {
    const t = raw.trim();
    if (!t || /^[[(][^\])]{1,40}[\])]$/.test(t)) continue;
    return t;
  }
  return '';
};

/** Ask the notation module how it reads this entry's name. Returns null when
 * the endpoint is unavailable, which leaves the fields usable and the
 * placeholders empty rather than surfacing an error the user cannot act on. */
export async function fetchIdentity(entryId: string): Promise<NotationIdentity | null> {
  try {
    const res = await fetch(`/api/notation/${encodeURIComponent(entryId)}/identity`);
    if (!res.ok) return null;
    const payload = (await res.json()) as Partial<NotationIdentity>;
    return {
      override_artist: payload.override_artist ?? '',
      override_title: payload.override_title ?? '',
      auto_artist: payload.auto_artist ?? '',
      auto_title: payload.auto_title ?? '',
    };
  } catch {
    return null;
  }
}

export function safeJsonPretty(jsonText: string): string {
  try {
    return JSON.stringify(JSON.parse(jsonText), null, 2);
  } catch {
    return jsonText;
  }
}

/** ffprobe's summary block when it has one, else the whole payload, pretty. */
export function safeFfprobeSummary(jsonText: string): string {
  try {
    const parsed = JSON.parse(jsonText) as {
      _summary?: Record<string, unknown>;
      streams?: Array<Record<string, unknown>>;
      format?: Record<string, unknown>;
    };
    if (parsed._summary) {
      return JSON.stringify(parsed._summary, null, 2);
    }
    return JSON.stringify(parsed, null, 2);
  } catch {
    return jsonText;
  }
}

/** The track's analysis, or null when it has not been analysed (the route's
 *  `pending`), when the route fails, or when the request is refused. */
export async function fetchAnalysis(entryId: string): Promise<AnalysisRow | null> {
  try {
    const res = await fetch(`/api/analysis/${encodeURIComponent(entryId)}`);
    if (!res.ok) return null;
    const payload = (await res.json()) as AnalysisRow & { status?: string };
    return payload.status === 'pending' ? null : payload;
  } catch {
    return null;
  }
}
