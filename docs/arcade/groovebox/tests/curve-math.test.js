// tests/curve-math.test.js — the pure param↔geometry math behind the visual
// instrument editor (envelope + filter graphs). DOM/drag lives in the widgets;
// this is the testable core: scale-aware mapping, handle layout, drag inverse.
import { describe, it, expect } from 'vitest';
import {
  posToVal, valToPos,
  ENV_GEOM, envHandles, attackFromX, decayFromX, sustainFromY, releaseFromX,
  FILT_GEOM, filterHandle, freqFromX, qFromY,
} from '../ui/curve-math.js';

describe('posToVal / valToPos — scale-aware, clamped', () => {
  it('maps endpoints: pos 0 → min, pos 1 → max (log + linear)', () => {
    expect(posToVal('filter.freq', 0)).toBeCloseTo(40, 5);
    expect(posToVal('filter.freq', 1)).toBeCloseTo(20000, 5);
    expect(posToVal('envelope.sustain', 0)).toBeCloseTo(0, 5);
    expect(posToVal('envelope.sustain', 1)).toBeCloseTo(1, 5);
  });
  it('round-trips value → pos → value on a log scale', () => {
    for (const v of [50, 200, 1300, 8000]) {
      expect(posToVal('filter.freq', valToPos('filter.freq', v))).toBeCloseTo(v, 2);
    }
  });
  it('round-trips on a linear scale', () => {
    for (const v of [0, 0.18, 0.55, 1]) {
      expect(posToVal('envelope.sustain', valToPos('envelope.sustain', v))).toBeCloseTo(v, 6);
    }
  });
  it('clamps pos and value to [0,1] domain', () => {
    expect(posToVal('filter.Q', -0.5)).toBeCloseTo(0, 6);    // Q min 0
    expect(posToVal('filter.Q', 2)).toBeCloseTo(20, 6);      // Q max 20
    expect(valToPos('filter.freq', 10)).toBe(0);             // below min
    expect(valToPos('filter.freq', 99999)).toBe(1);          // above max
  });
});

describe('ADSR envelope geometry', () => {
  const env = { attack: 0.02, decay: 0.2, sustain: 0.55, release: 0.3 };

  it('handles read left-to-right (A ≤ D/S ≤ R)', () => {
    const h = envHandles(env);
    expect(h.a.x).toBeLessThanOrEqual(h.ds.x);
    expect(h.ds.x).toBeLessThanOrEqual(h.r.x);
  });
  it('sustain maps to height: 1 → top, 0 → bottom', () => {
    expect(envHandles({ ...env, sustain: 1 }).ds.y).toBeCloseTo(ENV_GEOM.top, 5);
    expect(envHandles({ ...env, sustain: 0 }).ds.y).toBeCloseTo(ENV_GEOM.bottom, 5);
  });
  it('drag inverse recovers each param', () => {
    const h = envHandles(env);
    expect(attackFromX(h.a.x)).toBeCloseTo(env.attack, 4);
    expect(decayFromX(h.ds.x, env)).toBeCloseTo(env.decay, 4);
    expect(sustainFromY(h.ds.y)).toBeCloseTo(env.sustain, 6);
    expect(releaseFromX(h.r.x, env)).toBeCloseTo(env.release, 4);
  });
  it('clamps drags past the edges to the param range', () => {
    expect(attackFromX(-9999)).toBeCloseTo(0.001, 6);   // envelope.attack min
    expect(sustainFromY(-9999)).toBeCloseTo(1, 6);
    expect(sustainFromY(99999)).toBeCloseTo(0, 6);
  });
});

describe('lowpass filter geometry', () => {
  const f = { freq: 1300, Q: 8 };
  it('handle round-trips cutoff (x) and resonance (y)', () => {
    const h = filterHandle(f);
    expect(freqFromX(h.x)).toBeCloseTo(1300, 1);
    expect(qFromY(h.y)).toBeCloseTo(8, 4);
  });
  it('higher resonance sits higher (smaller y)', () => {
    expect(filterHandle({ freq: 1300, Q: 16 }).y).toBeLessThan(filterHandle({ freq: 1300, Q: 2 }).y);
  });
});
