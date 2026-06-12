import { describe, it, expect } from 'vitest';
import { GROOVE_PRESETS, meterKey } from '../engine/groove-presets.js';
import { validateGroovePayload } from '../registry/validate.js';
import { createEngine } from '../engine/index.js';
import { blank, blankWaltz } from '../songs/blank.js';

const METERS = {
  '4/4': { beatsPerBar: 4, beatUnit: 4, stepsPerBeat: 4 },
  '3/4': { beatsPerBar: 3, beatUnit: 4, stepsPerBeat: 4 },
};

describe('GROOVE_PRESETS', () => {
  it('every preset in every meter passes the registry groove validator', () => {
    for (const [mk, pool] of Object.entries(GROOVE_PRESETS)) {
      for (const [laneType, presets] of Object.entries(pool)) {
        for (const [name, value] of Object.entries(presets)) {
          const payload = {
            laneType, meter: METERS[mk],
            bars: Array.isArray(value) ? value : value.bars,
            ...(Array.isArray(value) ? {} : { relative: true }),
          };
          const res = validateGroovePayload(payload);
          expect(res.ok, `${mk} ${laneType}/${name}: ${res.error || ''}`).toBe(true);
        }
      }
    }
  });

  it('bass/chords presets are all relative; drums all literal', () => {
    for (const pool of Object.values(GROOVE_PRESETS)) {
      for (const v of Object.values(pool.drums))  expect(Array.isArray(v)).toBe(true);
      for (const v of Object.values(pool.bass))   expect(v.relative).toBe(true);
      for (const v of Object.values(pool.chords)) expect(v.relative).toBe(true);
    }
  });

  it('3/4 presets stay within the 12-step bar', () => {
    for (const presets of Object.values(GROOVE_PRESETS['3/4'])) {
      for (const value of Object.values(presets)) {
        const bars = Array.isArray(value) ? value : value.bars;
        for (const bar of bars) {
          const steps = Array.isArray(bar)
            ? bar.map(ev => ev[0])
            : Object.values(bar).flat().map(s => Array.isArray(s) ? s[0] : s);
          for (const s of steps) expect(s, 'step in 0..11').toBeLessThan(12);
        }
      }
    }
  });
});

describe('a New song stocked from the pool', () => {
  for (const [label, tpl] of [['4/4', blank], ['3/4 waltz', blankWaltz]]) {
    it(`${label}: accepts every preset via addGroove and can select each as the pick`, () => {
      const eng = createEngine();
      eng.load(structuredClone(tpl));
      const pool = GROOVE_PRESETS[meterKey(tpl.meter)];
      for (const lane of eng.getLanes()) {
        for (const [name, value] of Object.entries(pool[lane.type] || {})) {
          eng.addGroove(lane.id, name, structuredClone(value));
          expect(!!eng.getGrooves()[lane.id][name], `${lane.id}/${name} present`).toBe(true);
          expect(eng.setLaneGroove(lane.id, name), `${lane.id}/${name} selectable`).toBe(true);
        }
      }
    });
  }
});

describe('addGroove normalizes drum bars (the invisible-hits bug)', () => {
  it('stocked drum grooves come out GM-numeric, not named-key', () => {
    const eng = createEngine();
    eng.load(structuredClone(blank));
    const pool = GROOVE_PRESETS['4/4'];
    const drumLane = eng.getLanes().find(l => l.type === 'drums');
    for (const [name, value] of Object.entries(pool.drums)) {
      eng.addGroove(drumLane.id, name, structuredClone(value));
    }
    const bar = eng.getGrooves()[drumLane.id]['half-time'][0];
    expect(bar.kick, 'named keys gone').toBeUndefined();
    expect(bar[36], 'kick → GM 36').toEqual([0, 8, 10]);
    expect(bar[38], 'snare → GM 38').toEqual([4, 12]);
  });
});

describe('PROGRESSION_PRESETS', () => {
  it('every preset parses cleanly through the chord-line parser', async () => {
    const { parseProgression } = await import('../engine/chords.js');
    const { PROGRESSION_PRESETS } = await import('../engine/groove-presets.js');
    for (const p of PROGRESSION_PRESETS) {
      const { chords, errors } = parseProgression(p.chords);
      expect(errors, `${p.name}: ${JSON.stringify(errors)}`).toEqual([]);
      expect(chords.length, `${p.name} has chords`).toBeGreaterThanOrEqual(4);
    }
  });
});
