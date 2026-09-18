/** Original render request validation and frame math. This plans a job; it does
 * not mix audio, encode files, resolve routing, or claim a backend capability.
 */
export type RenderFormat =
  | { codec: 'wav' | 'aiff'; sampleFormat: 'pcm16' | 'pcm24' | 'float32' }
  | { codec: 'flac'; sampleFormat: 'pcm16' | 'pcm24' }
  | { codec: 'mp3' | 'opus' | 'aac'; bitrateKbps: number };
export type Normalization =
  | { kind: 'none' }
  | { kind: 'sample-peak'; targetDbfs: number; maxGainDb: number }
  | { kind: 'lufs'; targetLufs: number; ceilingDbtp: number; allowLimiting: boolean };
export interface RenderRequest {
  projectId: string;
  projectRevisionId: string;
  output: 'master' | 'selected-tracks' | 'stems' | 'region-matrix';
  trackIds: readonly string[];
  range: { startFrame: number; endFrame: number };
  sampleRate: number;
  channels: number;
  format: RenderFormat;
  mode: 'offline' | 'realtime';
  respectMuteSolo: boolean;
  includeMasterFx: boolean;
  tail: { mode: 'cut' } | { mode: 'fixed'; frames: number }
    | { mode: 'auto'; maxFrames: number; thresholdDbfs: number };
  prerollFrames: number;
  normalization: Normalization;
  dither: 'off' | 'tpdf';
  metadata: { provenance: 'full' | 'ids-only' | 'private-sidecar'; includePrompts: boolean };
}
export interface RenderCapabilities {
  codecs: readonly RenderFormat['codec'][];
  sampleRates: readonly number[];
  maxChannels: number;
  realtime: boolean;
}
function frame(n: number, label: string): void {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`${label}: nonnegative safe integer required`);
}
export function secondsToFrame(seconds: number, sampleRate: number): number {
  if (!Number.isFinite(seconds) || seconds < 0 || !Number.isSafeInteger(sampleRate) || sampleRate <= 0)
    throw new Error('Invalid time or sample rate');
  const n = Math.round(seconds * sampleRate);
  frame(n, 'frame'); return n;
}
export function validateRenderRequest(r: RenderRequest, caps: RenderCapabilities): void {
  if (!r.projectId || !r.projectRevisionId) throw new Error('An immutable project revision is required');
  frame(r.range.startFrame, 'start'); frame(r.range.endFrame, 'end');
  frame(r.prerollFrames, 'preroll');
  if (r.range.endFrame <= r.range.startFrame) throw new Error('Render range must have positive duration');
  if (!Number.isSafeInteger(r.sampleRate) || r.sampleRate <= 0 || !caps.sampleRates.includes(r.sampleRate))
    throw new Error('Sample rate unavailable');
  if (!Number.isSafeInteger(r.channels) || r.channels < 1 || r.channels > caps.maxChannels)
    throw new Error('Channel layout unavailable');
  if (!caps.codecs.includes(r.format.codec)) throw new Error('Encoder unavailable');
  if (r.mode === 'realtime' && !caps.realtime) throw new Error('Realtime rendering unavailable');
  if (r.output !== 'master' && r.trackIds.length === 0) throw new Error('Select output tracks');
  if (new Set(r.trackIds).size !== r.trackIds.length) throw new Error('Duplicate output track');
  if ('bitrateKbps' in r.format && (!Number.isSafeInteger(r.format.bitrateKbps) || r.format.bitrateKbps <= 0))
    throw new Error('Invalid bitrate');
  const integerPcm = 'sampleFormat' in r.format && r.format.sampleFormat !== 'float32';
  if (r.dither !== 'off' && !integerPcm) throw new Error('Dither is only allowed on a final integer-PCM output');
  if (r.tail.mode === 'fixed') frame(r.tail.frames, 'tail');
  if (r.tail.mode === 'auto') {
    frame(r.tail.maxFrames, 'max tail');
    if (!Number.isFinite(r.tail.thresholdDbfs) || r.tail.thresholdDbfs >= 0)
      throw new Error('Invalid silence threshold');
  }
  const n = r.normalization;
  if (n.kind === 'sample-peak' && (!Number.isFinite(n.targetDbfs) || n.targetDbfs > 0
    || !Number.isFinite(n.maxGainDb) || n.maxGainDb < 0)) throw new Error('Invalid peak normalization');
  if (n.kind === 'lufs' && (!Number.isFinite(n.targetLufs) || !Number.isFinite(n.ceilingDbtp)
    || n.ceilingDbtp > 0)) throw new Error('Invalid loudness target');
}
/** Estimate PCM payload only: excludes headers, metadata and compression. */
export function pcmPayloadBytes(frames: number, channels: number, bits: 16 | 24 | 32): bigint {
  frame(frames, 'frames');
  if (!Number.isSafeInteger(channels) || channels < 1) throw new Error('Invalid channels');
  return BigInt(frames) * BigInt(channels) * BigInt(bits / 8);
}
export function safeOutputBasename(name: string): string {
  let value = name.normalize('NFC').replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
    .replace(/[. ]+$/g, '').trim();
  if (!value) value = 'Untitled';
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(value)) value = '_' + value;
  // Paths/extensions and collision handling belong to the destination service.
  return Array.from(value).slice(0, 120).join('').replace(/[. ]+$/g, '') || 'Untitled';
}
