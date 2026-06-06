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

// Per-preset lane targeting: while any pads are held, a lane feeds the punch
// bus when at least one held preset's mask includes its type (null mask =
// all lanes). Idle (no masks) = everything routed, which is sonically
// transparent anyway. (The per-lane ⚡ arm chips were removed in v3.5 — one
// targeting system, on the preset, as data.)
export function laneInPunchBus(lane, activeMasks) {
  if (!activeMasks.length) return true;
  return activeMasks.some(m => m == null || m.includes(lane.type));
}

// GATE module math: tempo-synced chopper. division picks the chop cycle;
// depth 1 = chop to silence, depth d = chop to (1 - d). `ramp`-second edges
// so the chops don't click. stepIdx matters for divisions longer than one
// step ('1/8' alternates whole steps). Consumed via linearRampToValueAtTime;
// each step's final breakpoint is the level the next step ramps from.
export function gateEventsForStep(t, sixteenth, stepIdx, division, depth, ramp = 0.003) {
  const closed = 1 - depth;
  if (division === '1/4') {
    const lvl = (stepIdx % 4) < 2 ? 1 : closed;
    return [[t + ramp, lvl], [t + sixteenth, lvl]];
  }
  if (division === '1/8') {
    const lvl = stepIdx % 2 === 0 ? 1 : closed;
    return [[t + ramp, lvl], [t + sixteenth, lvl]];
  }
  if (division === '1/32') {
    const q = sixteenth / 4;
    return [
      [t + ramp, 1], [t + q, 1], [t + q + ramp, closed], [t + 2 * q, closed],
      [t + 2 * q + ramp, 1], [t + 3 * q, 1], [t + 3 * q + ramp, closed], [t + 4 * q, closed],
    ];
  }
  // default '1/16': open first half, closed second half of each step
  const half = sixteenth / 2;
  return [[t + ramp, 1], [t + half, 1], [t + half + ramp, closed], [t + sixteenth, closed]];
}

// Back-compat wrapper (v2 signature took the closed level, not depth).
export function stutterEvents(t, sixteenth, ramp = 0.003, closed = 0) {
  return gateEventsForStep(t, sixteenth, 0, '1/16', 1 - closed, ramp);
}

// ── v3: module-param registry + interpolation/timing math ────────────────────

// Registry: neutral value + AMT interpolation space for every automatable
// param. Presets may override scale per-automation; absent = this default.
// min/max are the single source of truth for valid automation targets:
// validatePreset enforces them; the editor's sliders read them (v3.5).
export const MODULE_PARAMS = {
  'crusher.wet':        { neutral: 0,     scale: 'linear', min: 0,   max: 1 },
  'filter.freq':        { neutral: 20000, scale: 'log',    min: 100, max: 20000 },
  'filter.Q':           { neutral: 0.7,   scale: 'linear', min: 0.5, max: 12 },
  'delay.wet':          { neutral: 0,     scale: 'linear', min: 0,   max: 1 },
  'delay.feedback':     { neutral: 0.55,  scale: 'linear', min: 0,   max: 0.95 },
  'gate.depth':         { neutral: 0,     scale: 'linear', min: 0,   max: 1 },
  'transport.tapeStop': { neutral: 0,     scale: 'linear', min: 0,   max: 1 },
};

// AMT interpolation from→to in the param's space (amount 0 = from, 1 = to).
export function scaleValue(from, to, amount, scale) {
  if (scale === 'log') return from * Math.pow(to / from, amount);
  return from + (to - from) * amount;
}

// Musical duration → seconds against the live tempo. Extensible by design:
// 'seconds' is reserved for a future schema rev and rejected in v3.
export function durationToSeconds(dur, t) {
  if (!dur) return 0;
  if (dur.unit === 'steps') return dur.value * t.sixteenth;
  if (dur.unit === 'beats') return dur.value * t.beatSeconds;
  if (dur.unit === 'bars')  return dur.value * t.barSeconds;
  throw new Error(`punch: unsupported duration unit "${dur.unit}"`);
}

// ── v4: per-lane capture/refcount ────────────────────────────────────────────
// Punch automations drive masked lanes' OWN fx params, which hold the user's
// knob values. The first automation on a (lane, param) captures that value;
// nested holds refcount; the LAST release restores. Pure Map logic.
export function engageCapture(map, key, current) {
  const e = map.get(key);
  if (e) { e.count++; return e.value; }
  map.set(key, { value: current, count: 1 });
  return current;
}
export function releaseCapture(map, key) {
  const e = map.get(key);
  if (!e) return null;
  if (--e.count > 0) return null;
  map.delete(key);
  return e.value;
}
