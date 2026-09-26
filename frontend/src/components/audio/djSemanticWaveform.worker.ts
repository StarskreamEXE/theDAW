/**
 * The DJ waveform's analysis loop, off the main thread (DJ-2).
 *
 * `analyzeBuffer` is ~51M inner iterations for a 3.5-minute track (≈6,400
 * bins x 723 samples x 11 Goertzel frequencies) plus one `Float32Array` per
 * bin. Run inline in a `useEffect` — once per waveform instance, and the
 * default layout mounts four of them across two decks — that is 0.6-2 s of
 * frozen UI at automix start.
 *
 * This worker runs the exact same {@link analyzeChannels} function the
 * in-process path runs, on transferred COPIES of the buffer's channel data,
 * so the result is identical arithmetic on identical `Float32Array`s. The
 * main thread's job is reduced to one copy per channel.
 *
 * Instantiated lazily by `djSemanticWaveformAnalysis.analyzeBufferAsync`;
 * where `Worker` does not exist (node/tsx tests, inside a worker) that module
 * falls back to the synchronous path and this file is never loaded.
 */
import { analyzeChannels, type AnalyzeResponse } from './djSemanticWaveformAnalysis';

type AnalyzeRequest = {
  id: number;
  channels: Float32Array[];
  length: number;
  sampleRate: number;
  bins: number;
  normalize: boolean;
};

/** The worker globals this file uses. Declared structurally rather than as
 *  `DedicatedWorkerGlobalScope`: the project's `lib` is the DOM one, and
 *  adding `webworker` to it would collide with half of the DOM types. */
type WorkerScope = {
  onmessage: ((event: MessageEvent<AnalyzeRequest>) => void) | null;
  postMessage(message: AnalyzeResponse): void;
};

const scope = self as unknown as WorkerScope;

scope.onmessage = (event: MessageEvent<AnalyzeRequest>) => {
  const { id, channels, length, sampleRate, bins, normalize } = event.data;
  let response: AnalyzeResponse;
  try {
    response = { id, bins: analyzeChannels(channels, length, sampleRate, bins, normalize) };
  } catch (err) {
    response = { id, error: err instanceof Error ? err.message : 'waveform analysis failed' };
  }
  scope.postMessage(response);
};
