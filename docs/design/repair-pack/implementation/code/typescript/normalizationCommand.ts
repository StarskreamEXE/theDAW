/** Binds an async measurement to the attached clip revision, not current UI
 * selection. The application adapter provides its REAL undoable command store.
 */
import { proposePeakNormalization, resolveClipReference, type ClipReference, type CurrentClip } from './clipReferences.js';
export interface NormalizationServices {
  currentProjectId(): string;
  clips(): ReadonlyMap<string, CurrentClip>;
  /** Sample peak AFTER current clip gain, before fades/FX, in ref's source range. */
  measurePeak(ref: ClipReference, signal?: AbortSignal): Promise<number>;
  /** MUST perform compare-and-set plus gain edit plus undo entry atomically.
   * It must recheck projectId, version and revision inside that transaction.
   * Return a durable command id only after successful commit. */
  commit(ref: ClipReference, change: ReturnType<typeof proposePeakNormalization>): Promise<string>;
}
export async function normalizeAttachedClip(
  services: NormalizationServices, ref: ClipReference,
  options: { targetDbfs?: number; maxGainDb?: number; signal?: AbortSignal } = {},
): Promise<{ commandId: string; clipId: string; beforeGain: number; afterGain: number }> {
  const check = (): CurrentClip => {
    options.signal?.throwIfAborted();
    const result = resolveClipReference(ref, services.currentProjectId(), services.clips());
    if (!result.ok) throw new Error(`Reference ${result.reason}; refresh the attachment`);
    return result.clip;
  };
  check();
  const peak = await services.measurePeak(ref, options.signal);
  // A project switch, deletion or edit during measurement invalidates this result.
  const clip = check();
  const change = proposePeakNormalization(clip, peak, options.targetDbfs ?? -1, options.maxGainDb ?? 24);
  const commandId = await services.commit(ref, change);
  return { commandId, clipId: clip.id, beforeGain: change.beforeGain, afterGain: change.afterGain };
}
