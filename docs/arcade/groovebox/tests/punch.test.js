import { describe, it, expect } from 'vitest';
import { PUNCH_NEUTRAL, PUNCH_PARAMS, stutterAllowed, stutterEvents } from '../engine/punch.js';

describe('PUNCH_NEUTRAL', () => {
  it('pins the idle chain to audibly-transparent values (spec safeguard 3)', () => {
    expect(PUNCH_NEUTRAL).toEqual({
      gateGain: 1, crushWet: 0, filterFreq: 20000, filterQ: 0.7, throwWet: 0, tapeDelay: 0,
    });
  });
});

describe('PUNCH_PARAMS', () => {
  it('ships sane engaged-target defaults (live-tunable via window.gbpunch)', () => {
    expect(PUNCH_PARAMS.crush.bits).toBeGreaterThanOrEqual(1);
    expect(PUNCH_PARAMS.crush.wet).toBeGreaterThan(0);
    expect(PUNCH_PARAMS.dive.freq).toBeLessThan(PUNCH_NEUTRAL.filterFreq);
    expect(PUNCH_PARAMS.throw.wet).toBeGreaterThan(0);
    expect(PUNCH_PARAMS.stop.depth).toBeGreaterThan(0);
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
