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
      for (const lane of v2.lanes) expect(p.lanes[lane.id].length).toBeGreaterThanOrEqual(p.bars);
    }
    for (const lane of v2.lanes) {
      expect(lane.pool).toBeUndefined();
      expect(lane.selection).toBeUndefined();
    }
    expect(JSON.parse(JSON.stringify(v2))).toBeTruthy();   // fully JSON-serializable
  });
}
