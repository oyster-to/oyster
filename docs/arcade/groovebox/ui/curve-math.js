// ui/curve-math.js — pure param↔geometry math for the visual instrument editor.
// No DOM. The envelope/filter widgets own pointer handling and SVG; this owns
// the mapping between a patch param and a handle coordinate (and back), honouring
// the registry's per-param scale. Parity with the slider editor: posToVal/valToPos
// are the same scale math the sliders used, lifted here as the single source.
import { PATCH_PARAMS } from '../engine/instruments.js';

const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);

/** posToVal(id, pos) — normalized slider/handle position (0..1) → param value. */
export function posToVal(id, pos) {
  const { min, max, scale } = PATCH_PARAMS[id];
  const p = clamp01(pos);
  return scale === 'log' ? min * Math.pow(max / min, p) : min + (max - min) * p;
}

/** valToPos(id, v) — param value → normalized position (0..1), clamped. */
export function valToPos(id, v) {
  const { min, max, scale } = PATCH_PARAMS[id];
  const p = scale === 'log' ? Math.log(v / min) / Math.log(max / min) : (v - min) / (max - min);
  return clamp01(p);
}

// ── ADSR envelope ────────────────────────────────────────────────────────────
// Three handles for four params (decay + sustain share a handle, as in most
// soft-synths): A controls attack (x only); D/S controls decay (x) + sustain (y);
// R controls release (x only). Each time param is a horizontal lane; sustain is
// the only vertical axis. Layout (in viewBox units): A lane, D lane, a fixed
// sustain-hold gap, then the R lane.
export const ENV_GEOM = { x0: 6, top: 8, bottom: 72, wA: 70, wD: 70, hold: 46, wR: 80 };

export function envHandles(env, g = ENV_GEOM) {
  const ax = g.x0 + valToPos('envelope.attack', env.attack) * g.wA;
  const dx = ax + valToPos('envelope.decay', env.decay) * g.wD;
  const sy = g.bottom - clamp01(env.sustain) * (g.bottom - g.top);
  const rx = dx + g.hold + valToPos('envelope.release', env.release) * g.wR;
  return { a: { x: ax, y: g.top }, ds: { x: dx, y: sy }, r: { x: rx, y: g.bottom } };
}

/** SVG path for the envelope outline (silence → peak → sustain → hold → silence). */
export function envPath(env, g = ENV_GEOM) {
  const h = envHandles(env, g);
  return `M${g.x0},${g.bottom} L${h.a.x},${g.top} L${h.ds.x},${h.ds.y} L${h.ds.x + g.hold},${h.ds.y} L${h.r.x},${g.bottom}`;
}

// Drag inverses. Time handles need their left anchor (which depends on earlier
// params), so the dependent ones take the current env.
export function attackFromX(x, g = ENV_GEOM) {
  return posToVal('envelope.attack', (x - g.x0) / g.wA);
}
export function decayFromX(x, env, g = ENV_GEOM) {
  const ax = g.x0 + valToPos('envelope.attack', env.attack) * g.wA;
  return posToVal('envelope.decay', (x - ax) / g.wD);
}
export function sustainFromY(y, g = ENV_GEOM) {
  return clamp01((g.bottom - y) / (g.bottom - g.top));
}
export function releaseFromX(x, env, g = ENV_GEOM) {
  const h = envHandles(env, g);
  return posToVal('envelope.release', (x - h.ds.x - g.hold) / g.wR);
}

// ── lowpass filter (poly) ────────────────────────────────────────────────────
// One handle: x = cutoff (filter.freq), y = resonance (filter.Q, higher = taller
// peak = smaller y). The widget draws the response curve through it.
export const FILT_GEOM = { x0: 6, x1: 294, top: 6, base: 30, bottom: 46 };

export function filterHandle(f, g = FILT_GEOM) {
  return {
    x: g.x0 + valToPos('filter.freq', f.freq) * (g.x1 - g.x0),
    y: g.base - valToPos('filter.Q', f.Q) * (g.base - g.top),
  };
}
export function freqFromX(x, g = FILT_GEOM) {
  return posToVal('filter.freq', (x - g.x0) / (g.x1 - g.x0));
}
export function qFromY(y, g = FILT_GEOM) {
  return posToVal('filter.Q', (g.base - y) / (g.base - g.top));
}
