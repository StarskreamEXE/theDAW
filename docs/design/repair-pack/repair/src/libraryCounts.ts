/** Call refresh at shell startup and after committed mutations, never only on tab visits. */
export type Counts = Record<'tracks' | 'stems' | 'midi' | 'video' | 'score', number>;
export interface CountSnapshot { revision: number; counts: Counts }
export interface CountState { snapshot: CountSnapshot | null; loading: boolean; error: string | null }
export class LibraryCountController {
  private seq = 0;
  private abort?: AbortController;
  state: CountState = { snapshot: null, loading: false, error: null };
  constructor(private readonly fetcher: (signal: AbortSignal) => Promise<CountSnapshot>,
    private readonly notify: (state: CountState) => void) {}
  private publish(patch: Partial<CountState>): void { this.state = { ...this.state, ...patch }; this.notify(this.state); }
  async refresh(): Promise<void> {
    const seq = ++this.seq; this.abort?.abort(); this.abort = new AbortController();
    this.publish({ loading: true, error: null });
    try {
      const result = await this.fetcher(this.abort.signal);
      if (seq !== this.seq) return;
      if (!Number.isSafeInteger(result.revision) || result.revision < 0 ||
        !['tracks', 'stems', 'midi', 'video', 'score'].every((key) =>
          Number.isSafeInteger(result.counts[key as keyof Counts]) && result.counts[key as keyof Counts] >= 0))
        throw new Error('Invalid count snapshot');
      if (!this.state.snapshot || result.revision >= this.state.snapshot.revision) this.publish({ snapshot: result });
      this.publish({ loading: false });
    } catch (error) {
      if (seq !== this.seq) return;
      this.publish({ loading: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  dispose(): void { ++this.seq; this.abort?.abort(); }
}
