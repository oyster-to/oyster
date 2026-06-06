// tests/lane-mutations.test.js
import { test, expect } from 'vitest';
import { addLane, duplicateLane, removeLane, renameLane, moveLane, uniqueLaneId } from '../engine/lanes.js';

function makeSong() {
  return {
    lanes: [
      { id: 'drums', type: 'drums', name: 'drums', muted: false, soloed: false },
      { id: 'melody', type: 'melody', name: 'melody', muted: false, soloed: false, tone: 'pulse' },
    ],
    grooves: {
      drums:  { beat: [{ kick: [0] }, { kick: [8] }], hats: [{ hat: [0] }] },
      melody: { riff: [[[0, 'C4', 2]], []], rest: [[]] },
    },
    patterns: [
      { bars: 2, lanes: { drums: 'beat', melody: 'riff' } },
      { bars: 1, lanes: { drums: 'hats', melody: 'rest' } },
    ],
    chain: [0, 1],
    fills: {},
  };
}

test('addLane appends a lane with an "empty" groove and that pick in EVERY pattern', () => {
  const s = makeSong();
  const lane = addLane(s, 'bass');
  expect(lane.id).toBe('bass');
  expect(s.grooves.bass).toEqual({ empty: [[]] });        // melodic empty bar
  expect(s.patterns[0].lanes.bass).toBe('empty');
  expect(s.patterns[1].lanes.bass).toBe('empty');
});

test('addLane drums gets an "empty" groove with a {} bar', () => {
  const s = makeSong();
  const lane = addLane(s, 'drums');
  expect(lane.id).toBe('drums-2');
  expect(s.grooves['drums-2']).toEqual({ empty: [{}] });
  expect(s.patterns[0].lanes['drums-2']).toBe('empty');
});

test('duplicateLane deep-copies the source groove map and copies its picks', () => {
  const s = makeSong();
  const lane = duplicateLane(s, 'drums');
  expect(lane.id).toBe('drums-2');
  expect(s.grooves['drums-2']).toEqual(s.grooves.drums);   // same content
  // deep copy — mutating the clone doesn't touch the source
  s.grooves['drums-2'].beat[0].kick.push(4);
  expect(s.grooves.drums.beat[0].kick).toEqual([0]);
  // picks copied in every pattern
  expect(s.patterns[0].lanes['drums-2']).toBe('beat');
  expect(s.patterns[1].lanes['drums-2']).toBe('hats');
  expect(s.lanes[1].id).toBe('drums-2');                   // inserted after source
});

test('removeLane removes its grooves and picks from every pattern; last lane guarded', () => {
  const s = makeSong();
  expect(removeLane(s, 'melody')).toBe('melody');
  expect(s.grooves.melody).toBeUndefined();
  expect(s.patterns[0].lanes.melody).toBeUndefined();
  expect(removeLane(s, 'drums')).toBeNull();               // last lane
});

test('renameLane trims and ignores empty; moveLane clamps', () => {
  const s = makeSong();
  renameLane(s, 'drums', '  kit  ');
  expect(s.lanes[0].name).toBe('kit');
  renameLane(s, 'drums', '   ');
  expect(s.lanes[0].name).toBe('kit');
  moveLane(s, 'drums', 99);
  expect(s.lanes[1].id).toBe('drums');
  renameLane(s, 'nope', 'x');
  expect(s.lanes.map(l => l.name)).toEqual(['melody', 'kit']);
});

test('moveLane reorders earlier; unknown id is a null no-op', () => {
  const s = makeSong();
  moveLane(s, 'melody', 0);
  expect(s.lanes.map(l => l.id)).toEqual(['melody', 'drums']);
  expect(moveLane(s, 'nope', 0)).toBeNull();
  expect(s.lanes.map(l => l.id)).toEqual(['melody', 'drums']);
});

test('uniqueLaneId skips taken ids', () => {
  expect(uniqueLaneId([{ id: 'bass' }, { id: 'bass-2' }], 'bass')).toBe('bass-3');
});
