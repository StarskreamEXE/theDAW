import assert from 'node:assert/strict';

import type { OpenSheetMusicDisplay } from 'opensheetmusicdisplay';

import { buildTimeMap } from './scoreTimeMap.ts';
import { readSoundingTempi, soundingBpm } from './soundingTempo.ts';

// Run with: npx tsx src/components/layout/soundingTempo.test.ts

/** The tempo the "Everything is Chrome in the Future" drum MIDI declares. */
const MEASURED = 129.1992446150832;

/** A metronome direction the way music21 writes one. */
const direction = (
  perMinute: string,
  soundTempo?: string,
  opts: { beatUnit?: string; dotted?: boolean; quote?: '"' | "'" } = {},
): string => {
  const q = opts.quote ?? '"';
  const sound = soundTempo === undefined ? '' : `<sound tempo=${q}${soundTempo}${q} />`;
  return (
    '<direction placement="above"><direction-type><metronome parentheses="no">' +
    `<beat-unit>${opts.beatUnit ?? 'quarter'}</beat-unit>` +
    (opts.dotted ? '<beat-unit-dot />' : '') +
    `<per-minute>${perMinute}</per-minute></metronome></direction-type>${sound}</direction>`
  );
};

const NOTE = '<note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><type>whole</type></note>';

/** A partwise document: one array of measure bodies per part. */
const sheet = (parts: string[][]): string => {
  const list = parts
    .map((_, i) => `<score-part id="P${i + 1}"><part-name>Part ${i + 1}</part-name></score-part>`)
    .join('');
  const body = parts
    .map(
      (measures, i) =>
        `<part id="P${i + 1}">` +
        measures
          .map(
            (inner, m) =>
              `<measure number="${m + 1}"><attributes><measure-style><slash type="stop" /></measure-style></attributes>` +
              `${inner}${NOTE}</measure>`,
          )
          .join('') +
        '</part>',
    )
    .join('');
  return `<?xml version="1.0" encoding="utf-8"?><score-partwise version="4.0"><part-list>${list}</part-list>${body}</score-partwise>`;
};

// The band score: the mark rides on the drum staff, the second part, bar 1.
{
  const xml = sheet([
    ['', '', ''],
    [direction('129', String(MEASURED)), '', ''],
  ]);
  const tempi = readSoundingTempi(xml);
  assert.deepEqual(tempi, [{ measureIndex: 0, printed: 129, sounding: MEASURED }]);
  assert.equal(soundingBpm(tempi, 0, 129), MEASURED);
  assert.equal(soundingBpm(tempi, 2, 129), MEASURED);
  // A tempo no mark prints passes through.
  assert.equal(soundingBpm(tempi, 2, 100), 100);
}

// A later mark applies from its own measure on; before it the printed number stands.
{
  const tempi = readSoundingTempi(sheet([['', '', direction('97', '96.6'), '']]));
  assert.deepEqual(tempi, [{ measureIndex: 2, printed: 97, sounding: 96.6 }]);
  assert.equal(soundingBpm(tempi, 1, 97), 97);
  assert.equal(soundingBpm(tempi, 3, 97), 96.6);
}

// A mark that prints the same number without a sounding tempo takes over.
{
  const tempi = readSoundingTempi(sheet([[direction('129', '129.2'), '', direction('129'), '']]));
  assert.equal(soundingBpm(tempi, 1, 129), 129.2);
  assert.equal(soundingBpm(tempi, 3, 129), 129);
}

// The sound tempo counts only when the printed number is it rounded.
{
  const tempi = readSoundingTempi(sheet([[direction('60', '120')]]));
  assert.deepEqual(tempi, [{ measureIndex: 0, printed: 60, sounding: 60 }]);
  // Halves round up, as the backend prints them.
  assert.equal(readSoundingTempi(sheet([[direction('129', '128.5')]]))[0].sounding, 128.5);
  assert.equal(readSoundingTempi(sheet([[direction('128', '128.5')]]))[0].sounding, 128);
}

// Dotted and non-quarter beat units are not quarter-note tempi; left out.
{
  assert.deepEqual(readSoundingTempi(sheet([[direction('86', '129.2', { dotted: true })]])), []);
  assert.deepEqual(readSoundingTempi(sheet([[direction('65', '129.2', { beatUnit: 'half' })]])), []);
}

// Single-quoted attributes, and a document with no metronome at all.
{
  const tempi = readSoundingTempi(sheet([[direction('129', String(MEASURED), { quote: "'" })]]));
  assert.equal(tempi[0].sounding, MEASURED);
  assert.deepEqual(readSoundingTempi(sheet([['', '']])), []);
}

// The time map integrates at the sounding tempo while OSMD reports the printed 129.
{
  const WHOLE_NOTES = 4;
  const makeOsmd = (): OpenSheetMusicDisplay => {
    let position = 0;
    const iterator = {
      SkipInvisibleNotes: true,
      get EndReached() {
        return position >= WHOLE_NOTES;
      },
      get CurrentEnrolledTimestamp() {
        return { RealValue: position };
      },
      get CurrentSourceTimestamp() {
        return { RealValue: position };
      },
      get CurrentMeasureIndex() {
        return Math.min(position, WHOLE_NOTES - 1);
      },
      CurrentBpm: 129,
      moveToNextVisibleVoiceEntry() {
        position += 1;
      },
    };
    const measures = Array.from({ length: WHOLE_NOTES }, (_, i) => ({
      AbsoluteTimestamp: { RealValue: i },
      Duration: { RealValue: 1 },
    }));
    return {
      Sheet: {
        HasBPMInfo: true,
        DefaultStartTempoInBpm: 129,
        SourceMeasures: measures,
        MusicPartManager: { getIterator: () => iterator },
      },
    } as unknown as OpenSheetMusicDisplay;
  };

  const tempi = readSoundingTempi(sheet([[direction('129', String(MEASURED)), '', '', '']]));
  const precise = buildTimeMap(makeOsmd(), { soundingTempi: tempi });
  assert.equal(precise.bpmUsed, MEASURED);
  assert.ok(Math.abs(precise.totalSeconds - (WHOLE_NOTES * 240) / MEASURED) < 1e-9, String(precise.totalSeconds));
  assert.ok(Math.abs(precise.steps[3].seconds - (3 * 240) / MEASURED) < 1e-9);

  const printed = buildTimeMap(makeOsmd());
  assert.equal(printed.bpmUsed, 129);
  assert.ok(Math.abs(printed.totalSeconds - (WHOLE_NOTES * 240) / 129) < 1e-9);
}

console.log('soundingTempo tests passed');
