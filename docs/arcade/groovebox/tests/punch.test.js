import { describe, it, expect } from 'vitest';
import { PUNCH_NEUTRAL, MODULE_PARAMS, scaleValue, durationToSeconds, gateEventsForStep, stutterEvents, isPunchArmed, laneInPunchBus } from '../engine/punch.js';

describe('PUNCH_NEUTRAL', () => {
  it('pins the idle chain to audibly-transparent values (spec safeguard 3)', () => {
    expect(PUNCH_NEUTRAL).toEqual({
      gateGain: 1, crushWet: 0, filterFreq: 20000, filterQ: 0.7, throwWet: 0, tapeDelay: 0,
    });
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
    expect(MODULE_PARAMS['filter.freq']).toEqual({ neutral: 20000, scale: 'log', min: 100, max: 20000 });
    expect(MODULE_PARAMS['filter.Q']).toEqual({ neutral: 0.7, scale: 'linear', min: 0.5, max: 12 });
    expect(MODULE_PARAMS['crusher.wet']).toEqual({ neutral: 0, scale: 'linear', min: 0, max: 1 });
    expect(MODULE_PARAMS['delay.wet']).toEqual({ neutral: 0, scale: 'linear', min: 0, max: 1 });
    expect(MODULE_PARAMS['delay.feedback']).toEqual({ neutral: 0.55, scale: 'linear', min: 0, max: 0.95 });
    expect(MODULE_PARAMS['gate.depth']).toEqual({ neutral: 0, scale: 'linear', min: 0, max: 1 });
    expect(MODULE_PARAMS['transport.tapeStop']).toEqual({ neutral: 0, scale: 'linear', min: 0, max: 1 });
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

describe('gateEventsForStep', () => {
  const SIX = 0.125;
  it("division '1/16' = open first half, closed second (v2 stutter parity)", () => {
    expect(gateEventsForStep(10, SIX, 0, '1/16', 1)).toEqual([
      [10.003, 1], [10 + SIX / 2, 1], [10 + SIX / 2 + 0.003, 0], [10 + SIX, 0],
    ]);
  });
  it("division '1/8' alternates whole steps: even open, odd closed", () => {
    expect(gateEventsForStep(0, SIX, 0, '1/8', 1)).toEqual([[0.003, 1], [SIX, 1]]);
    expect(gateEventsForStep(0, SIX, 1, '1/8', 1)).toEqual([[0.003, 0], [SIX, 0]]);
  });
  it("division '1/32' chops twice per step", () => {
    const q = SIX / 4;
    expect(gateEventsForStep(0, SIX, 0, '1/32', 1)).toEqual([
      [0.003, 1], [q, 1], [q + 0.003, 0], [2 * q, 0],
      [2 * q + 0.003, 1], [3 * q, 1], [3 * q + 0.003, 0], [4 * q, 0],
    ]);
  });
  it("division '1/4' chops in half-beat halves: 2 steps open, 2 closed", () => {
    expect(gateEventsForStep(0, SIX, 0, '1/4', 1)).toEqual([[0.003, 1], [SIX, 1]]);
    expect(gateEventsForStep(0, SIX, 1, '1/4', 1)).toEqual([[0.003, 1], [SIX, 1]]);
    expect(gateEventsForStep(0, SIX, 2, '1/4', 1)).toEqual([[0.003, 0], [SIX, 0]]);
    expect(gateEventsForStep(0, SIX, 3, '1/4', 1)).toEqual([[0.003, 0], [SIX, 0]]);
  });
  it('depth scales the closed level (depth 0.6 → closed 0.4)', () => {
    const ev = gateEventsForStep(0, SIX, 0, '1/16', 0.6);
    expect(ev[2][1]).toBeCloseTo(0.4);
    expect(ev[3][1]).toBeCloseTo(0.4);
  });
  it('stutterEvents stays as the 1/16 wrapper (v2 back-compat)', () => {
    expect(stutterEvents(5, SIX, 0.003, 0.25)).toEqual(gateEventsForStep(5, SIX, 0, '1/16', 0.75));
  });
});

describe('laneInPunchBus (chips ∩ active masks, union across held pads)', () => {
  const lane = { type: 'bass' };
  it('unarmed lane never routes', () => {
    expect(laneInPunchBus({ ...lane, punchArm: false }, [['drums', 'bass']])).toBe(false);
  });
  it('no active masks → armed lanes route (idle/transparent state)', () => {
    expect(laneInPunchBus(lane, [])).toBe(true);
  });
  it('routes when any active mask includes the lane type (union)', () => {
    expect(laneInPunchBus(lane, [['drums'], ['bass', 'chords']])).toBe(true);
    expect(laneInPunchBus(lane, [['drums'], ['chords']])).toBe(false);
  });
  it('null mask in the set means all lanes', () => {
    expect(laneInPunchBus(lane, [null, ['drums']])).toBe(true);
  });
});
