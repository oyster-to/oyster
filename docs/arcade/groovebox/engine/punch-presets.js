// Punch v3 preset data + schema validation. Pure (Tone-free).
// Spec: project-notes/oyster/po20/2026-06-08-punch-modular-v3-spec.md
// Repo defaults are immutable seed data; localStorage 'gb-punch-presets'
// overrides are merged (and validated) in ui/app.js. Editor UI = v3.5.
import { MODULE_PARAMS } from './punch.js';

const UNITS = ['steps', 'beats', 'bars'];
const LANE_TYPES = ['drums', 'bass', 'chords', 'melody'];
const QUANTIZE = ['immediate', 'bar', 'pattern'];

function validDuration(d) {
  return d == null || (UNITS.includes(d.unit) && typeof d.value === 'number' && isFinite(d.value) && d.value >= 0);
}

const GATE_DIVISIONS = ['1/4', '1/8', '1/16', '1/32'];

export function validatePreset(p) {
  if (!p || typeof p.name !== 'string' || typeof p.key !== 'string') return false;
  if (!QUANTIZE.includes(p.engageQuantize) || !QUANTIZE.includes(p.releaseQuantize)) return false;
  if (!Array.isArray(p.automations)) return false;
  if (p.lanes != null && (!Array.isArray(p.lanes) || !p.lanes.every(l => LANE_TYPES.includes(l)))) return false;
  if (p.amount != null && !(Number.isFinite(p.amount) && p.amount >= 0 && p.amount <= 1)) return false;
  for (const a of p.automations) {
    const id = `${a.module}.${a.param}`;
    const reg = MODULE_PARAMS[id];
    if (!reg) return false;
    // Numeric sanity — overrides are user-supplied (localStorage), so this is
    // the safety boundary between "valid JSON" and a NaN'd audio graph.
    if (a.from !== 'neutral' && a.from != null && !Number.isFinite(a.from)) return false;
    if (!Number.isFinite(a.to)) return false;
    if (a.scale && a.scale !== 'linear' && a.scale !== 'log') return false;
    // Log-space interpolation needs strictly positive endpoints.
    const scale = a.scale || reg.scale;
    const from = (a.from === 'neutral' || a.from == null) ? reg.neutral : a.from;
    if (scale === 'log' && (from <= 0 || a.to <= 0)) return false;
    // Registry ranges are the safety boundary (e.g. delay feedback runaway).
    // `from` matters as much as `to`: release ramps BACK to from, so an
    // out-of-range from would park the param outside bounds permanently.
    if (reg.min != null && (a.to < reg.min || from < reg.min)) return false;
    if (reg.max != null && (a.to > reg.max || from > reg.max)) return false;
    if (id === 'gate.depth' && a.division != null && !GATE_DIVISIONS.includes(a.division)) return false;
    if (!validDuration(a.engage?.ramp) || !validDuration(a.release?.ramp)) return false;
  }
  return true;
}

// v2 parity mapping (120bpm reference): 0.05s≈steps:0.5, 0.15s≈steps:1,
// throw release 1.5s≈beats:3, stop slump 0.8s≈beats:1.5. CRUSH 0.9 = the
// dogfood-approved level. These are seed data — never mutated in place.
export const DEFAULT_PRESETS = [
  { name: 'STUTTER', key: '1', engageQuantize: 'immediate', releaseQuantize: 'immediate',
    lanes: ['drums', 'bass'],   // chop the rhythm section; pads/melody ride on top
    automations: [
      { module: 'gate', param: 'depth', from: 'neutral', to: 1, division: '1/8',
        engage: { ramp: { unit: 'steps', value: 0 } }, release: { ramp: { unit: 'steps', value: 0.1 } } },
    ] },
  { name: 'CRUSH', key: '2', engageQuantize: 'immediate', releaseQuantize: 'immediate',
    automations: [
      { module: 'crusher', param: 'wet', from: 'neutral', to: 0.9,
        engage: { ramp: { unit: 'steps', value: 0.5 } }, release: { ramp: { unit: 'steps', value: 0.5 } } },
    ] },
  { name: 'DIVE', key: '3', engageQuantize: 'immediate', releaseQuantize: 'immediate',
    automations: [
      { module: 'filter', param: 'freq', from: 'neutral', to: 150,
        engage: { ramp: { unit: 'steps', value: 1 } }, release: { ramp: { unit: 'steps', value: 1 } } },
      { module: 'filter', param: 'Q', from: 'neutral', to: 8,
        engage: { ramp: { unit: 'steps', value: 1 } }, release: { ramp: { unit: 'steps', value: 1 } } },
    ] },
  { name: 'THROW', key: '4', engageQuantize: 'immediate', releaseQuantize: 'immediate',
    automations: [
      { module: 'delay', param: 'wet', from: 'neutral', to: 0.6,
        engage: { ramp: { unit: 'steps', value: 0.5 } }, release: { ramp: { unit: 'beats', value: 3 } } },
    ] },
  { name: 'STOP', key: '5', engageQuantize: 'immediate', releaseQuantize: 'immediate',
    automations: [
      // Semantic module (spec decision 6): the engine implements tapeStop
      // internally (gate fade + tape slump + on-grid return). Engage ramp =
      // slump duration; release handling is internal to the module.
      { module: 'transport', param: 'tapeStop', from: 'neutral', to: 1,
        engage: { ramp: { unit: 'beats', value: 1.5 } }, release: { ramp: { unit: 'steps', value: 0 } } },
    ] },
];
