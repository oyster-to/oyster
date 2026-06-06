import { test, expect } from 'vitest';
import { captureScene, normalizeLanes } from '../engine/lanes.js';

function makeLanes(drums, bass, chords, melody) {
  return normalizeLanes({ drums: { selection: drums, muted: false }, bass: { selection: bass, muted: false }, chords: { selection: chords, muted: false }, melody: { selection: melody, muted: false } });
}

test('captureScene snapshots all four lane selections by id', () => {
  const lanes = makeLanes('house', '16ths', 'stab', 'hook');
  const scene = captureScene(lanes);
  expect(scene.lanes.drums).toBe('house');
  expect(scene.lanes.bass).toBe('16ths');
  expect(scene.lanes.chords).toBe('stab');
  expect(scene.lanes.melody).toBe('hook');
});

test('captureScene defaults bars to 4 and fill to null', () => {
  const lanes = makeLanes('four', 'octave', 'pad', 'hook');
  const scene = captureScene(lanes);
  expect(scene.bars).toBe(4);
  expect(scene.fill).toBeNull();
});

test('captureScene is a snapshot — mutations to lanes do not change captured scene', () => {
  const lanes = makeLanes('four', 'octave', 'pad', 'hook');
  const scene = captureScene(lanes);
  lanes[0].selection = 'NIN';
  expect(scene.lanes.drums).toBe('four');
});
