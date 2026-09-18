/** Framework-neutral reactive counts coordinator. Bridge subscribe() to Zustand
 * or useSyncExternalStore. Start at app boot, not when a category mounts.
 */
export type LibraryCategory = 'tracks' | 'stems' | 'midi' | 'video' | 'score';
export interface CountsSnapshot {
  revision: number;
  counts: Record<LibraryCategory, number>;
}
export interface CountsState {
  snapshot: CountsSnapshot | null;
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: string | null;
}
export class LibraryCountsController {
  private state: CountsState = { snapshot: null, status: 'idle', error: null };
  private listeners = new Set<() => void>();
  private inFlight: Promise<void> | null = null;
  private desiredRevision = 0;
  private again = false;
  constructor(private readonly load: () => Promise<CountsSnapshot>) {}
  getSnapshot = (): CountsState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private publish(state: CountsState): void {
    this.state = state;
    this.listeners.forEach(listener => listener());
  }
  /** revision is emitted by the authoritative DB after its transaction commits. */
  invalidate(revision: number): Promise<void> {
    this.desiredRevision = Math.max(this.desiredRevision, revision);
    if (this.state.snapshot && this.state.snapshot.revision >= this.desiredRevision)
      return Promise.resolve();
    if (this.inFlight) this.again = true;
    return this.refresh();
  }
  refresh(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.run().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }
  private async run(): Promise<void> {
    this.publish({ ...this.state, status: 'loading', error: null });
    // Retry once when an invalidation overtakes an in-flight snapshot. Persistent
    // replica lag becomes an explicit stale/error state, never an infinite loop.
    for (let attempt = 0; attempt < 2; attempt++) {
      this.again = false;
      try {
        const next = await this.load();
        if (!Number.isSafeInteger(next.revision) || next.revision < 0
          || !next.counts || ['tracks', 'stems', 'midi', 'video', 'score'].some(key => {
            const n = next.counts[key as LibraryCategory];
            return !Number.isSafeInteger(n) || n < 0;
          }))
          throw new Error('Invalid counts response');
        const current = this.state.snapshot;
        const snapshot = !current || next.revision >= current.revision ? next : current;
        this.publish({ snapshot, status: 'ready', error: null });
        if (!this.again && snapshot.revision >= this.desiredRevision) return;
      } catch (error) {
        this.publish({ ...this.state, status: 'error', error: String(error) });
        return;
      }
    }
    if (!this.state.snapshot || this.state.snapshot.revision < this.desiredRevision)
      this.publish({ ...this.state, status: 'error', error: 'Counts snapshot is stale; retry refresh' });
  }
}
