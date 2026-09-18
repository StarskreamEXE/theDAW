/**
 * The meter map as a drawing: every decision that turns the rhythm engine's
 * result into blocks on a lane, kept apart from React so it can be tested and
 * so the same picture can be rendered on screen and into a file.
 *
 * The drawing follows the UNCANNY maps page (theDAW rhythm module, 2026-09-10):
 * a time ruler with tempo-change flags above it, one lane of meter blocks
 * sized by time and coloured by the family of their written numerator,
 * hatched when the reading is a guess, badged 8TH or 16TH when the engine read
 * the bar at the tatum, and a syncopation-per-bar lane underneath.
 *
 * The family colours encode data, so they are fixed here rather than taken
 * from the theme: a 7/8 block is the same red in every theme, on screen and
 * in the exported file.
 */

export interface MapSegment {
  start_sec: number;
  end_sec: number;
  time_signature: string;
  bpm: number;
  bars: number;
  confidence: number;
  uncertain?: boolean;
  beats_per_bar?: number;
  grouping?: number[];
  numerator?: number;
  denominator?: number;
  level?: string;
  subdivision?: string;
}

export interface MapTempoSegment {
  start_sec: number;
  bpm: number;
}

export interface MapBar {
  start_sec: number;
  end_sec: number;
  lhl: number;
}

export interface MapPolymeter {
  layer: string;
  label?: string;
  relation: string;
  beats_per_bar: number;
  confidence: number;
  segment?: number;
}

export interface MapCross {
  ratio: string;
  strength: number;
}

/** What the drawing needs from a rhythm result. `barsOf` builds it. */
export interface MeterMapData {
  duration: number;
  segments: MapSegment[];
  tempo: MapTempoSegment[];
  bars: MapBar[];
  polymeter: MapPolymeter[];
  cross: MapCross[];
  swingRatio: number | null;
  swingConfidence: number;
  meanLhl: number;
  maxLhl: number;
}

export type MeterFamily = 'm2' | 'm3' | 'm4' | 'm5' | 'm7' | 'mx';

/** The legend's colours, dark theme, read off the UNCANNY maps page. */
export const FAMILY_COLOUR: Record<MeterFamily, string> = {
  m2: '#7c8699',
  m4: '#5b9bd5',
  m3: '#9a7bdc',
  m5: '#e2a94a',
  m7: '#e2553f',
  mx: '#43b39a',
};

export const FAMILY_WORDS: Record<MeterFamily, string> = {
  m4: '4 · 8 (fours)',
  m3: '3 · 6 · 9 · 12 (threes, compound)',
  m5: '5 · 10 · 15',
  m7: '7 · 14',
  m2: '2',
  mx: '11 · 13 · 19 · 23 · the rest',
};

export const LEGEND_ORDER: MeterFamily[] = ['m4', 'm3', 'm5', 'm7', 'm2', 'mx'];

export const TEMPO_COLOUR = '#f0c674';
export const SYNC_COLOUR = '#d9a5ff';

/** Which family a bar length belongs to. Sevens are checked before fives and
 *  fives before threes, so 15 is a five and 21 is a seven; 6, 9 and 12 sit with
 *  the threes, and 16 with the fours. */
export const familyOf = (n: number): MeterFamily => {
  if (n === 2) return 'm2';
  if (n % 7 === 0) return 'm7';
  if (n % 5 === 0) return 'm5';
  if (n === 4 || n === 8 || n === 16) return 'm4';
  if (n % 3 === 0) return 'm3';
  return 'mx';
};

/** The numerator the block is coloured by: the written one, so 6/8 sits with
 *  the threes although it is two tracked beats long. */
export const numeratorOf = (m: MapSegment): number => {
  if (m.numerator) return m.numerator;
  const head = Number(m.time_signature.split('/')[0]);
  return Number.isFinite(head) && head > 0 ? head : (m.beats_per_bar ?? 4);
};

export const mmss = (sec: number): string => {
  const m = Math.floor(sec / 60);
  const r = Math.round(sec - m * 60);
  if (r === 60) return `${m + 1}:00`;
  return `${m}:${String(r).padStart(2, '0')}`;
};

/** A block reads its signature, and its grouping when the grouping says more
 *  than the signature does: "7/8 3+2+2" shows the grouping, "4/4 2+2" does not. */
export const segmentLabel = (m: MapSegment): { sig: string; grp: string } => {
  const sig = m.time_signature.split(' ')[0];
  const g = (m.grouping ?? []).join('+');
  const show = !!m.grouping && m.grouping.length > 1 && !(m.beats_per_bar === 4 && g === '2+2');
  return { sig, grp: show ? g : '' };
};

/** The badge for a block read at the tatum: the engine tried the fast pulse
 *  when the tracked beat read poorly, and the bar is written in eighths or
 *  sixteenths. Nothing for a block read at the tracked beat. */
export const levelMark = (m: MapSegment): string => {
  if (!m.level || m.level === 'tracked') return '';
  const den = m.denominator ?? Number(m.time_signature.split(' ')[0].split('/')[1]);
  return den === 16 ? '16TH' : den === 8 ? '8TH' : 'TATUM';
};

export const levelWords = (m: MapSegment): string =>
  !m.level || m.level === 'tracked' ? 'tracked beat' : `tatum (${m.level})`;

/** One sentence for a block: the tooltip, the aria-label and the detail line. */
export const describeSegment = (m: MapSegment): string => {
  const { sig, grp } = segmentLabel(m);
  const parts = [
    `${sig}${grp ? ` (${grp})` : ''}`,
    `${mmss(m.start_sec)}–${mmss(m.end_sec)}`,
    `${m.bars} bar${m.bars === 1 ? '' : 's'}`,
    `${m.bpm.toFixed(0)} bpm`,
  ];
  if (m.subdivision) parts.push(m.subdivision);
  parts.push(`conf ${m.confidence.toFixed(2)}${m.uncertain ? ' (guess)' : ''}`);
  parts.push(`read at the ${levelWords(m)}`);
  return parts.join(' · ');
};

/** Ruler ticks at least `minPx` apart at the given pixel width. The candidates
 *  are the steps a musician reads time in. */
export const tickStep = (duration: number, widthPx: number, minPx = 56): number => {
  const steps = [5, 10, 15, 30, 60, 120, 300, 600];
  for (const s of steps) {
    if ((s / duration) * widthPx >= minPx) return s;
  }
  return steps[steps.length - 1];
};

export const ticksFor = (duration: number, widthPx: number): number[] => {
  const step = tickStep(duration, widthPx);
  const out: number[] = [];
  for (let t = 0; t <= duration; t += step) out.push(t);
  return out;
};

/** How a block wears its label at a given pixel width: the whole label, the
 *  signature only, or nothing. */
export const labelFit = (widthPx: number): 'full' | 'sig' | 'none' => {
  if (widthPx < 30) return 'none';
  if (widthPx < 84) return 'sig';
  return 'full';
};

export interface Chip {
  kind: 'poly' | 'cross' | 'swing';
  head: string;
  tail: string;
}

/** The chips under the map: one per polymeter layer and bar length (the
 *  strongest reading of each), the three strongest cross-rhythm ratios, and
 *  swing when the engine is at least half sure of it. */
export const chipsFor = (d: MeterMapData): Chip[] => {
  const out: Chip[] = [];
  const seen = new Set<string>();
  for (const p of [...d.polymeter].sort((a, b) => b.confidence - a.confidence)) {
    const key = `${p.layer}:${p.beats_per_bar}:${p.relation}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const seg = p.segment != null ? d.segments[p.segment] : undefined;
    out.push({
      kind: 'poly',
      head: `${p.layer} keeps ${p.beats_per_bar}`,
      tail: `${p.relation}${seg ? ` · from ${mmss(seg.start_sec)}` : ''} · ${p.confidence.toFixed(2)}`,
    });
  }
  const strongest = new Map<string, number>();
  for (const c of d.cross) {
    const prev = strongest.get(c.ratio);
    if (prev == null || prev < c.strength) strongest.set(c.ratio, c.strength);
  }
  [...strongest.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .forEach(([ratio, s]) => out.push({ kind: 'cross', head: `cross ${ratio}`, tail: s.toFixed(2) }));
  if (d.swingRatio && d.swingConfidence >= 0.5) {
    out.push({
      kind: 'swing',
      head: `swing ${d.swingRatio.toFixed(2)}`,
      tail: d.swingRatio >= 1.4 ? 'swung' : 'straight',
    });
  }
  return out;
};

/** The facts column beside the map. */
export const factsFor = (d: MeterMapData, tempoBpm: number | null): Array<[string, string]> => {
  const solid = d.segments.filter((m) => !m.uncertain).length;
  const reads = [...new Set(d.segments.filter((m) => !m.uncertain).map((m) => m.time_signature.split(' ')[0]))];
  const runs = d.tempo.length;
  return [
    ['length', mmss(d.duration)],
    ['tempo', tempoBpm != null ? `${tempoBpm.toFixed(0)} bpm${runs > 1 ? ` · ${runs} tempo runs` : ''}` : '—'],
    ['meter', `${d.segments.length} segment${d.segments.length === 1 ? '' : 's'} · ${solid} solid`],
    ['reads', reads.length ? reads.join(' · ') : '—'],
    ['syncopation', `mean ${d.meanLhl.toFixed(2)} · peak ${d.maxLhl.toFixed(2)}`],
  ];
};

/** The engine's result as the drawing's data. Accepts the result shape of
 *  backend/modules/rhythm/engine.py: `bars[]` carries one syncopation reading
 *  per bar; older caches without it fall back to `syncopation.curve` spread
 *  evenly over the segments' bars. */
export const dataFromResult = (r: {
  duration_sec?: number;
  meter_map?: MapSegment[];
  tempo?: { segments?: MapTempoSegment[] } | null;
  bars?: Array<{ start_sec: number; end_sec: number; syncopation?: { lhl?: number } }>;
  syncopation?: {
    mean_lhl?: number;
    max_lhl?: number;
    curve?: number[];
    swing_ratio?: number | null;
    swing_confidence?: number;
  } | null;
  polymeter?: MapPolymeter[];
  cross_rhythms?: MapCross[];
}): MeterMapData => {
  const segments = r.meter_map ?? [];
  const duration = r.duration_sec ?? (segments.length ? Math.max(...segments.map((m) => m.end_sec)) : 0);
  let bars: MapBar[] = (r.bars ?? []).map((b) => ({
    start_sec: b.start_sec,
    end_sec: b.end_sec,
    lhl: b.syncopation?.lhl ?? 0,
  }));
  if (!bars.length && r.syncopation?.curve?.length) {
    const curve = r.syncopation.curve;
    let i = 0;
    for (const m of segments) {
      const n = Math.max(1, m.bars);
      const len = (m.end_sec - m.start_sec) / n;
      for (let k = 0; k < n && i < curve.length; k += 1, i += 1) {
        bars.push({ start_sec: m.start_sec + k * len, end_sec: m.start_sec + (k + 1) * len, lhl: curve[i] });
      }
    }
  }
  bars = bars.filter((b) => b.end_sec > b.start_sec);
  return {
    duration: duration > 0 ? duration : 1,
    segments,
    tempo: r.tempo?.segments ?? [],
    bars,
    polymeter: r.polymeter ?? [],
    cross: r.cross_rhythms ?? [],
    swingRatio: r.syncopation?.swing_ratio ?? null,
    swingConfidence: r.syncopation?.swing_confidence ?? 0,
    meanLhl: r.syncopation?.mean_lhl ?? 0,
    maxLhl: r.syncopation?.max_lhl ?? 0,
  };
};

/** Row heights of the drawing, in px at any width. */
export const ROWS = {
  ruler: 34,
  gap: 6,
  lane: 46,
  syncGap: 4,
  sync: 22,
};

export const chartHeight = (): number => ROWS.ruler + ROWS.gap + ROWS.lane + ROWS.syncGap + ROWS.sync;
