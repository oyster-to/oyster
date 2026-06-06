import { test, expect } from 'vitest';
import { scalePitchClasses, snapMidi, inScale, deriveKey } from '../engine/song.js';

// midi 60 = C4. Pitch classes: C=0 … B=11.

test('scalePitchClasses: C major', () => {
  const s = scalePitchClasses({ root: 'C', mode: 'major' });
  expect([...s].sort((a, b) => a - b)).toEqual([0, 2, 4, 5, 7, 9, 11]);
});

test('scalePitchClasses: A natural minor', () => {
  const s = scalePitchClasses({ root: 'A', mode: 'minor' });
  expect([...s].sort((a, b) => a - b)).toEqual([0, 2, 4, 5, 7, 9, 11]); // same set as C major
});

test('scalePitchClasses: F# major includes the right sharps', () => {
  const s = scalePitchClasses({ root: 'F#', mode: 'major' });
  // F# major: F# G# A# B C# D# E# (=F)
  expect([...s].sort((a, b) => a - b)).toEqual([1, 3, 5, 6, 8, 10, 11]);
});

test('scalePitchClasses: missing/unknown key → empty set', () => {
  expect(scalePitchClasses(null).size).toBe(0);
  expect(scalePitchClasses({}).size).toBe(0);
});

test('inScale: C major', () => {
  const C = { root: 'C', mode: 'major' };
  expect(inScale(60, C)).toBe(true);   // C
  expect(inScale(61, C)).toBe(false);  // C#
  expect(inScale(62, C)).toBe(true);   // D
});

test('snapMidi: in-scale notes pass through', () => {
  const C = { root: 'C', mode: 'major' };
  expect(snapMidi(60, C)).toBe(60);
  expect(snapMidi(64, C)).toBe(64);
});

test('snapMidi: out-of-scale snaps to nearest in-scale', () => {
  const C = { root: 'C', mode: 'major' };
  expect(snapMidi(61, C)).toBe(60);   // C# → C (down) and D both dist 1 → tie → down
  expect(snapMidi(66, C)).toBe(65);   // F# → F (down) ties with G → down wins
});

test('snapMidi: no usable key → unchanged', () => {
  expect(snapMidi(61, null)).toBe(61);
  expect(snapMidi(61, {})).toBe(61);
});

// ── deriveKey ──────────────────────────────────────────────────────────────
const chord = (name, root, voicing) => ({ name, root, voicing });

test('deriveKey: A minor progression (rising-sun shape)', () => {
  const prog = [
    chord('Am', 'A2', ['A3', 'C4', 'E4']),
    chord('C', 'C2', ['C3', 'E3', 'G3']),
    chord('D', 'D2', ['D3', 'F#3', 'A3']),
    chord('F', 'F2', ['F3', 'A3', 'C4']),
    chord('Am', 'A2', ['A3', 'C4', 'E4']),
    chord('E', 'E2', ['E3', 'G#3', 'B3']),
  ];
  expect(deriveKey(prog)).toEqual({ root: 'A', mode: 'minor' });
});

test('deriveKey: ties break toward first chord root', () => {
  // F#m–D–A–E all fit A major and F# minor equally (relative keys).
  const prog = [
    chord('F#m', 'F#2', ['F#3', 'A3', 'C#4']),
    chord('D', 'D2', ['D3', 'F#3', 'A3']),
    chord('A', 'A2', ['A3', 'C#4', 'E4']),
    chord('E', 'E2', ['E3', 'G#3', 'B3']),
  ];
  // First chord is F#m → tie resolves to F# minor.
  expect(deriveKey(prog)).toEqual({ root: 'F#', mode: 'minor' });
});

test('deriveKey: empty / missing → null', () => {
  expect(deriveKey([])).toBeNull();
  expect(deriveKey(null)).toBeNull();
});
