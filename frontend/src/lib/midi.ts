/**
 * Tiny Standard MIDI File (SMF) encoder + parser.
 *
 * Just enough to round-trip note-on / note-off events with tempo changes and
 * time signatures, which is what the sequencer's drum-pattern export and the
 * piano roll's note grid both need. A signature's additive grouping (3+2+2)
 * has no field in FF 58, so it travels in a text event `theDAW:groups=3+2+2`
 * at the signature's tick, which only this parser reads back.
 */
import type { MeterEvent } from './meterMap';

export interface MidiNote {
  /** Tick offset from the start of the track. */
  tick: number;
  /** MIDI note number 0-127. 60 = middle C. */
  note: number;
  /** Velocity 1-127. */
  velocity: number;
  /** Length in ticks (0 = a "stuck" note; parser sets this from matching offs). */
  durationTicks: number;
  /** Channel 0-15. Drum sounds are conventionally channel 9. */
  channel: number;
}

export interface MidiTrack {
  name: string;
  notes: MidiNote[];
}

export interface MidiTempo {
  tick: number;
  bpm: number;
}

export interface MidiFileData {
  /** Ticks per quarter note. */
  ppq: number;
  /**
   * Beats per minute. Parsed: the tempo at tick 0, or the first tempo when none
   * sits at tick 0, rounded; 120 when the file has no tempo. Encoded: written
   * at tick 0 unless `tempos` holds a tick-0 entry.
   */
  bpm: number;
  tracks: MidiTrack[];
  /** Every time signature (FF 58), sorted by tick, merged across tracks. Parsed: absent when the file has none. Encoded: absent or empty writes 4/4 at tick 0. */
  timeSignatures?: MeterEvent[];
  /** Every tempo (FF 51), sorted by tick, merged across tracks. Parsed: absent when the file has none. */
  tempos?: MidiTempo[];
}

// =============================================================================
// Encoder
// =============================================================================

const writeVLQ = (value: number): number[] => {
  if (value < 0) value = 0;
  const out: number[] = [];
  let v = value;
  out.push(v & 0x7f);
  v >>>= 7;
  while (v > 0) {
    out.unshift(0x80 | (v & 0x7f));
    v >>>= 7;
  }
  return out;
};

const u32be = (v: number): number[] => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
const u16be = (v: number): number[] => [(v >>> 8) & 0xff, v & 0xff];
const ascii = (s: string): number[] => Array.from(s, (c) => c.charCodeAt(0));

interface RawEvent {
  tick: number;
  bytes: number[];
}

const notesToEvents = (notes: MidiNote[]): RawEvent[] => {
  const evs: RawEvent[] = [];
  for (const n of notes) {
    const ch = (n.channel ?? 0) & 0x0f;
    evs.push({ tick: n.tick, bytes: [0x90 | ch, n.note & 0x7f, Math.max(1, Math.min(127, n.velocity))] });
    evs.push({ tick: n.tick + Math.max(1, n.durationTicks), bytes: [0x80 | ch, n.note & 0x7f, 0] });
  }
  evs.sort((a, b) => a.tick - b.tick);
  return evs;
};

const serializeTrackChunk = (events: RawEvent[], name: string): number[] => {
  const body: number[] = [];
  body.push(...writeVLQ(0), 0xff, 0x03, ...writeVLQ(name.length), ...ascii(name));
  let last = 0;
  for (const ev of events) {
    body.push(...writeVLQ(ev.tick - last), ...ev.bytes);
    last = ev.tick;
  }
  body.push(0, 0xff, 0x2f, 0x00);
  return [...ascii('MTrk'), ...u32be(body.length), ...body];
};

const GROUPS_TEXT = 'theDAW:groups=';

const tempoBytes = (bpm: number): number[] => {
  const microsPerQuarter = Math.min(0xffffff, Math.round(60_000_000 / Math.max(20, bpm)));
  return [0xff, 0x51, 0x03, (microsPerQuarter >>> 16) & 0xff, (microsPerQuarter >>> 8) & 0xff, microsPerQuarter & 0xff];
};

/** FF 58 04 nn dd cc bb: numerator, log2 of the denominator, 96/den MIDI clocks per click, eight 32nds per quarter. */
const signatureBytes = (num: number, den: number): number[] => {
  const dd = Math.max(0, Math.min(7, Math.round(Math.log2(Math.max(1, den)))));
  const clocks = Math.max(1, Math.round(96 / 2 ** dd));
  return [0xff, 0x58, 0x04, Math.max(1, Math.min(255, Math.round(num))), dd, clocks, 8];
};

const textBytes = (text: string): number[] => [0xff, 0x01, ...writeVLQ(text.length), ...ascii(text)];

const tickOf = (tick: number): number => (Number.isFinite(tick) ? Math.max(0, Math.round(tick)) : 0);

/**
 * The conductor track: every tempo and time signature at its own tick. At one
 * tick the tempo comes first, then the signature, then its groups text. With
 * no lists it holds one tempo and a 4/4 at tick 0.
 */
const buildConductor = (file: MidiFileData): number[] => {
  const tempos = (file.tempos ?? []).map((t) => ({ tick: tickOf(t.tick), bpm: t.bpm }));
  if (!tempos.some((t) => t.tick === 0)) tempos.unshift({ tick: 0, bpm: file.bpm });
  const signatures = file.timeSignatures?.length ? file.timeSignatures : [{ tick: 0, num: 4, den: 4 }];
  const events: Array<RawEvent & { rank: number }> = [];
  for (const t of tempos) events.push({ tick: t.tick, rank: 0, bytes: tempoBytes(t.bpm) });
  for (const s of signatures) {
    const tick = tickOf(s.tick);
    events.push({ tick, rank: 1, bytes: signatureBytes(s.num, s.den) });
    if (s.groups?.length) events.push({ tick, rank: 2, bytes: textBytes(`${GROUPS_TEXT}${s.groups.join('+')}`) });
  }
  events.sort((a, b) => a.tick - b.tick || a.rank - b.rank);
  const body: number[] = [];
  body.push(...writeVLQ(0), 0xff, 0x03, ...writeVLQ(5), ...ascii('Tempo'));
  let last = 0;
  for (const ev of events) {
    body.push(...writeVLQ(ev.tick - last), ...ev.bytes);
    last = ev.tick;
  }
  body.push(0, 0xff, 0x2f, 0x00);
  return [...ascii('MTrk'), ...u32be(body.length), ...body];
};

export const encodeMidi = (file: MidiFileData): Uint8Array => {
  const tracks = file.tracks.map((t) => serializeTrackChunk(notesToEvents(t.notes), t.name));
  const ntrks = 1 + tracks.length;
  const header = [
    ...ascii('MThd'),
    ...u32be(6),
    ...u16be(1),
    ...u16be(ntrks),
    ...u16be(file.ppq),
  ];
  const out: number[] = [...header, ...buildConductor(file)];
  for (const c of tracks) out.push(...c);
  return new Uint8Array(out);
};

export const downloadMidi = (file: MidiFileData, baseName = 'pattern'): void => {
  const bytes = encodeMidi(file);
  const blob = new Blob([bytes], { type: 'audio/midi' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  a.href = url;
  a.download = `${baseName}-${stamp}.mid`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

// =============================================================================
// Parser
// =============================================================================

class Reader {
  constructor(public buf: Uint8Array, public pos = 0) {}
  byte(): number { return this.buf[this.pos++]; }
  u16(): number { return (this.byte() << 8) | this.byte(); }
  u32(): number { return (this.byte() << 24 | this.byte() << 16 | this.byte() << 8 | this.byte()) >>> 0; }
  bytes(n: number): Uint8Array { const out = this.buf.slice(this.pos, this.pos + n); this.pos += n; return out; }
  str(n: number): string { return Array.from(this.bytes(n), (b) => String.fromCharCode(b)).join(''); }
  vlq(): number {
    let v = 0;
    for (let i = 0; i < 4; i += 1) {
      const b = this.byte();
      v = (v << 7) | (b & 0x7f);
      if ((b & 0x80) === 0) return v;
    }
    return v;
  }
  remaining(): number { return this.buf.length - this.pos; }
}

interface ChannelEvent {
  status: number;
  data1: number;
  data2: number;
}

interface NotePartial {
  tick: number;
  note: number;
  velocity: number;
  channel: number;
}

interface DecodedTrack {
  name: string;
  notes: MidiNote[];
  tempos: MidiTempo[];
  signatures: MeterEvent[];
  /** `theDAW:groups=` text events, attached to the signature at the same tick by parseMidi. */
  groups: Array<{ tick: number; groups: number[] }>;
}

const decodeTrack = (chunk: Uint8Array, ppq: number): DecodedTrack => {
  const r = new Reader(chunk);
  let runningStatus = 0;
  let tick = 0;
  let name = '';
  const tempos: MidiTempo[] = [];
  const signatures: MeterEvent[] = [];
  const groups: DecodedTrack['groups'] = [];
  const open = new Map<string, NotePartial>(); // key = `${ch}:${note}`
  const finished: MidiNote[] = [];

  while (r.remaining() > 0) {
    const delta = r.vlq();
    tick += delta;
    let status = r.byte();
    if (status < 0x80) {
      // running status — back up one byte
      r.pos -= 1;
      status = runningStatus;
    } else {
      runningStatus = status;
    }
    if (status === 0xff) {
      const meta = r.byte();
      const len = r.vlq();
      const data = r.bytes(len);
      if (meta === 0x03) {
        // Track name
        name = Array.from(data, (b) => String.fromCharCode(b)).join('').trim();
      } else if (meta === 0x01) {
        const text = Array.from(data, (b) => String.fromCharCode(b)).join('');
        if (text.startsWith(GROUPS_TEXT)) {
          const g = text.slice(GROUPS_TEXT.length).split('+').map(Number);
          if (g.length && g.every((x) => Number.isInteger(x) && x >= 1)) groups.push({ tick, groups: g });
        }
      } else if (meta === 0x51 && data.length === 3) {
        const microsPerQuarter = (data[0] << 16) | (data[1] << 8) | data[2];
        // Three decimals: the microsecond rounding of FF 51 reads 97 back as 96.99995.
        if (microsPerQuarter > 0) tempos.push({ tick, bpm: Math.round(60_000_000_000 / microsPerQuarter) / 1000 });
      } else if (meta === 0x58 && data.length >= 2) {
        if (data[0] > 0) signatures.push({ tick, num: data[0], den: 2 ** data[1] });
      } else if (meta === 0x2f) {
        break;
      }
      // Other meta: ignored
    } else if (status === 0xf0 || status === 0xf7) {
      // SysEx — skip length bytes
      const len = r.vlq();
      r.pos += len;
    } else {
      const type = status & 0xf0;
      const ch = status & 0x0f;
      const d1 = r.byte();
      let d2 = 0;
      // Two-data-byte events: 0x80, 0x90, 0xA0, 0xB0, 0xE0
      // One-data-byte: 0xC0, 0xD0
      if (type !== 0xc0 && type !== 0xd0) d2 = r.byte();
      if (type === 0x90 && d2 > 0) {
        // Note On with velocity > 0
        const key = `${ch}:${d1}`;
        open.set(key, { tick, note: d1, velocity: d2, channel: ch });
      } else if (type === 0x80 || (type === 0x90 && d2 === 0)) {
        // Note Off (or Note On vel=0)
        const key = `${ch}:${d1}`;
        const partial = open.get(key);
        if (partial) {
          finished.push({
            tick: partial.tick,
            note: partial.note,
            velocity: partial.velocity,
            channel: partial.channel,
            durationTicks: Math.max(1, tick - partial.tick),
          });
          open.delete(key);
        }
      }
      // Other channel events (CC, PB, etc.) ignored
    }
  }

  // Any notes left open at end-of-track get a 1-tick duration so they're not lost.
  for (const partial of open.values()) {
    finished.push({
      tick: partial.tick,
      note: partial.note,
      velocity: partial.velocity,
      channel: partial.channel,
      durationTicks: ppq,
    });
  }

  finished.sort((a, b) => a.tick - b.tick);
  return { name, notes: finished, tempos, signatures, groups };
};

export const parseMidi = (buf: ArrayBuffer | Uint8Array): MidiFileData => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const r = new Reader(bytes);
  if (r.str(4) !== 'MThd') throw new Error('Not a MIDI file (missing MThd)');
  const headerLen = r.u32();
  /* format */ r.u16();
  const ntrks = r.u16();
  const division = r.u16();
  // skip any extra header bytes
  if (headerLen > 6) r.pos += headerLen - 6;

  // Division: positive value = ticks per quarter; negative would be SMPTE (not supported).
  const ppq = (division & 0x8000) ? 480 : division;

  const tracks: MidiTrack[] = [];
  const tempos: MidiTempo[] = [];
  const signatures: MeterEvent[] = [];
  const groups: DecodedTrack['groups'] = [];
  for (let i = 0; i < ntrks; i += 1) {
    if (r.str(4) !== 'MTrk') throw new Error(`Track ${i} missing MTrk marker`);
    const len = r.u32();
    const chunk = r.bytes(len);
    const t = decodeTrack(chunk, ppq);
    tempos.push(...t.tempos);
    signatures.push(...t.signatures);
    groups.push(...t.groups);
    if (t.notes.length > 0) {
      tracks.push({ name: t.name || `Track ${i}`, notes: t.notes });
    }
  }
  // Stable sorts: at one tick, events keep track order, so the last one written is the one in force.
  tempos.sort((a, b) => a.tick - b.tick);
  signatures.sort((a, b) => a.tick - b.tick);
  for (const g of groups) {
    for (const s of signatures) if (s.tick === g.tick) s.groups = [...g.groups];
  }
  const atZero = tempos.filter((t) => t.tick === 0);
  const bpm = atZero.length ? atZero[atZero.length - 1].bpm : tempos.length ? tempos[0].bpm : 120;
  return {
    ppq,
    bpm: Math.round(bpm),
    tracks,
    ...(signatures.length ? { timeSignatures: signatures } : {}),
    ...(tempos.length ? { tempos } : {}),
  };
};

