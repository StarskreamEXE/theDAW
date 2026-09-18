/** IDs are authoritative; labels are presentation only. No Blob or upload is attached. */
export interface ClipRef {
  kind: 'clip'; projectId: string; clipId: string; assetId: string; revision: number;
  displayLabel: string;
  sourceRange?: { start: number; end: number };
}
export interface RefClip { id: string; assetId: string; revision: number; label: string; gain: number }
export function makeClipRef(projectId: string, clip: RefClip): ClipRef {
  return { kind: 'clip', projectId, clipId: clip.id, assetId: clip.assetId, revision: clip.revision, displayLabel: clip.label };
}
export function resolveClipRef(ref: ClipRef, projectId: string, clips: readonly RefClip[]): { clip: RefClip; stale: boolean } {
  if (ref.projectId !== projectId) throw new Error('Reference belongs to a different project');
  const clip = clips.find((c) => c.id === ref.clipId);
  if (!clip) throw new Error('Referenced clip was deleted or is unavailable');
  if (clip.assetId !== ref.assetId) throw new Error('Referenced source was replaced');
  return { clip, stale: clip.revision !== ref.revision };
}
export interface GainCommand { target: ClipRef; nextGain: number; label: string }
/** peak is the measured source-region sample peak, before this clip's gain.
 * This is peak normalization only: LUFS/true-peak require separate analysis.
 */
export function preparePeakNormalize(target: ClipRef, measuredPeak: number, targetDb: number): GainCommand {
  if (target.sourceRange) throw new Error('Range normalization needs a range-edit command; refusing whole-clip gain');
  if (!Number.isFinite(measuredPeak) || measuredPeak <= 0) throw new RangeError('Cannot normalize silence or an invalid measurement');
  if (!Number.isFinite(targetDb) || targetDb > 0 || targetDb < -96) throw new RangeError('Invalid sample-peak target');
  return { target, nextGain: Math.pow(10, targetDb / 20) / measuredPeak, label: `Normalize clip peak to ${targetDb} dBFS` };
}
/** Integrate through the existing undoable command boundary, not direct React state. */
export function applyGainCommand(command: GainCommand, projectId: string, clips: readonly RefClip[]): RefClip[] {
  const { clip, stale } = resolveClipRef(command.target, projectId, clips);
  if (stale) throw new Error('Clip changed after analysis; recompute before applying');
  if (!Number.isFinite(command.nextGain) || command.nextGain < 0) throw new RangeError('Invalid gain');
  return clips.map((c) => c.id === clip.id ? { ...c, gain: command.nextGain, revision: c.revision + 1 } : c);
}
export interface DerivationTicket { projectId: string; clipId: string; assetId: string; revision: number; jobId: string }
export function acceptsDerivedResult(ticket: DerivationTicket, projectId: string, clip: RefClip | undefined): boolean {
  return !!clip && ticket.projectId === projectId && ticket.clipId === clip.id &&
    ticket.assetId === clip.assetId && ticket.revision === clip.revision;
}
