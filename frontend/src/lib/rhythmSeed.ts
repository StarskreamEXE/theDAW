/**
 * rhythmSeed — the piano roll's meter from a library song's rhythm analysis
 * (GET /api/rhythm/{entry_id} and POST /api/rhythm/{entry_id}/run in
 * backend/modules/rhythm/router.py).
 *
 * The analysis's meter_map gives each segment's numerator, denominator,
 * grouping and first bar; its first downbeat gives the pickup; polymeter
 * entries that name a denominator become lanes looping at their bar length.
 */
import { meterFromAnalysis, normalizeMeterMap, stepsPerBar, type MeterSegment, type PolyLane } from './meterMap';

export interface RhythmMeterSegment {
  start_bar: number;
  bars: number;
  numerator: number;
  denominator: number;
  grouping: number[];
  beats_per_bar: number;
  bpm?: number;
  confidence?: number;
  uncertain?: boolean;
}

export interface RhythmPolymeterEntry {
  segment: number;
  layer: string;
  beats_per_bar: number;
  grouping: number[];
  /** Written by the engine since polymeter entries named their grid; older caches lack it. */
  denominator?: number;
  label?: string;
  confidence: number;
}

export interface RhythmAnalysis {
  entry_id?: string;
  status: 'ready' | 'pending';
  tempo?: { bpm: number; stable: boolean };
  downbeats?: number[];
  meter_map?: RhythmMeterSegment[];
  polymeter?: RhythmPolymeterEntry[];
}

export interface RhythmSeed {
  meterMap: MeterSegment[];
  pickupSteps: number;
  /** Lane A plus one lane per distinct polymeter loop, strongest first. */
  lanes: PolyLane[];
  /** The song's tracked tempo, or null when the analysis has none. */
  bpm: number | null;
  tempoStable: boolean;
  /** Bars in segments the engine marked uncertain. */
  uncertainBars: number;
}

const EPS = 1e-9;
const MAX_PICKUP = 64;

const title = (s: string): string => (s ? s[0].toUpperCase() + s.slice(1) : s);

/**
 * The roll's meter for a ready analysis, or null when it is pending or has no
 * meter map. `rollBpm` places the pickup when the analysis carries no tempo.
 */
export function seedFromRhythm(a: RhythmAnalysis, rollBpm: number, maxLanes = 3): RhythmSeed | null {
  if (a.status !== 'ready' || !a.meter_map?.length) return null;
  const segs = [...a.meter_map].sort((x, y) => x.start_bar - y.start_bar);
  const raw: MeterSegment[] = [];
  for (const s of segs) {
    const meter = meterFromAnalysis(s);
    if (meter) raw.push({ bar: Math.max(0, Math.round(s.start_bar)), meter });
  }
  if (!raw.length) return null;

  const bpm = a.tempo && a.tempo.bpm > 0 ? a.tempo.bpm : null;
  const stepSec = 60 / (bpm ?? rollBpm) / 4;
  const firstDownbeat = a.downbeats?.[0];
  const barLen = stepsPerBar(normalizeMeterMap(raw)[0].meter);
  const lead = typeof firstDownbeat === 'number' && firstDownbeat > 0 && stepSec > 0 ? Math.round(firstDownbeat / stepSec) : 0;
  // Whole bars of the first meter before the first downbeat come ahead of the
  // analysis's bar 0; what is left over is the pickup.
  const extraBars = barLen > 0 ? Math.floor(lead / barLen + EPS) : 0;
  const pickupSteps = Math.min(MAX_PICKUP, Math.max(0, lead - extraBars * barLen));
  const meterMap = normalizeMeterMap(raw.map((s, i) => ({ bar: i === 0 ? 0 : s.bar + extraBars, meter: s.meter })));

  const lanes: PolyLane[] = [{ id: 0, name: 'A', cycleSteps: null }];
  const seen = new Set<number>();
  const entries = [...(a.polymeter ?? [])].sort((x, y) => y.confidence - x.confidence);
  for (const p of entries) {
    if (lanes.length > maxLanes) break;
    if (!(typeof p.denominator === 'number' && p.denominator > 0)) continue;
    const cycle = (p.beats_per_bar * 16) / p.denominator;
    if (!Number.isInteger(cycle) || cycle < 1 || seen.has(cycle)) continue;
    const seg = segs[p.segment];
    const segMeter = seg ? meterFromAnalysis(seg) : null;
    if (segMeter && Math.abs(stepsPerBar(segMeter) - cycle) < EPS) continue;
    seen.add(cycle);
    lanes.push({ id: lanes.length, name: title(p.layer) || `Lane ${lanes.length}`, cycleSteps: cycle });
  }

  return {
    meterMap,
    pickupSteps,
    lanes,
    bpm,
    tempoStable: a.tempo?.stable ?? true,
    uncertainBars: segs.filter((s) => s.uncertain).reduce((n, s) => n + (s.bars || 0), 0),
  };
}

/**
 * A library entry's rhythm analysis. With `run`, an entry that has none yet
 * is analyzed now. Throws an Error whose message names the failing request.
 */
export async function fetchRhythm(entryId: string, { run = false, signal }: { run?: boolean; signal?: AbortSignal } = {}): Promise<RhythmAnalysis> {
  const base = `/api/rhythm/${encodeURIComponent(entryId)}`;
  const read = async (r: Response, what: string): Promise<RhythmAnalysis> => {
    if (!r.ok) {
      let detail = '';
      try { detail = ((await r.json()) as { detail?: string }).detail ?? ''; } catch { /* no JSON body */ }
      throw new Error(`${what} failed with ${r.status}${detail ? `: ${detail}` : ''}`);
    }
    return (await r.json()) as RhythmAnalysis;
  };
  const got = await read(await fetch(base, { signal }), 'Reading the rhythm analysis');
  if (got.status === 'ready' || !run) return got;
  return read(await fetch(`${base}/run`, { method: 'POST', signal }), 'Analyzing the rhythm');
}
