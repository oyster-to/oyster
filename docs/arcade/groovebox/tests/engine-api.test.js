import { test, expect } from 'vitest';
import { setLane, toggleMute } from '../engine/lanes.js';

test('setLane changes a lane selection in place', () => {
  const song = { lanes: { drums:{ selection:'a', muted:false }, bass:{ selection:'x', muted:false } } };
  setLane(song, 'drums', 'b');
  expect(song.lanes.drums.selection).toBe('b');
  expect(song.lanes.bass.selection).toBe('x');
});
test('toggleMute flips a lane mute and returns new value', () => {
  const song = { lanes: { drums:{ selection:'a', muted:false } } };
  expect(toggleMute(song, 'drums')).toBe(true);
  expect(song.lanes.drums.muted).toBe(true);
  expect(toggleMute(song, 'drums')).toBe(false);
});
