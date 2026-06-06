// Pure punch-in FX helpers — Tone-free so they're unit-testable.
// Spec: project-notes/oyster/po20/2026-06-08-punch-in-fx-spec.md
//       + 2026-06-08-punch-bus-assign-v2-spec.md (arm chips, AMOUNT)

// Neutral (idle) values for the pre-wired punch chain. Single source of
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

// Engaged (held) targets for each punch effect — internal tuning surface,
// fixed defaults (crush 0.9: dogfood verdict — drums-only takes near-full).
export const PUNCH_PARAMS = {
  crush: { bits: 6, wet: 0.9 },
  dive:  { freq: 150, q: 8, ramp: 0.15 },
  throw: { wet: 0.6, feedback: 0.55, release: 1.5 },
  stop:  { depth: 0.6, time: 0.8 },
};

// Punch bus channel-assign: lanes are armed by default; only an explicit
// punchArm === false opts a lane out (serializes with the lane object).
export function isPunchArmed(lane) {
  return lane.punchArm !== false;
}

// AMOUNT-scaled dive target. Log-space interpolation so half-amount sounds
// like half a sweep, not a barely-audible top-end shelf.
export function diveFreqForAmount(amount, neutral = PUNCH_NEUTRAL.filterFreq, target = PUNCH_PARAMS.dive.freq) {
  return neutral * Math.pow(target / neutral, amount);
}

// STOP owns the gate (spec safeguard 1): stutter must not schedule gate
// events while stop is held.
export function stutterAllowed(held) {
  return !held.stop;
}

// Gate envelope breakpoints for one 16th step: open first half, `closed`-level
// second half (0 = full chop; AMOUNT scales it via closed = 1 - amount), with
// `ramp`-second edges so the chops don't click. Consumed via
// linearRampToValueAtTime; the final [stepEnd, closed] means the next step's
// opening edge ramps cleanly from the closed level.
export function stutterEvents(t, sixteenth, ramp = 0.003, closed = 0) {
  const half = sixteenth / 2;
  return [
    [t + ramp, 1],
    [t + half, 1],
    [t + half + ramp, closed],
    [t + sixteenth, closed],
  ];
}
