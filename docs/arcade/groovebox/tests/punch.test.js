import { describe, it, expect } from 'vitest';
import { PUNCH_NEUTRAL, PUNCH_PARAMS, MODULE_PARAMS, scaleValue, durationToSeconds, stutterAllowed, stutterEvents, isPunchArmed, diveFreqForAmount } from '../engine/punch.js';

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

describe('MODULE_PARAMS registry', () => {
  it('declares neutral + scale for every automatable param', () => {
    expect(MODULE_PARAMS['filter.freq']).toEqual({ neutral: 20000, scale: 'log' });
    expect(MODULE_PARAMS['filter.Q']).toEqual({ neutral: 0.7, scale: 'linear' });
    expect(MODULE_PARAMS['crusher.wet']).toEqual({ neutral: 0, scale: 'linear' });
    expect(MODULE_PARAMS['delay.wet']).toEqual({ neutral: 0, scale: 'linear' });
    expect(MODULE_PARAMS['delay.feedback']).toEqual({ neutral: 0.55, scale: 'linear' });
    expect(MODULE_PARAMS['gate.depth']).toEqual({ neutral: 0, scale: 'linear' });
    expect(MODULE_PARAMS['transport.tapeStop']).toEqual({ neutral: 0, scale: 'linear' });
  });
});

describe('scaleValue', () => {
  it('linear endpoints + midpoint', () => {
    expect(scaleValue(0, 0.9, 1, 'linear')).toBeCloseTo(0.9);
    expect(scaleValue(0, 0.9, 0, 'linear')).toBeCloseTo(0);
    expect(scaleValue(0, 0.9, 0.5, 'linear')).toBeCloseTo(0.45);
  });
  it('log endpoints + midpoint (perceptual sweep)', () => {
    expect(scaleValue(20000, 150, 1, 'log')).toBeCloseTo(150, 4);
    expect(scaleValue(20000, 150, 0, 'log')).toBeCloseTo(20000, 4);
    expect(scaleValue(20000, 150, 0.5, 'log')).toBeCloseTo(Math.sqrt(20000 * 150), 2);
  });
});

describe('durationToSeconds', () => {
  const T = { sixteenth: 0.125, beatSeconds: 0.5, barSeconds: 2 }; // 120bpm 4/4
  it('resolves steps/beats/bars', () => {
    expect(durationToSeconds({ unit: 'steps', value: 0.5 }, T)).toBeCloseTo(0.0625);
    expect(durationToSeconds({ unit: 'beats', value: 3 }, T)).toBeCloseTo(1.5);
    expect(durationToSeconds({ unit: 'bars', value: 1 }, T)).toBeCloseTo(2);
  });
  it('returns 0 for missing duration', () => {
    expect(durationToSeconds(null, T)).toBe(0);
  });
  it('throws on unknown unit (seconds is future, not v3)', () => {
    expect(() => durationToSeconds({ unit: 'seconds', value: 1 }, T)).toThrow();
  });
});
