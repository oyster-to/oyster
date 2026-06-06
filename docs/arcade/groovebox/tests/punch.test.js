import { describe, it, expect } from 'vitest';
import { PUNCH_NEUTRAL, PUNCH_PARAMS, stutterAllowed, stutterEvents, isPunchArmed, diveFreqForAmount } from '../engine/punch.js';

describe('PUNCH_NEUTRAL', () => {
  it('pins the idle chain to audibly-transparent values (spec safeguard 3)', () => {
    expect(PUNCH_NEUTRAL).toEqual({
      gateGain: 1, crushWet: 0, filterFreq: 20000, filterQ: 0.7, throwWet: 0, tapeDelay: 0,
    });
  });
});

describe('stutterAllowed', () => {
  it('blocks stutter while STOP holds the gate (spec safeguard 1)', () => {
    expect(stutterAllowed({ stutter: true, stop: true })).toBe(false);
  });
  it('allows stutter otherwise', () => {
    expect(stutterAllowed({ stutter: true, stop: false })).toBe(true);
  });
});

describe('stutterEvents', () => {
  const SIX = 0.125; // one 16th at 120bpm
  it('opens the first half of the step, closes the second, with 3ms edges', () => {
    expect(stutterEvents(10, SIX)).toEqual([
      [10.003, 1],
      [10 + SIX / 2, 1],
      [10 + SIX / 2 + 0.003, 0],
      [10 + SIX, 0],
    ]);
  });
  it('lands the final breakpoint exactly on the next step boundary, closed', () => {
    const ev = stutterEvents(0, SIX);
    expect(ev[ev.length - 1]).toEqual([SIX, 0]);
  });
});

describe('PUNCH_PARAMS', () => {
  it('pins engaged-target defaults (crush 0.9 per dogfood verdict)', () => {
    expect(PUNCH_PARAMS.crush).toEqual({ bits: 6, wet: 0.9 });
    expect(PUNCH_PARAMS.dive.freq).toBe(150);
    expect(PUNCH_PARAMS.throw.wet).toBeGreaterThan(0);
    expect(PUNCH_PARAMS.stop.depth).toBeGreaterThan(0);
  });
});

describe('isPunchArmed', () => {
  it('defaults to armed when the lane has no punchArm flag', () => {
    expect(isPunchArmed({})).toBe(true);
  });
  it('respects an explicit false', () => {
    expect(isPunchArmed({ punchArm: false })).toBe(false);
  });
  it('respects an explicit true', () => {
    expect(isPunchArmed({ punchArm: true })).toBe(true);
  });
});

describe('diveFreqForAmount', () => {
  it('hits the full dive target at amount 1', () => {
    expect(diveFreqForAmount(1)).toBeCloseTo(150, 5);
  });
  it('stays at neutral for amount 0', () => {
    expect(diveFreqForAmount(0)).toBeCloseTo(20000, 5);
  });
  it('interpolates in log space (perceptually even sweep)', () => {
    expect(diveFreqForAmount(0.5)).toBeCloseTo(Math.sqrt(20000 * 150), 3);
  });
});

describe('stutterEvents closed level', () => {
  it('chops to a partial level when closed > 0 (amount-scaled stutter)', () => {
    const ev = stutterEvents(0, 0.125, 0.003, 0.4);
    expect(ev[2][1]).toBe(0.4);
    expect(ev[3][1]).toBe(0.4);
  });
  it('defaults to a full chop (closed 0)', () => {
    const ev = stutterEvents(0, 0.125);
    expect(ev[2][1]).toBe(0);
    expect(ev[3][1]).toBe(0);
  });
});
