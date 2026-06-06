import { test, expect } from 'vitest';
import { parseProgression, formatProgression } from '../engine/chords.js';

test('parses a major triad: root @oct2, voicing rising from oct3', () => {
  const { chords, errors } = parseProgression('A');
  expect(errors).toEqual([]);
  expect(chords).toEqual([{ name: 'A', root: 'A2', voicing: ['A3', 'C#4', 'E4'] }]);
});

test('parses a minor triad (lowercase m quality)', () => {
  expect(parseProgression('Am').chords[0])
    .toEqual({ name: 'Am', root: 'A2', voicing: ['A3', 'C4', 'E4'] });
});

test('voicings match the preset conventions (Am / C from rising-sun)', () => {
  const { chords } = parseProgression('Am C');
  expect(chords[0].voicing).toEqual(['A3', 'C4', 'E4']);
  expect(chords[1].voicing).toEqual(['C3', 'E3', 'G3']);
});

test('parses sharp and flat roots', () => {
  expect(parseProgression('F#').chords[0].root).toBe('F#2');
  // Bb normalises to its pitch-class spelling A#.
  expect(parseProgression('Bb').chords[0]).toMatchObject({ name: 'A#', root: 'A#2' });
});

test('slash bass sets the root note; voicing stays the chord triad', () => {
  const c = parseProgression('E/G#').chords[0];
  expect(c).toEqual({ name: 'E/G#', root: 'G#2', voicing: ['E3', 'G#3', 'B3'] });
});

test('parses a full progression', () => {
  const { chords, errors } = parseProgression('F#m D A E/G#');
  expect(errors).toEqual([]);
  expect(chords.map(c => c.name)).toEqual(['F#m', 'D', 'A', 'E/G#']);
});

test('records per-token errors with index; parses the rest', () => {
  const { chords, errors } = parseProgression('A x7 Cm');
  expect(chords.map(c => c.name)).toEqual(['A', 'Cm']);
  expect(errors).toEqual([{ index: 1, token: 'x7' }]);
});

test('collapses repeated whitespace and trims', () => {
  expect(parseProgression('  A    Cm  ').chords.map(c => c.name)).toEqual(['A', 'Cm']);
});

test('empty input → no chords, no errors', () => {
  expect(parseProgression('')).toEqual({ chords: [], errors: [] });
  expect(parseProgression('   ')).toEqual({ chords: [], errors: [] });
});

test('formatProgression is the inverse of parse (by name)', () => {
  const text = 'F#m D A E/G#';
  expect(formatProgression(parseProgression(text).chords)).toBe(text);
});

test('formatProgression tolerates non-array', () => {
  expect(formatProgression(null)).toBe('');
});
