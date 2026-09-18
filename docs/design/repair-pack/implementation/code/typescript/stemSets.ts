/** A count in a dropdown is not evidence that a model produced that many stems. */
export interface StemFile {
  id: string;
  role: string;
  sampleRate: number;
  frameCount: number;
  /** Source-relative frame of the first sample AFTER delay compensation. */
  originFrame: number;
  aggregate: boolean;
  /** Membership is supplied by the separator manifest, not inferred from name. */
  replacesIds: readonly string[];
}
export interface StemSet {
  id: string;
  parentAssetVersionId: string;
  provider: string;
  modelRevision: string;
  outputs: readonly StemFile[];
  intendedMixIds: readonly string[];
  status: 'complete' | 'partial' | 'failed';
}
export function validateStemSet(set: StemSet): void {
  const map = new Map(set.outputs.map(s => [s.id, s]));
  if (map.size !== set.outputs.length) throw new Error('duplicate stem id');
  for (const s of set.outputs) {
    if (!Number.isSafeInteger(s.sampleRate) || s.sampleRate <= 0
      || !Number.isSafeInteger(s.frameCount) || s.frameCount <= 0
      || !Number.isSafeInteger(s.originFrame)) throw new Error('invalid stem format');
  }
  if (new Set(set.intendedMixIds).size !== set.intendedMixIds.length) throw new Error('duplicate mix member');
  const selected = new Set(set.intendedMixIds);
  for (const id of selected) {
    const stem = map.get(id);
    if (!stem) throw new Error('mix member has no file');
    if (stem.replacesIds.some(replaced => selected.has(replaced)))
      throw new Error('aggregate/replacement double-count in intended mix');
    // Check either direction, because imported manifests may encode on the aggregate.
    for (const other of set.outputs)
      if (selected.has(other.id) && other.replacesIds.includes(id))
        throw new Error('overlapping replacement groups in intended mix');
  }
}
export function stemSummary(set: StemSet): { files: number; mixParts: number; aggregateFiles: number } {
  validateStemSet(set);
  return { files: set.outputs.length, mixParts: set.intendedMixIds.length,
    aggregateFiles: set.outputs.filter(s => s.aggregate).length };
}
export interface StemPlacement {
  startFrame: number; sourceOffsetFrame: number; durationFrames: number;
}
/** Full-source separation, unity-rate parent clip, shared source/project rate.
 * Do not use for warped, reversed, or sample-rate-mismatched clips. The engine's
 * time-map adapter must handle those before invoking this bounded helper.
 */
export function alignStemToParent(
  stem: StemFile,
  parent: { startFrame: number; sourceOffsetFrame: number; durationFrames: number; sampleRate: number },
): StemPlacement {
  for (const n of [parent.startFrame, parent.sourceOffsetFrame, parent.durationFrames])
    if (!Number.isSafeInteger(n) || n < 0) throw new Error('invalid parent geometry');
  if (parent.durationFrames <= 0 || stem.sampleRate !== parent.sampleRate)
    throw new Error('empty clip or sample-rate mismatch');
  const sourceOffsetFrame = parent.sourceOffsetFrame - stem.originFrame;
  if (sourceOffsetFrame < 0 || sourceOffsetFrame + parent.durationFrames > stem.frameCount)
    throw new Error('stem does not cover parent trim; explicit pad/repair required');
  return { startFrame: parent.startFrame, sourceOffsetFrame, durationFrames: parent.durationFrames };
}
