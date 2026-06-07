import { test, expect } from 'vitest';
import { transposeNote } from '../engine/song.js';

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

// Flat spellings are valid input (the chord-line parser accepts "Ebm" etc.) —
// they must SHIFT, not silently pass through. Output stays sharp-canonical.
test('transposeNote: Eb3 +12 → D#4 (flats accepted, shifted)', () => {
  expect(transposeNote('Eb3', 12)).toBe('D#4');
});

test('transposeNote: Bb1 +2 → C2 (flat across octave roll)', () => {
  expect(transposeNote('Bb1', 2)).toBe('C2');
});

test('transposeNote: Ab4 +0 → G#4 (flats normalize to sharps)', () => {
  expect(transposeNote('Ab4', 0)).toBe('G#4');
});

test('transposeNote: Cb4 +0 → B3 (theory-correct octave, matches Tone)', () => {
  expect(transposeNote('Cb4', 0)).toBe('B3');
});
