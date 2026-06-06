import { test, expect } from 'vitest';
import { flattenSong } from '../engine/flatten.js';
import { patternBars, grooveBars } from '../engine/patterns.js';

// A groove is a literal bars[] array OR a chord-relative wrapper
// { relative:true, bars:[…] }. grooveBars() normalizes both to the bars array.
function isValidGroove(g) {
  if (Array.isArray(g)) return g.length >= 1 && g.length <= 8;
  if (g && g.relative === true) return Array.isArray(g.bars) && g.bars.length >= 1 && g.bars.length <= 8;
  return false;
}
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
    for (let pi = 0; pi < v2.patterns.length; pi++) {
      const p = v2.patterns[pi];
      // pattern.bars is gone — duration is derived from the longest picked groove.
      expect(p.bars).toBeUndefined();
      // Every pick references an existing, well-formed groove (literal or relative).
      for (const lane of v2.lanes) {
        const name = p.lanes[lane.id];
        expect(typeof name).toBe('string');
        const g = v2.grooves[lane.id]?.[name];
        expect(isValidGroove(g)).toBe(true);
      }
      // Literal lanes (drums/melody, plus any untranslated bass/chords) share one
      // length per pattern. Chord-relative grooves are one bar and cycle
      // underneath — they're excluded from this check.
      const litLengths = v2.lanes
        .map(l => v2.grooves[l.id][p.lanes[l.id]])
        .filter(g => Array.isArray(g))
        .map(g => g.length);
      expect(new Set(litLengths).size).toBe(1);
      // Relative grooves are exactly one bar.
      for (const lane of v2.lanes) {
        const g = v2.grooves[lane.id][p.lanes[lane.id]];
        if (g && g.relative) expect(grooveBars(g).length).toBe(1);
      }
      expect([1, 2, 4]).toContain(patternBars(v2, pi));
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

  // All derived pattern bar counts are valid.
  for (let pi = 0; pi < v2.patterns.length; pi++) {
    expect(v2.patterns[pi].bars).toBeUndefined();
    expect([1, 2, 4]).toContain(patternBars(v2, pi));
  }

  // Stream is non-empty.
  const stream1 = renderChainStream(v2);
  expect(stream1.length).toBeGreaterThan(0);

  // Stream is deterministic (second call produces identical output).
  expect(renderChainStream(v2)).toEqual(stream1);
});
