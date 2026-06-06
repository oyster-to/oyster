import { test, expect } from 'vitest';
import { sectionAt } from '../engine/arrangement.js';

// 4×4-bar sections (16 bars total)
const arr = [
  { bars:4, lanes:{ drums:'four',     bass:'octave',  chords:'pad',  melody:'hook' }, fill:'tom roll' },
  { bars:4, lanes:{ drums:'backbeat', bass:'eighths', chords:'pad',  melody:'hook' }, fill:'snare roll' },
  { bars:4, lanes:{ drums:'NIN',      bass:'16ths',   chords:'stab', melody:'hook' }, fill:'crash build' },
  { bars:4, lanes:{ drums:'four',     bass:'octave',  chords:'arp',  melody:'hook' }, fill:'glitch' },
];

test('songBar 0 → section 0, barInSection 0, not last bar', () => {
  const r = sectionAt(arr, 0);
  expect(r.index).toBe(0);
  expect(r.barInSection).toBe(0);
  expect(r.isLastBar).toBe(false);
});

test('songBar 3 → section 0, isLastBar true', () => {
  const r = sectionAt(arr, 3);
  expect(r.index).toBe(0);
  expect(r.barInSection).toBe(3);
  expect(r.isLastBar).toBe(true);
});

test('songBar 4 → section 1, barInSection 0', () => {
  const r = sectionAt(arr, 4);
  expect(r.index).toBe(1);
  expect(r.barInSection).toBe(0);
  expect(r.isLastBar).toBe(false);
});

test('songBar 7 → section 1, isLastBar true', () => {
  const r = sectionAt(arr, 7);
  expect(r.index).toBe(1);
  expect(r.barInSection).toBe(3);
  expect(r.isLastBar).toBe(true);
});

test('songBar 8 → section 2', () => {
  const r = sectionAt(arr, 8);
  expect(r.index).toBe(2);
  expect(r.barInSection).toBe(0);
});

test('songBar 12 → section 3', () => {
  const r = sectionAt(arr, 12);
  expect(r.index).toBe(3);
  expect(r.barInSection).toBe(0);
});

test('songBar 15 → section 3, isLastBar true', () => {
  const r = sectionAt(arr, 15);
  expect(r.index).toBe(3);
  expect(r.barInSection).toBe(3);
  expect(r.isLastBar).toBe(true);
});

test('songBar 16 wraps back to section 0', () => {
  const r = sectionAt(arr, 16);
  expect(r.index).toBe(0);
  expect(r.barInSection).toBe(0);
});

test('songBar 20 wraps to section 1', () => {
  const r = sectionAt(arr, 20);
  expect(r.index).toBe(1);
  expect(r.barInSection).toBe(0);
});

test('negative songBar wraps correctly', () => {
  const r = sectionAt(arr, -1);
  // -1 mod 16 = 15 → section 3, barInSection 3
  expect(r.index).toBe(3);
  expect(r.barInSection).toBe(3);
  expect(r.isLastBar).toBe(true);
});

test('section object is the original reference', () => {
  const r = sectionAt(arr, 5);
  expect(r.section).toBe(arr[1]);
});
