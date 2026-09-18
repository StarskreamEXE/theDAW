/** Direct assistant references carry identities, never the audio bytes or blob URLs. */
export interface ClipReference {
  kind: 'timeline-clip';
  projectId: string;
  clipId: string;
  assetVersionId: string;
  clipRevision: number;
  range?: Readonly<{ startFrame: number; endFrame: number }>;
}
export interface CurrentClip {
  id: string;
  projectId: string;
  assetVersionId: string;
  revision: number;
  sourceFrames: number;
  label: string;
  gain: number;
}
export type ResolveResult =
  | { ok: true; clip: CurrentClip }
  | { ok: false; reason: 'wrong-project' | 'deleted' | 'stale' | 'invalid-range' };
export function resolveClipReference(
  ref: ClipReference, projectId: string, clips: ReadonlyMap<string, CurrentClip>,
): ResolveResult {
  if (ref.projectId !== projectId) return { ok: false, reason: 'wrong-project' };
  const clip = clips.get(ref.clipId);
  if (!clip) return { ok: false, reason: 'deleted' };
  if (clip.projectId !== ref.projectId) return { ok: false, reason: 'wrong-project' };
  if (clip.revision !== ref.clipRevision || clip.assetVersionId !== ref.assetVersionId)
    return { ok: false, reason: 'stale' };
  if (ref.range && (!Number.isSafeInteger(ref.range.startFrame)
      || !Number.isSafeInteger(ref.range.endFrame) || ref.range.startFrame < 0
      || ref.range.endFrame <= ref.range.startFrame || ref.range.endFrame > clip.sourceFrames))
    return { ok: false, reason: 'invalid-range' };
  return { ok: true, clip };
}
export function referenceKey(ref: ClipReference): string {
  return JSON.stringify([ref.kind, ref.projectId, ref.clipId, ref.assetVersionId,
    ref.clipRevision, ref.range?.startFrame ?? null, ref.range?.endFrame ?? null]);
}
export function attachReference(refs: readonly ClipReference[], ref: ClipReference): ClipReference[] {
  return refs.some(r => referenceKey(r) === referenceKey(ref)) ? [...refs] : [...refs, ref];
}
/** Non-destructive sample-peak normalization proposal; measuredPeak is measured
 * AFTER current clip gain, BEFORE fades/FX, and uses the attached source range.
 * It is NOT LUFS normalization, true-peak limiting, or a DSP implementation.
 */
export function proposePeakNormalization(
  clip: CurrentClip, measuredPeak: number, targetDbfs = -1, maxGainDb = 24,
): { clipId: string; expectedRevision: number; beforeGain: number; afterGain: number } {
  if (!Number.isFinite(measuredPeak) || measuredPeak <= 1e-12) throw new Error('silent or invalid signal');
  if (!Number.isFinite(clip.gain) || clip.gain <= 0) throw new Error('muted or invalid clip gain');
  if (!Number.isFinite(targetDbfs) || targetDbfs > 0 || !Number.isFinite(maxGainDb) || maxGainDb < 0)
    throw new Error('invalid normalization target');
  const desired = Math.pow(10, targetDbfs / 20) / measuredPeak;
  const multiplier = Math.min(desired, Math.pow(10, maxGainDb / 20));
  return { clipId: clip.id, expectedRevision: clip.revision,
    beforeGain: clip.gain, afterGain: clip.gain * multiplier };
}
