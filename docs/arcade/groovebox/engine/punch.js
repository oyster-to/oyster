// Pure punch-in FX helpers — Tone-free so they're unit-testable.
// Spec: project-notes/oyster/po20/2026-06-08-punch-in-fx-spec.md

// Neutral (idle) values for the pre-wired punch insert chain. Single source of
// truth: the engine builds and resets the chain from these; the test pins them
// to the spec (safeguard 3 — idle graph must be audibly transparent).
export const PUNCH_NEUTRAL = {
  gateGain: 1,
  crushWet: 0,
  filterFreq: 20000,
  filterQ: 0.7,
  throwWet: 0,
  tapeDelay: 0,
};

// STOP owns the gate (spec safeguard 1): stutter must not schedule gate
// events while stop is held.
export function stutterAllowed(held) {
  return !held.stop;
}

// Gate envelope breakpoints for one 16th step: open first half, closed second,
// with `ramp`-second edges so the chops don't click. Consumed via
// linearRampToValueAtTime; the final [stepEnd, 0] means the next step's
// opening edge ramps cleanly from 0.
export function stutterEvents(t, sixteenth, ramp = 0.003) {
  const half = sixteenth / 2;
  return [
    [t + ramp, 1],
    [t + half, 1],
    [t + half + ramp, 0],
    [t + sixteenth, 0],
  ];
}
