import { test, expect } from 'vitest';
import { toggleSolo, soloExclusive, normalizeLanes } from '../engine/lanes.js';
import { laneAudible } from '../engine/song.js';

// ─── laneAudible ─────────────────────────────────────────────────────────────

function makeLanes(spec) {
  // spec: [{ id, muted, soloed }, …]  or object { drums:{…}, bass:{…}, … }
  if (Array.isArray(spec)) return spec;
  return normalizeLanes(spec);
}

test('laneAudible: no solo — audible iff not muted', () => {
  const lanes = [
    { id: 'drums', type: 'drums', muted: false, soloed: false },
    { id: 'bass',  type: 'bass',  muted: true,  soloed: false },
  ];
  expect(laneAudible(lanes, lanes[0])).toBe(true);
  expect(laneAudible(lanes, lanes[1])).toBe(false);
});

test('laneAudible: with one lane soloed, only that lane is audible', () => {
  const lanes = [
    { id: 'drums',  type: 'drums',  muted: false, soloed: true  },
    { id: 'bass',   type: 'bass',   muted: false, soloed: false },
    { id: 'chords', type: 'chords', muted: false, soloed: false },
    { id: 'melody', type: 'melody', muted: false, soloed: false },
  ];
  expect(laneAudible(lanes, lanes[0])).toBe(true);
  expect(laneAudible(lanes, lanes[1])).toBe(false);
  expect(laneAudible(lanes, lanes[2])).toBe(false);
  expect(laneAudible(lanes, lanes[3])).toBe(false);
});

test('laneAudible: a muted+soloed lane is NOT audible', () => {
  const lanes = [
    { id: 'drums', type: 'drums', muted: true,  soloed: true  },
    { id: 'bass',  type: 'bass',  muted: false, soloed: false },
  ];
  expect(laneAudible(lanes, lanes[0])).toBe(false);
  // bass is excluded by solo even though it's not muted
  expect(laneAudible(lanes, lanes[1])).toBe(false);
});

// ─── toggleSolo ──────────────────────────────────────────────────────────────

test('toggleSolo flips soloed and returns new value', () => {
  const lanes = [{ id: 'drums', type: 'drums', muted: false, soloed: false }];
  expect(toggleSolo(lanes, 'drums')).toBe(true);
  expect(lanes[0].soloed).toBe(true);
  expect(toggleSolo(lanes, 'drums')).toBe(false);
  expect(lanes[0].soloed).toBe(false);
});

// ─── soloExclusive ───────────────────────────────────────────────────────────

test('soloExclusive: soloing A sets A=true and clears others', () => {
  const lanes = [
    { id: 'drums', type: 'drums', muted: false, soloed: false },
    { id: 'bass',  type: 'bass',  muted: false, soloed: true  },
  ];
  soloExclusive(lanes, 'drums');
  expect(lanes[0].soloed).toBe(true);
  expect(lanes[1].soloed).toBe(false);
});

test('soloExclusive: soloing A then B leaves only B soloed', () => {
  const lanes = [
    { id: 'drums',  type: 'drums',  muted: false, soloed: false },
    { id: 'bass',   type: 'bass',   muted: false, soloed: false },
    { id: 'chords', type: 'chords', muted: false, soloed: false },
  ];
  soloExclusive(lanes, 'drums');
  soloExclusive(lanes, 'bass');
  expect(lanes[0].soloed).toBe(false);
  expect(lanes[1].soloed).toBe(true);
  expect(lanes[2].soloed).toBe(false);
});

test('soloExclusive: soloing A twice ends with nothing soloed', () => {
  const lanes = [
    { id: 'drums', type: 'drums', muted: false, soloed: false },
    { id: 'bass',  type: 'bass',  muted: false, soloed: false },
  ];
  soloExclusive(lanes, 'drums');
  soloExclusive(lanes, 'drums');
  expect(lanes[0].soloed).toBe(false);
  expect(lanes[1].soloed).toBe(false);
});
