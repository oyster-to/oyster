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
