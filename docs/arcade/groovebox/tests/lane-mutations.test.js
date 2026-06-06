// tests/lane-mutations.test.js
import { test, expect } from 'vitest';
import { addLane, duplicateLane, removeLane, renameLane, moveLane, uniqueLaneId } from '../engine/lanes.js';

function makeSong() {
  return {
    lanes: [
      { id: 'drums', type: 'drums', name: 'drums', muted: false, soloed: false },
      { id: 'melody', type: 'melody', name: 'melody', muted: false, soloed: false, tone: 'pulse' },
    ],
    patterns: [
      { bars: 2, lanes: { drums: [{ kick: [0] }, { kick: [8] }], melody: [[[0, 'C4', 2]], []] } },
      { bars: 1, lanes: { drums: [{ hat: [0] }], melody: [[]] } },
    ],
    chain: [0, 1],
    fills: {},
  };
}

test('addLane appends a lane and gives it empty data in EVERY pattern', () => {
  const s = makeSong();
  const lane = addLane(s, 'bass');
  expect(lane.id).toBe('bass');
  expect(s.patterns[0].lanes.bass).toEqual([[], []]);     // bars:2 → 2 empty bars
  expect(s.patterns[1].lanes.bass).toEqual([[]]);
});

test('addLane on a duplicate type gets a fresh id', () => {
  const s = makeSong();
  const lane = addLane(s, 'drums');
  expect(lane.id).toBe('drums-2');
  expect(s.patterns[0].lanes['drums-2']).toEqual([{}, {}]);
});

test('duplicateLane deep-copies the source data in every pattern', () => {
  const s = makeSong();
  const lane = duplicateLane(s, 'drums');
  expect(lane.id).toBe('drums-2');
  expect(s.patterns[0].lanes['drums-2']).toEqual([{ kick: [0] }, { kick: [8] }]);
  s.patterns[0].lanes['drums-2'][0].kick.push(4);
  expect(s.patterns[0].lanes.drums[0].kick).toEqual([0]); // deep copy, not shared
  expect(s.lanes[1].id).toBe('drums-2');                  // inserted after source
});

test('removeLane removes its data from every pattern; last lane is guarded', () => {
  const s = makeSong();
  expect(removeLane(s, 'melody')).toBe('melody');
  expect(s.patterns[0].lanes.melody).toBeUndefined();
  expect(removeLane(s, 'drums')).toBeNull();              // last lane
});

test('renameLane trims and ignores empty; moveLane clamps', () => {
  const s = makeSong();
  renameLane(s, 'drums', '  kit  ');
  expect(s.lanes[0].name).toBe('kit');
  renameLane(s, 'drums', '   ');
  expect(s.lanes[0].name).toBe('kit');
  moveLane(s, 'drums', 99);
  expect(s.lanes[1].id).toBe('drums');
});

test('uniqueLaneId skips taken ids', () => {
  expect(uniqueLaneId([{ id: 'bass' }, { id: 'bass-2' }], 'bass')).toBe('bass-3');
});
