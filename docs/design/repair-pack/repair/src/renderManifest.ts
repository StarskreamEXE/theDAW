/** Provenance comes from the actual frozen render plan/trace, not a UI mute filter. */
export interface Contribution {
  assetId: string; clipId: string; trackId: string; takeId?: string;
  role: 'audible' | 'sidechain' | 'dependency';
  spans: readonly { outputStartFrame: number; outputEndFrame: number; sourceStartFrame?: number; sourceEndFrame?: number }[];
}
export interface RenderTrace {
  projectId: string; projectRevision: string; renderId: string;
  sampleRate: number; channels: number; frameCount: number;
  contributions: readonly Contribution[];
  processingStateHash: string; settingsHash: string;
}
export function quantizeBounds(startSec: number, endSec: number, sampleRate: number): { startFrame: number; endFrame: number; frameCount: number } {
  if (![startSec, endSec, sampleRate].every(Number.isFinite) || startSec < 0 || endSec <= startSec ||
    !Number.isSafeInteger(sampleRate) || sampleRate <= 0) throw new RangeError('Invalid render bounds');
  const startFrame = Math.round(startSec * sampleRate), endFrame = Math.round(endSec * sampleRate);
  if (![startFrame, endFrame].every(Number.isSafeInteger) || endFrame <= startFrame) throw new RangeError('Range is empty or outside sample precision');
  return { startFrame, endFrame, frameCount: endFrame - startFrame };
}
export function manifestCore(trace: RenderTrace): object {
  if (!Number.isSafeInteger(trace.sampleRate) || trace.sampleRate <= 0 ||
    !Number.isSafeInteger(trace.channels) || trace.channels <= 0 ||
    !Number.isSafeInteger(trace.frameCount) || trace.frameCount <= 0) throw new RangeError('Invalid output shape');
  for (const c of trace.contributions) {
    if (!c.assetId || !c.clipId || !c.trackId || c.spans.length === 0) throw new Error('Invalid contribution');
    for (const s of c.spans) {
      if (![s.outputStartFrame, s.outputEndFrame].every(Number.isSafeInteger) ||
        s.outputStartFrame < 0 || s.outputEndFrame <= s.outputStartFrame || s.outputEndFrame > trace.frameCount)
        throw new RangeError('Contribution outside output bounds');
    }
  }
  const contributions = [...trace.contributions].map((c) => ({ ...c, spans: c.spans.map((s) => ({ ...s })) }))
    .sort((a, b) => a.assetId.localeCompare(b.assetId) || a.clipId.localeCompare(b.clipId) || a.role.localeCompare(b.role));
  return { schema: 'thedaw.render-lineage/v1', ...trace, contributions,
    audibleAssetIds: [...new Set(contributions.filter((c) => c.role === 'audible').map((c) => c.assetId))].sort(),
    dependencyAssetIds: [...new Set(contributions.filter((c) => c.role !== 'audible').map((c) => c.assetId))].sort() };
}
/** Deterministic JSON for this kit's supported JSON values; not a claimed RFC-8785 implementation. */
export function stableJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') { if (!Number.isFinite(value)) throw new TypeError('Non-finite JSON number'); return JSON.stringify(value); }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(',')}}`;
  }
  throw new TypeError('Unsupported JSON value');
}
