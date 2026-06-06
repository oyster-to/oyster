import { test, expect } from 'vitest';
import { laneByType } from '../engine/lanes.js';
import { laneAudible } from '../engine/song.js';

// ─── laneByType ──────────────────────────────────────────────────────────────

const defaultLanes = () => [
  { id: 'drums',  type: 'drums',  muted: false, soloed: false },
  { id: 'bass',   type: 'bass',   muted: false, soloed: false },
  { id: 'chords', type: 'chords', muted: false, soloed: false },
  { id: 'melody', type: 'melody', muted: false, soloed: false },
];

test('laneByType: returns the first lane of that type', () => {
  const lanes = defaultLanes();
  expect(laneByType(lanes, 'drums')).toBe(lanes[0]);
  expect(laneByType(lanes, 'melody')).toBe(lanes[3]);
});

test('laneByType: returns null for an unknown type', () => {
  const lanes = defaultLanes();
  expect(laneByType(lanes, 'synth')).toBeNull();
});

test('laneByType: returns the first of two melody-type lanes', () => {
  const lanes = defaultLanes();
  const dup = { ...lanes[3], id: 'melody-2', name: 'melody 2' };
  const withDup = [...lanes, dup];
  expect(laneByType(withDup, 'melody')).toBe(lanes[3]); // first melody
});

// ─── laneAudible across the list (solo semantics) ────────────────────────────

test('laneAudible: solo across list — one soloed mutes all others', () => {
  const lanes = [
    { id:'drums',  type:'drums',  muted:false, soloed:true  },
    { id:'bass',   type:'bass',   muted:false, soloed:false },
    { id:'chords', type:'chords', muted:false, soloed:false },
    { id:'melody', type:'melody', muted:false, soloed:false },
  ];
  expect(laneAudible(lanes, lanes[0])).toBe(true);
  expect(laneAudible(lanes, lanes[1])).toBe(false);
  expect(laneAudible(lanes, lanes[2])).toBe(false);
  expect(laneAudible(lanes, lanes[3])).toBe(false);
});

test('laneAudible: two lanes soloed — both audible, others not', () => {
  const lanes = [
    { id:'drums',  type:'drums',  muted:false, soloed:true  },
    { id:'bass',   type:'bass',   muted:false, soloed:true  },
    { id:'chords', type:'chords', muted:false, soloed:false },
    { id:'melody', type:'melody', muted:false, soloed:false },
  ];
  expect(laneAudible(lanes, lanes[0])).toBe(true);
  expect(laneAudible(lanes, lanes[1])).toBe(true);
  expect(laneAudible(lanes, lanes[2])).toBe(false);
  expect(laneAudible(lanes, lanes[3])).toBe(false);
});
