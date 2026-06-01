import { test, expect } from 'vitest';
import { transposeNote } from '../engine/song.js';
import { eventsForStep } from '../engine/scheduler.js';
import { normalizeLanes } from '../engine/lanes.js';

// ─── transposeNote ────────────────────────────────────────────────────────────

test('transposeNote: A4 +2 → B4', () => {
  expect(transposeNote('A4', 2)).toBe('B4');
});

test('transposeNote: B4 +1 → C5 (octave roll)', () => {
  expect(transposeNote('B4', 1)).toBe('C5');
});

test('transposeNote: C5 -1 → B4 (octave roll down)', () => {
  expect(transposeNote('C5', -1)).toBe('B4');
});

test('transposeNote: F#2 +12 → F#3 (octave up)', () => {
  expect(transposeNote('F#2', 12)).toBe('F#3');
});

test('transposeNote: A4 +0 → A4 (no-op)', () => {
  expect(transposeNote('A4', 0)).toBe('A4');
});

test('transposeNote: invalid input passes through unchanged', () => {
  expect(transposeNote('invalid', 3)).toBe('invalid');
  expect(transposeNote('', 3)).toBe('');
  expect(transposeNote('X9', 2)).toBe('X9');
});

// ─── eventsForStep with transpose ────────────────────────────────────────────

const baseSong = {
  meter: { beatsPerBar: 4, beatUnit: 4, stepsPerBeat: 4 },
  harmony: { progression: [
    { name: 'Am', root: 'A2', voicing: ['A3', 'C4', 'E4'] },
  ]},
};

function makeSong(overrides = {}) {
  const lanesObj = {
    drums:  { selection: 'beat', muted: false, cycleLen: 4,
              pool: { beat: { kick: [0, 8], snare: [4, 12] } } },
    bass:   { selection: 'roots', muted: false,
              pool: { roots: (bar, chord) => [[0, chord.root, 2]] } },
    chords: { selection: 'pad', muted: false },
    melody: { selection: 'hook', muted: false,
              pool: { hook: [ [[0, 'A4', 2]] ] } },
  };
  return { ...baseSong, lanes: normalizeLanes(lanesObj), ...overrides };
}

test('transpose=3: melody note shifts up 3 semitones (A4→C5)', () => {
  const song = makeSong({ transpose: 3 });
  const ev = eventsForStep(song, song.lanes, 0);
  const mel = ev.find(e => e.type === 'melody');
  expect(mel).toBeDefined();
  expect(mel.note).toBe('C5');
});

test('transpose=3: bass note shifts up 3 semitones (A2→C3)', () => {
  const song = makeSong({ transpose: 3 });
  const ev = eventsForStep(song, song.lanes, 0);
  const bass = ev.find(e => e.type === 'bass');
  expect(bass).toBeDefined();
  expect(bass.note).toBe('C3');
});

test('transpose=3: chord pad notes all shift up 3 semitones', () => {
  const song = makeSong({ transpose: 3 });
  const ev = eventsForStep(song, song.lanes, 0);
  const chords = ev.find(e => e.type === 'chords');
  expect(chords).toBeDefined();
  // A3+3=C4, C4+3=D#4, E4+3=G4
  expect(chords.notes).toEqual(['C4', 'D#4', 'G4']);
});

test('transpose=0: events identical to baseline (no-op)', () => {
  const base = makeSong();
  const transposed = makeSong({ transpose: 0 });
  expect(eventsForStep(transposed, transposed.lanes, 0))
    .toEqual(eventsForStep(base, base.lanes, 0));
});

test('transpose=3: drums are NOT transposed', () => {
  const song = makeSong({ transpose: 3 });
  const ev = eventsForStep(song, song.lanes, 0);
  const drums = ev.filter(e => e.type === 'drums');
  expect(drums.length).toBeGreaterThan(0);
  // Drum events carry voice/semi but no pitch note; ensure no unexpected note field
  for (const d of drums) {
    expect(d.note).toBeUndefined();
  }
});

test('transpose=3: tom semi field unchanged', () => {
  const song = makeSong({ transpose: 3 });
  const fillPat = { tom: [[0, 5]] };
  const ev = eventsForStep(song, song.lanes, 0, fillPat);
  const tom = ev.find(e => e.voice === 'tom');
  expect(tom).toBeDefined();
  expect(tom.semi).toBe(5);
});
