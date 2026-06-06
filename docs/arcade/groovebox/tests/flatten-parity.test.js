import { test, expect } from 'vitest';
import { flattenSong } from '../engine/flatten.js';
import { renderLegacyStream } from './legacy/legacy-engine.js';
import { renderChainStream } from './helpers/stream.js';
import { kids } from '../songs/kids.js';
import { risingSun } from '../songs/rising-sun.js';
import { electricFeel } from '../songs/electric-feel.js';
import { heartbeats } from '../songs/heartbeats.js';
import { digitalLove } from '../songs/digital-love.js';
import { memoryReboot } from '../songs/memory-reboot.js';
import { takeOnMe } from '../songs/take-on-me.js';

const SONGS = { kids, risingSun, electricFeel, heartbeats, digitalLove, memoryReboot, takeOnMe };

for (const [name, song] of Object.entries(SONGS)) {
  test(`flattened ${name} reproduces the legacy note stream (steady state)`, () => {
    const v2 = flattenSong(song);
    expect(renderChainStream(v2)).toEqual(renderLegacyStream(song));
  });

  test(`flattened ${name} satisfies schema invariants`, () => {
    const v2 = flattenSong(song);
    expect(v2.chain.length).toBeGreaterThanOrEqual(1);
    expect(v2.patterns.length).toBeGreaterThanOrEqual(1);
    for (const p of v2.patterns) {
      expect([1, 2, 4]).toContain(p.bars);
      // Every pick references an existing groove.
      for (const lane of v2.lanes) {
        const name = p.lanes[lane.id];
        expect(typeof name).toBe('string');
        expect(v2.grooves[lane.id]?.[name]).toBeDefined();
      }
    }
    // Every chain entry indexes an existing pattern.
    for (const pi of v2.chain) expect(v2.patterns[pi]).toBeDefined();
    for (const lane of v2.lanes) {
      expect(lane.pool).toBeUndefined();
      expect(lane.selection).toBeUndefined();
    }
    expect(JSON.parse(JSON.stringify(v2.grooves))).toBeTruthy();   // grooves JSON-serializable
    expect(JSON.parse(JSON.stringify(v2))).toBeTruthy();           // fully JSON-serializable
  });
}

// No-arrangement fallback: rich song with no `arrangement` key → synthetic 4-bar section.
test('flattenSong: no-arrangement fallback yields valid chain and non-empty stream', () => {
  const minimal = {
    title: 'Minimal',
    artist: 'Test',
    meter: { beatsPerBar: 4, beatUnit: 4, stepsPerBeat: 4 },
    bpm: 120,
    // No `arrangement` key — exercises the fallback branch in flatten.js.
    harmony: {
      progression: [
        { name: 'Am', root: 'A2', voicing: ['A3', 'C4', 'E4'] },
        { name: 'G',  root: 'G2', voicing: ['G3', 'B3', 'D4'] },
      ],
    },
    lanes: {
      drums:  {
        selection: 'four',
        pool: {
          four: { kick: [0, 8], snare: [4, 12], hat: [0, 2, 4, 6, 8, 10, 12, 14] },
        },
      },
      bass:   {
        selection: 'root',
        pool: {
          root: (bar, chord) => [[0, chord.root, 16]],
        },
      },
      chords: { selection: 'pad' },
      melody: {
        selection: 'phrase',
        pool: {
          phrase: [[[0, 'A4', 2], [4, 'C5', 2]]],
        },
      },
    },
  };

  const v2 = flattenSong(minimal);

  // Chain and patterns are non-empty.
  expect(v2.chain.length).toBeGreaterThanOrEqual(1);
  expect(v2.patterns.length).toBeGreaterThanOrEqual(1);

  // All pattern bar counts are valid.
  for (const p of v2.patterns) {
    expect([1, 2, 4]).toContain(p.bars);
  }

  // Stream is non-empty.
  const stream1 = renderChainStream(v2);
  expect(stream1.length).toBeGreaterThan(0);

  // Stream is deterministic (second call produces identical output).
  expect(renderChainStream(v2)).toEqual(stream1);
});
