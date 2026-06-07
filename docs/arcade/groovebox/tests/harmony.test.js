import { test, expect } from 'vitest';
import {
  resolveRef, grooveBars, eventsForStepV2,
  setDrumStep, toggleNote, setGrooveBars,
} from '../engine/patterns.js';
import { chordAt } from '../engine/song.js';

const meter44 = { beatsPerBar: 4, beatUnit: 4, stepsPerBeat: 4 };

// A 3-note chord for ref grammar tests.
const Am = { name: 'Am', root: 'A2', voicing: ['A3', 'C4', 'E4'] };

// ── resolveRef grammar ─────────────────────────────────────────────────────
test('resolveRef: R → chord root', () => {
  expect(resolveRef('R', Am)).toBe('A2');
});

test('resolveRef: R+12 → root up an octave', () => {
  expect(resolveRef('R+12', Am)).toBe('A3');
});

test('resolveRef: V0/V1/V2 → voicing degrees', () => {
  expect(resolveRef('V0', Am)).toBe('A3');
  expect(resolveRef('V1', Am)).toBe('C4');
  expect(resolveRef('V2', Am)).toBe('E4');
});

test('resolveRef: V index clamps via i % voicing.length', () => {
  // 3-note voicing: V3 → 3%3=0 → V0.
  expect(resolveRef('V3', Am)).toBe('A3');
  expect(resolveRef('V4', Am)).toBe('C4');
});

test('resolveRef: V2-24 → voicing degree down two octaves', () => {
  expect(resolveRef('V2-24', Am)).toBe('E2');
});

test('resolveRef: V* → whole voicing array', () => {
  expect(resolveRef('V*', Am)).toEqual(['A3', 'C4', 'E4']);
});

test('resolveRef: V*-12 → whole voicing shifted down an octave', () => {
  expect(resolveRef('V*-12', Am)).toEqual(['A2', 'C3', 'E3']);
});

test('resolveRef: invalid ref → null', () => {
  expect(resolveRef('X', Am)).toBeNull();
  expect(resolveRef('R*', Am)).toBeNull();
  expect(resolveRef('', Am)).toBeNull();
  expect(resolveRef(null, Am)).toBeNull();
});

test('resolveRef: missing chord → null', () => {
  expect(resolveRef('R', null)).toBeNull();
  expect(resolveRef('R', undefined)).toBeNull();
});

test('resolveRef: voicing ref on a chord with empty voicing → null', () => {
  expect(resolveRef('V0', { root: 'A2', voicing: [] })).toBeNull();
});

// ── grooveBars normalizer ──────────────────────────────────────────────────
test('grooveBars: literal array passes through, relative wrapper unwraps', () => {
  const lit = [[[0, 'C4', 2]]];
  expect(grooveBars(lit)).toBe(lit);
  const figure = [[0, 'R', 2]];
  expect(grooveBars({ relative: true, bars: [figure] })).toEqual([figure]);
});

// ── pattern-local chords through eventsForStepV2 ────────────────────────────
// A pattern with 2 chords + a one-bar relative bass groove: the resolved note
// cycles on barInPattern (pattern.chords), not on a global/absolute clock.
const C = { name: 'C', root: 'C2', voicing: ['C3', 'E3', 'G3'] };
function harmonySong() {
  return {
    meter: meter44,
    lanes: [{ id: 'bass', type: 'bass', name: 'bass', muted: false, soloed: false }],
    grooves: { bass: { rel: { relative: true, bars: [[[0, 'R', 16]]] } } },
    patterns: [{ lanes: { bass: 'rel' }, chords: [Am, C] }],
    chain: [0],
  };
}

test('relative groove resolves against pattern.chords[barInPattern], cycling', () => {
  const song = harmonySong();
  const at = b => eventsForStepV2(song, 0, b, 0, null, 0);
  expect(at(0)).toEqual([{ laneId: 'bass', type: 'bass', note: 'A2', dur: 16 }]); // Am
  expect(at(1)).toEqual([{ laneId: 'bass', type: 'bass', note: 'C2', dur: 16 }]); // C
  expect(at(2)).toEqual([{ laneId: 'bass', type: 'bass', note: 'A2', dur: 16 }]); // wraps → Am
});

test('relative groove: transpose applies AFTER resolution', () => {
  const song = harmonySong();
  // +2 semitones on the Am root A2 → B2.
  expect(eventsForStepV2(song, 0, 0, 0, null, 2))
    .toEqual([{ laneId: 'bass', type: 'bass', note: 'B2', dur: 16 }]);
});

test('relative chords lane: V* → pad event, single ref → arp event', () => {
  const song = {
    meter: meter44,
    lanes: [{ id: 'chords', type: 'chords', name: 'chords', muted: false, soloed: false }],
    grooves: { chords: { pad: { relative: true, bars: [[[0, 'V*', 'bar'], [8, 'V0', 1]]] } } },
    patterns: [{ lanes: { chords: 'pad' }, chords: [Am] }],
    chain: [0],
  };
  expect(eventsForStepV2(song, 0, 0, 0, null, 0))
    .toEqual([{ laneId: 'chords', type: 'chords', mode: 'pad', notes: ['A3', 'C4', 'E4'], dur: 'bar' }]);
  expect(eventsForStepV2(song, 0, 0, 8, null, 0))
    .toEqual([{ laneId: 'chords', type: 'chords', mode: 'arp', note: 'A3', dur: 1 }]);
});

test('no chords on the pattern → relative groove is silent', () => {
  const base = harmonySong();
  const noChords = { ...base, patterns: [{ lanes: { bass: 'rel' } }] };
  expect(eventsForStepV2(noChords, 0, 0, 0, null, 0)).toEqual([]);
  const empty = { ...base, patterns: [{ lanes: { bass: 'rel' }, chords: [] }] };
  expect(eventsForStepV2(empty, 0, 0, 0, null, 0)).toEqual([]);
});

// ── write-path no-ops on relative grooves ──────────────────────────────────
test('setGrooveBars no-ops on a relative groove', () => {
  const song = harmonySong();
  const before = JSON.stringify(song.grooves.bass.rel);
  expect(setGrooveBars(song, 'bass', 'rel', 2)).toBeNull();
  expect(JSON.stringify(song.grooves.bass.rel)).toBe(before);
});

test('toggleNote no-ops on a relative groove', () => {
  const song = harmonySong();
  const before = JSON.stringify(song.grooves.bass.rel);
  toggleNote(song, 'bass', 'rel', 0, 4, 'C4', 2);
  expect(JSON.stringify(song.grooves.bass.rel)).toBe(before);
});

test('setDrumStep no-ops on a relative groove', () => {
  const song = {
    grooves: { drums: { rel: { relative: true, bars: [{}] } } },
  };
  const before = JSON.stringify(song.grooves.drums.rel);
  setDrumStep(song, 'drums', 'rel', 0, 'kick', 0, true);
  expect(JSON.stringify(song.grooves.drums.rel)).toBe(before);
});

// ── chordAt cycling ────────────────────────────────────────────────────────
test('chordAt cycles and wraps negative bars; empty → undefined', () => {
  const prog = [Am, { name: 'C', root: 'C2', voicing: ['C3'] }];
  expect(chordAt(prog, 0)).toBe(prog[0]);
  expect(chordAt(prog, 1)).toBe(prog[1]);
  expect(chordAt(prog, 2)).toBe(prog[0]);
  expect(chordAt(prog, -1)).toBe(prog[1]);
  expect(chordAt([], 0)).toBeUndefined();
});

// The original symptom (Mother of Pearl authoring, 2026-06-07): a flat-spelled
// voicing left ±N refs unshifted — V1+12 over Eb3 played Eb3, not Eb4.
test('resolveRef: ±N over a flat-spelled chord shifts (sharp-canonical out)', () => {
  const Cm = { name: 'Cm', root: 'C2', voicing: ['C3', 'Eb3', 'G3'] };
  expect(resolveRef('V1+12', Cm)).toBe('D#4');
  expect(resolveRef('R+10', { ...Cm, root: 'Bb1' })).toBe('G#2');
});
