/** A provider's maximum output count is not its expected manifest length. */
export type StemState = 'pending' | 'ready' | 'failed' | 'unavailable';
export interface Stem { id: string; role: string; state: StemState; assetId?: string; silent?: boolean; error?: string }
export interface StemSet {
  id: string; parentAssetId: string; provider: string; model: string;
  providerFinished: boolean; maximumCount?: number; expectedRoles?: readonly string[];
  stems: readonly Stem[];
}
export function summarizeStemSet(set: StemSet): { state: 'running' | 'complete' | 'partial' | 'failed';
  ready: number; total: number; missingRoles: string[]; pending: number } {
  if (new Set(set.stems.map((s) => s.id)).size !== set.stems.length) throw new Error('Duplicate stem ID');
  if (set.stems.some((s) => s.state === 'ready' && !s.assetId)) throw new Error('Ready stem requires an asset');
  const ready = set.stems.filter((s) => s.state === 'ready').length;
  const pending = set.stems.filter((s) => s.state === 'pending').length;
  const roles = new Set(set.stems.filter((s) => s.state === 'ready').map((s) => s.role));
  const missingRoles = [...new Set(set.expectedRoles ?? [])].filter((r) => !roles.has(r));
  const bad = set.stems.some((s) => s.state === 'failed' || s.state === 'unavailable');
  const state = !set.providerFinished ? 'running' : ready === 0 ? 'failed' :
    pending || bad || missingRoles.length ? 'partial' : 'complete';
  return { state, ready, total: set.expectedRoles?.length ?? set.stems.length, missingRoles, pending };
}
