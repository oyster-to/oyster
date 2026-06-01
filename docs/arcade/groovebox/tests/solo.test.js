import { test, expect } from 'vitest';
import { toggleSolo, soloExclusive } from '../engine/lanes.js';
import { laneAudible } from '../engine/song.js';

// ─── laneAudible ─────────────────────────────────────────────────────────────

function makeSong(lanes) {
  // lanes: { drums: { muted, soloed }, bass: { muted, soloed }, ... }
  return { lanes };
}

test('laneAudible: no solo — audible iff not muted', () => {
  const song = makeSong({
    drums:  { muted: false, soloed: false },
    bass:   { muted: true,  soloed: false },
  });
  expect(laneAudible(song, 'drums')).toBe(true);
  expect(laneAudible(song, 'bass')).toBe(false);
});

test('laneAudible: with one lane soloed, only that lane is audible', () => {
  const song = makeSong({
    drums:  { muted: false, soloed: true },
    bass:   { muted: false, soloed: false },
    chords: { muted: false, soloed: false },
    melody: { muted: false, soloed: false },
  });
  expect(laneAudible(song, 'drums')).toBe(true);
  expect(laneAudible(song, 'bass')).toBe(false);
  expect(laneAudible(song, 'chords')).toBe(false);
  expect(laneAudible(song, 'melody')).toBe(false);
});

test('laneAudible: a muted+soloed lane is NOT audible', () => {
  const song = makeSong({
    drums: { muted: true,  soloed: true },
    bass:  { muted: false, soloed: false },
  });
  expect(laneAudible(song, 'drums')).toBe(false);
  // bass is excluded by solo even though it's not muted
  expect(laneAudible(song, 'bass')).toBe(false);
});

// ─── toggleSolo ──────────────────────────────────────────────────────────────

test('toggleSolo flips soloed and returns new value', () => {
  const song = makeSong({
    drums: { muted: false, soloed: false },
  });
  expect(toggleSolo(song, 'drums')).toBe(true);
  expect(song.lanes.drums.soloed).toBe(true);
  expect(toggleSolo(song, 'drums')).toBe(false);
  expect(song.lanes.drums.soloed).toBe(false);
});

// ─── soloExclusive ───────────────────────────────────────────────────────────

test('soloExclusive: soloing A sets A=true and clears others', () => {
  const song = makeSong({
    drums: { muted: false, soloed: false },
    bass:  { muted: false, soloed: true },
  });
  soloExclusive(song, 'drums');
  expect(song.lanes.drums.soloed).toBe(true);
  expect(song.lanes.bass.soloed).toBe(false);
});

test('soloExclusive: soloing A then B leaves only B soloed', () => {
  const song = makeSong({
    drums:  { muted: false, soloed: false },
    bass:   { muted: false, soloed: false },
    chords: { muted: false, soloed: false },
  });
  soloExclusive(song, 'drums');
  soloExclusive(song, 'bass');
  expect(song.lanes.drums.soloed).toBe(false);
  expect(song.lanes.bass.soloed).toBe(true);
  expect(song.lanes.chords.soloed).toBe(false);
});

test('soloExclusive: soloing A twice ends with nothing soloed', () => {
  const song = makeSong({
    drums: { muted: false, soloed: false },
    bass:  { muted: false, soloed: false },
  });
  soloExclusive(song, 'drums');
  soloExclusive(song, 'drums');
  expect(song.lanes.drums.soloed).toBe(false);
  expect(song.lanes.bass.soloed).toBe(false);
});
