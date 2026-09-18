/**
 * The rhythm engine's result, and the report a reader can paste into notes.
 *
 * Apart from the block that shows it because a module exporting a component
 * beside plain functions cannot be hot-reloaded: React Fast Refresh gives up on
 * it and reloads the whole page on every edit, which re-mounts every store in
 * the app.
 */
import { saveFile } from '../../lib/saveFile';
import type { MapSegment } from '../../lib/meterMapLayout';

export interface MeterSegment extends MapSegment {
  segment?: number;
  start_bar?: number;
}

export interface TempoSegment {
  start_sec: number;
  bpm: number;
}

export interface RhythmResult {
  version?: number;
  duration_sec?: number;
  summary?: string;
  tempo?: {
    bpm: number | null;
    global_bpm: number | null;
    range_bpm: [number, number] | null;
    stable?: boolean;
    level?: string;
    segments?: TempoSegment[];
  };
  meter_map?: MeterSegment[];
  bars?: Array<{
    index?: number;
    segment?: number;
    start_sec: number;
    end_sec: number;
    beats?: number;
    time_signature?: string;
    syncopation?: { lhl?: number; wnbd?: number; offbeat_ratio?: number };
  }>;
  syncopation?: {
    mean_lhl?: number;
    max_lhl?: number;
    mean_offbeat_ratio?: number;
    peak_bars?: number[];
    curve?: number[];
    swing_ratio?: number | null;
    swing_confidence?: number;
  };
  polymeter?: Array<{ layer: string; label?: string; relation: string; beats_per_bar: number; confidence: number; segment?: number }>;
  cross_rhythms?: Array<{ ratio: string; strength: number; segment?: number }>;
  analyzed_at?: number;
  elapsed_sec?: number;
}

/** What the ANALYSIS block above already shows, passed in so one export can
 *  carry both -- the map is far less useful without key and tempo beside it. */
export interface AnalysisSummary {
  bpm?: number | null;
  key?: string | null;
  scale?: string | null;
  key_confidence?: number | null;
  bars_estimated?: number | null;
  loudness_lufs?: number | null;
  genre?: string | null;
}

export const fmtTime = (sec: number): string => {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
};

export const saveText = (name: string, text: string, mime: string, kind: string): void => {
  void saveFile({ blob: new Blob([text], { type: mime }), suggestedName: name, kind });
};

export const safeName = (s: string): string =>
  s.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80) || 'track';

/** The map as a paragraph and a table someone can paste into notes. */
export const rhythmMarkdown = (
  title: string,
  r: RhythmResult,
  a?: AnalysisSummary | null,
): string => {
  const lines: string[] = [`# ${title}`, ''];
  if (a) {
    lines.push('## Analysis', '');
    if (a.key) lines.push(`- Key: ${a.key} ${a.scale ?? ''}`.trimEnd() + (a.key_confidence != null ? ` (confidence ${a.key_confidence.toFixed(2)})` : ''));
    if (a.bpm != null) lines.push(`- BPM: ${a.bpm.toFixed(1)}`);
    if (a.bars_estimated != null) lines.push(`- Bars: ${a.bars_estimated.toFixed(1)}`);
    if (a.loudness_lufs != null) lines.push(`- Loudness: ${a.loudness_lufs.toFixed(1)} LUFS`);
    if (a.genre) lines.push(`- Genre: ${a.genre}`);
    lines.push('');
  }
  lines.push('## Meter map', '');
  if (r.summary) lines.push(r.summary, '');
  const segs = r.meter_map ?? [];
  if (segs.length) {
    lines.push('| From | To | Time signature | BPM | Bars | Confidence |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const s of segs) {
      lines.push(
        `| ${fmtTime(s.start_sec)} | ${fmtTime(s.end_sec)} | ${s.time_signature}${s.uncertain ? ' (?)' : ''} | ${s.bpm.toFixed(1)} | ${s.bars} | ${s.confidence.toFixed(2)} |`,
      );
    }
    lines.push('');
  }
  const sy = r.syncopation;
  if (sy) {
    lines.push('## Syncopation', '');
    if (sy.mean_lhl != null) lines.push(`- LHL mean ${sy.mean_lhl.toFixed(3)}, max ${(sy.max_lhl ?? 0).toFixed(3)}`);
    if (sy.mean_offbeat_ratio != null) lines.push(`- Offbeat ratio ${sy.mean_offbeat_ratio.toFixed(3)}`);
    if (sy.swing_ratio) lines.push(`- Swing ratio ${sy.swing_ratio.toFixed(2)} (confidence ${(sy.swing_confidence ?? 0).toFixed(2)})`);
    if (sy.peak_bars?.length) lines.push(`- Peak bars: ${sy.peak_bars.join(', ')}`);
    lines.push('');
  }
  if (r.polymeter?.length) {
    lines.push('## Polymeter', '');
    for (const p of r.polymeter) {
      lines.push(`- ${p.layer}: ${p.label ?? `${p.beats_per_bar} (${p.relation})`} - confidence ${p.confidence.toFixed(2)}`);
    }
    lines.push('');
  }
  if (r.cross_rhythms?.length) {
    lines.push('## Cross-rhythms', '');
    for (const c of r.cross_rhythms) lines.push(`- ${c.ratio} - strength ${c.strength.toFixed(2)}`);
    lines.push('');
  }
  return lines.join('\n');
};

