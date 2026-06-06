import { test, expect } from 'vitest';
import { setLane, toggleMute, normalizeLanes } from '../engine/lanes.js';

function makeLanes(extra = {}) {
  return normalizeLanes({ drums: { selection: 'a', muted: false }, bass: { selection: 'x', muted: false }, ...extra });
}

test('setLane changes a lane selection in place by id', () => {
  const lanes = makeLanes();
  setLane(lanes, 'drums', 'b');
  const drums = lanes.find(l => l.id === 'drums');
  const bass  = lanes.find(l => l.id === 'bass');
  expect(drums.selection).toBe('b');
  expect(bass.selection).toBe('x');
});

test('toggleMute flips a lane mute by id and returns new value', () => {
  const lanes = makeLanes();
  const drums = lanes.find(l => l.id === 'drums');
  expect(toggleMute(lanes, 'drums')).toBe(true);
  expect(drums.muted).toBe(true);
  expect(toggleMute(lanes, 'drums')).toBe(false);
  expect(drums.muted).toBe(false);
});
