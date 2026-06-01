import { test, expect } from 'vitest';
import { captureScene } from '../engine/lanes.js';

function makeSong(drums, bass, chords, melody) {
  return {
    lanes: {
      drums:  { selection: drums,  muted: false },
      bass:   { selection: bass,   muted: false },
      chords: { selection: chords, muted: false },
      melody: { selection: melody, muted: false },
    },
  };
}

test('captureScene snapshots all four lane selections', () => {
  const song = makeSong('house', '16ths', 'stab', 'hook');
  const scene = captureScene(song);
  expect(scene.lanes.drums).toBe('house');
  expect(scene.lanes.bass).toBe('16ths');
  expect(scene.lanes.chords).toBe('stab');
  expect(scene.lanes.melody).toBe('hook');
});

test('captureScene defaults bars to 4 and fill to null', () => {
  const song = makeSong('four', 'octave', 'pad', 'hook');
  const scene = captureScene(song);
  expect(scene.bars).toBe(4);
  expect(scene.fill).toBeNull();
});

test('captureScene is a snapshot — mutations to song do not change captured scene', () => {
  const song = makeSong('four', 'octave', 'pad', 'hook');
  const scene = captureScene(song);
  song.lanes.drums.selection = 'NIN';
  expect(scene.lanes.drums).toBe('four');
});
