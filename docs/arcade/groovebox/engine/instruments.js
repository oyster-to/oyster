// engine/instruments.js — the instruments layer (v1, synth only).
//
// Entities (spec: project-notes po20/2026-06-07-instruments-layer-spec.md):
//   Instrument — atomic patch: { name, type, engine:'synth', patch }
//   Kit        — GM-note drum rack: { name, slots: [{ note, label, instrument }] }
//
// Identity vs syntax: GM note NUMBERS are canonical (engine, storage, registry);
// GM NAMES are first-class input syntax, normalized here at the one boundary
// (like CSS #fff/#ffffff). UI shows kit-slot labels, never numbers.
//
// `engine: 'synth'` reserves the v2 seam: a sample instrument is the same
// wrapper with engine:'sample' and an SFZ-shaped sample block instead of patch.

// ── GM drum map: input aliases (name → canonical note) ──────────────────────
export const GM = {
  kick: 36, kick2: 35, sidestick: 37, snare: 38, clap: 39, snare2: 40,
  tomlow2: 41, hat: 42, tomlow: 43, pedalhat: 44, tom: 45, openhat: 46,
  tommid: 47, tomhi2: 48, crash: 49, tomhi: 50, ride: 51, china: 52,
  ridebell: 53, tambourine: 54, splash: 55, cowbell: 56, crash2: 57,
  shaker: 70,
};
const GM_NAME_BY_NOTE = Object.fromEntries(Object.entries(GM).map(([n, v]) => [v, n]));

/** slotKey(k) → canonical GM note number, or null if unrecognisable.
 *  Accepts 36, '36', 'kick' (case-insensitive). */
export function slotKey(k) {
  if (typeof k === 'number') return Number.isInteger(k) && k >= 0 && k <= 127 ? k : null;
  if (typeof k !== 'string') return null;
  const name = k.toLowerCase().trim();
  if (name in GM) return GM[name];
  const n = Number(name);
  return Number.isInteger(n) && n >= 0 && n <= 127 ? n : null;
}

/** gmName(note) → alias name for a GM note ('kick'), or null. */
export function gmName(note) { return GM_NAME_BY_NOTE[note] ?? null; }

// ── neutral patch vocabulary ─────────────────────────────────────────────────
// Versioned and deliberately small: exactly what today's eight voices need.
// scale: 'linear' | 'log'. Compiled to Tone by ONE adapter (voices.js).
export const PATCH_SCHEMA_VERSION = 2;   // v2 adds filter.Q (resonance) + vibrato

export const ARCHETYPES = ['membrane', 'noise', 'mono', 'poly'];
export const OSC_SHAPES = ['pulse', 'square', 'sawtooth', 'fatsawtooth', 'triangle', 'sine'];
export const FILTER_TYPES = ['lowpass', 'highpass'];

export const PATCH_PARAMS = {
  'volume':                  { min: -40,   max: 6,     scale: 'linear' },  // dB
  'envelope.attack':         { min: 0.001, max: 4,     scale: 'log' },
  'envelope.decay':          { min: 0.01,  max: 4,     scale: 'log' },
  'envelope.sustain':        { min: 0,     max: 1,     scale: 'linear' },
  'envelope.release':        { min: 0.01,  max: 8,     scale: 'log' },
  'oscillator.width':        { min: 0.05,  max: 0.95,  scale: 'linear' },  // pulse only
  'filter.freq':             { min: 40,    max: 20000, scale: 'log' },
  'filter.Q':                { min: 0,     max: 20,    scale: 'linear' },  // resonance; ~self-oscillates near max
  'vibrato.rate':            { min: 0.1,   max: 12,    scale: 'log' },     // Hz — pitch LFO speed
  'vibrato.depth':           { min: 0,     max: 1,     scale: 'linear' },
  'filterEnvelope.attack':   { min: 0.001, max: 4,     scale: 'log' },
  'filterEnvelope.decay':    { min: 0.01,  max: 4,     scale: 'log' },
  'filterEnvelope.sustain':  { min: 0,     max: 1,     scale: 'linear' },
  'filterEnvelope.baseFrequency': { min: 20, max: 10000, scale: 'log' },
  'filterEnvelope.octaves':  { min: 0,     max: 8,     scale: 'linear' },
  'pitch.pitchDecay':        { min: 0.001, max: 0.5,   scale: 'log' },     // membrane only
  'pitch.octaves':           { min: 0.5,   max: 8,     scale: 'linear' },  // membrane only
  'trigger.velocity':        { min: 0,     max: 1,     scale: 'linear' },
};

const INSTRUMENT_TYPES = ['drum', 'bass', 'chords', 'melody'];

function num(v) { return typeof v === 'number' && Number.isFinite(v); }
function inRange(id, v) {
  const p = PATCH_PARAMS[id];
  return !!p && num(v) && v >= p.min && v <= p.max;
}
function get(obj, path) { return path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj); }

/** validateInstrument(inst) → boolean. Bad data must never crash the engine —
 *  callers fall back to defaults on false. */
export function validateInstrument(inst) {
  if (!inst || typeof inst !== 'object') return false;
  if (typeof inst.name !== 'string' || !inst.name.length || inst.name.length > 24) return false;
  if (!INSTRUMENT_TYPES.includes(inst.type)) return false;
  if (inst.engine !== 'synth') return false;          // v1: synth only ('sample' is the v2 seam)
  const p = inst.patch;
  if (!p || typeof p !== 'object') return false;
  if (!ARCHETYPES.includes(p.archetype)) return false;
  // Every present numeric param must be in range (absent = adapter default).
  for (const id of Object.keys(PATCH_PARAMS)) {
    const v = get(p, id);
    if (v !== undefined && !inRange(id, v)) return false;
  }
  if (p.oscillator?.shape !== undefined && !OSC_SHAPES.includes(p.oscillator.shape)) return false;
  if (p.filter !== undefined) {
    if (!FILTER_TYPES.includes(p.filter.type)) return false;
    if (!inRange('filter.freq', p.filter.freq)) return false;
  }
  // vibrato is an optional object; its rate/depth ranges are checked by the loop
  // above, but a non-object (e.g. a stray scalar) must be rejected outright.
  if (p.vibrato !== undefined &&
      (typeof p.vibrato !== 'object' || p.vibrato === null || Array.isArray(p.vibrato))) return false;
  if (p.trigger !== undefined) {
    if (p.trigger.note !== undefined && typeof p.trigger.note !== 'string') return false;
    if (p.trigger.dur !== undefined && typeof p.trigger.dur !== 'string') return false;
    if (p.trigger.velocity !== undefined && !inRange('trigger.velocity', p.trigger.velocity)) return false;
  }
  return true;
}

/** validateKit(kit, instruments) → boolean. Slots must resolve: GM-valid notes,
 *  unique, each referencing a known drum instrument. */
export function validateKit(kit, instruments) {
  if (!kit || typeof kit !== 'object') return false;
  if (typeof kit.name !== 'string' || !kit.name.length || kit.name.length > 24) return false;
  if (!Array.isArray(kit.slots) || !kit.slots.length || kit.slots.length > 16) return false;
  const notes = new Set();
  for (const s of kit.slots) {
    const note = slotKey(s?.note);
    if (note === null || notes.has(note)) return false;
    notes.add(note);
    if (typeof s.label !== 'string' || !s.label.length || s.label.length > 12) return false;
    const inst = instruments?.[s.instrument];
    if (!inst || inst.type !== 'drum' || !validateInstrument(inst)) return false;
  }
  return true;
}

// ── groove normalization (the input boundary) ────────────────────────────────
/** normalizeDrumBar(bar) → same bar shape with canonical numeric keys.
 *  Unrecognisable keys are DROPPED (bad data never crashes the engine).
 *  Values are sanitized: arrays only; elements must be a finite step number
 *  or a [step, semi] pair — anything else is dropped. */
export function normalizeDrumBar(bar) {
  if (!bar || typeof bar !== 'object' || Array.isArray(bar)) return {};
  const out = {};
  for (const [k, v] of Object.entries(bar)) {
    const note = slotKey(k);
    if (note === null || !Array.isArray(v)) continue;   // values must be arrays
    const steps = v.filter(s =>
      (typeof s === 'number' && Number.isFinite(s)) ||
      (Array.isArray(s) && typeof s[0] === 'number' && Number.isFinite(s[0])));
    out[note] = steps;
  }
  return out;
}

/** normalizeDrumGrooves(grooves) → new grooves object with every drum bar
 *  normalized. `grooves` is one lane's { name → bar[] } table. */
export function normalizeDrumGrooves(grooves) {
  const out = {};
  for (const [name, bars] of Object.entries(grooves || {})) {
    out[name] = Array.isArray(bars) ? bars.map(normalizeDrumBar) : bars;
  }
  return out;
}

/** normalizeVoiceMap(map) → { [gmNote]: bool } — voiceMute/voiceSolo keys. */
export function normalizeVoiceMap(map) {
  if (!map || typeof map !== 'object') return map;
  const out = {};
  for (const [k, v] of Object.entries(map)) {
    const note = slotKey(k);
    if (note !== null) out[note] = v;
  }
  return out;
}

/** normalizeSongDrums(song) — the ingest boundary, in place: every drum lane's
 *  grooves, fills, and per-voice mute/solo state goes canonical numeric.
 *  Input syntax (GM names) is welcome anywhere upstream of this call. */
export function normalizeSongDrums(song) {
  if (!song || typeof song !== 'object') return song;
  for (const lane of song.lanes || []) {
    if (lane.type !== 'drums') continue;
    if (song.grooves?.[lane.id]) song.grooves[lane.id] = normalizeDrumGrooves(song.grooves[lane.id]);
    if (lane.voiceMute) lane.voiceMute = normalizeVoiceMap(lane.voiceMute);
    if (lane.voiceSolo) lane.voiceSolo = normalizeVoiceMap(lane.voiceSolo);
  }
  if (song.fills && typeof song.fills === 'object') {
    for (const [name, bar] of Object.entries(song.fills)) song.fills[name] = normalizeDrumBar(bar);
  }
  return song;
}

// ── defaults: today's hardcoded voices, ported byte-for-byte ────────────────
// Values mirror engine/voices.js createVoiceForType EXACTLY (parity-tested).
export const DEFAULT_INSTRUMENTS = {
  'gb-kick': {
    name: 'Oyster Kick', type: 'drum', engine: 'synth',
    patch: { archetype: 'membrane', volume: -5, trigger: { note: 'C1', dur: '8n' } },
  },
  'gb-snare': {
    name: 'Oyster Snare', type: 'drum', engine: 'synth',
    patch: { archetype: 'noise', volume: -11,
      envelope: { attack: 0.001, decay: 0.16, sustain: 0 },
      trigger: { dur: '16n' } },
  },
  'gb-hat': {
    name: 'Oyster Hat', type: 'drum', engine: 'synth',
    patch: { archetype: 'noise', volume: -20,
      envelope: { attack: 0.001, decay: 0.03, sustain: 0 },
      filter: { type: 'highpass', freq: 7000 },
      trigger: { dur: '32n', velocity: 0.6 } },
  },
  'gb-tom': {
    name: 'Oyster Tom', type: 'drum', engine: 'synth',
    patch: { archetype: 'membrane', volume: -6,
      pitch: { pitchDecay: 0.06, octaves: 2 },
      trigger: { note: 'A2', dur: '8n' } },
  },
  'gb-crash': {
    name: 'Oyster Crash', type: 'drum', engine: 'synth',
    patch: { archetype: 'noise', volume: -12,
      envelope: { attack: 0.001, decay: 1.1, sustain: 0, release: 0.3 },
      filter: { type: 'highpass', freq: 3500 },
      trigger: { dur: '8n', velocity: 0.8 } },
  },
  'gb-clap': {
    name: 'Oyster Clap', type: 'drum', engine: 'synth',
    patch: { archetype: 'noise', volume: -11,
      envelope: { attack: 0.001, decay: 0.15, sustain: 0 },
      filter: { type: 'highpass', freq: 1200 },
      trigger: { dur: '16n', velocity: 0.8 } },
  },
  'gb-openhat': {
    name: 'Oyster Open Hat', type: 'drum', engine: 'synth',
    patch: { archetype: 'noise', volume: -19,
      envelope: { attack: 0.001, decay: 0.35, sustain: 0 },
      filter: { type: 'highpass', freq: 7000 },
      trigger: { dur: '8n', velocity: 0.6 } },
  },
  'gb-ride': {
    name: 'Oyster Ride', type: 'drum', engine: 'synth',
    patch: { archetype: 'noise', volume: -20,
      envelope: { attack: 0.001, decay: 0.6, sustain: 0 },
      filter: { type: 'highpass', freq: 6000 },
      trigger: { dur: '4n', velocity: 0.5 } },
  },
  'gb-bass': {
    name: 'Oyster Bass', type: 'bass', engine: 'synth',
    patch: { archetype: 'mono', volume: -7,
      oscillator: { shape: 'triangle' },
      envelope: { attack: 0.005, decay: 0.18, sustain: 0.35, release: 0.18 },
      filterEnvelope: { attack: 0.005, decay: 0.12, sustain: 0.4, baseFrequency: 120, octaves: 3 },
      trigger: { velocity: 0.85 } },
  },
  'gb-chords': {
    name: 'Oyster Chords', type: 'chords', engine: 'synth',
    patch: { archetype: 'poly', volume: -17,
      oscillator: { shape: 'triangle' },
      envelope: { attack: 0.05, decay: 0.3, sustain: 0.6, release: 0.5 },
      filter: { type: 'lowpass', freq: 4200 },
      trigger: { velocity: 0.3 } },
  },
  'gb-lead': {
    name: 'Oyster Lead', type: 'melody', engine: 'synth',
    patch: { archetype: 'poly', volume: -11,
      oscillator: { shape: 'pulse', width: 0.3 },
      envelope: { attack: 0.004, decay: 0.18, sustain: 0.2, release: 0.2 },
      trigger: { velocity: 0.82 } },
  },
};

// The canonical 8-slot layout: every kit fills these GM notes. The drum editor
// derives its rows from this (viz.js DROWS), so slot order = row order.
export const DEFAULT_KIT = {
  name: 'Oyster Kit',
  slots: [
    { note: 36, label: 'Kick',  instrument: 'gb-kick' },
    { note: 38, label: 'Snare', instrument: 'gb-snare' },
    { note: 39, label: 'Clap',  instrument: 'gb-clap' },
    { note: 42, label: 'HH',    instrument: 'gb-hat' },
    { note: 46, label: 'OH',    instrument: 'gb-openhat' },
    { note: 45, label: 'Tom',   instrument: 'gb-tom', pitched: true },   // steps carry [step, semi]
    { note: 49, label: 'Crash', instrument: 'gb-crash' },
    { note: 51, label: 'Ride',  instrument: 'gb-ride' },
  ],
};

// ─── Synth preset banks (Slice 1) ─────────────────────────────────────────────
// Read-only starting points per pitched lane type. Same patch schema as
// DEFAULT_INSTRUMENTS; all values stay inside PATCH_PARAMS so validateInstrument
// passes. STARTER values — ear-test gated; tune freely. The strip dropdown lists
// these + the gb-* defaults (by type); EDIT forks to a song-local Custom patch.
export const SYNTH_PRESETS = {
  // Bass (mono)
  'preset-sub-bass': {
    name: 'Sub Bass', type: 'bass', engine: 'synth',
    patch: { archetype: 'mono', volume: -6,
      oscillator: { shape: 'sine' },
      envelope: { attack: 0.008, decay: 0.2, sustain: 0.7, release: 0.25 },
      filterEnvelope: { attack: 0.005, decay: 0.15, sustain: 0.5, baseFrequency: 60, octaves: 2 },
      trigger: { velocity: 0.9 } },
  },
  'preset-reese': {
    name: 'Reese', type: 'bass', engine: 'synth',
    patch: { archetype: 'mono', volume: -8,
      oscillator: { shape: 'sawtooth' },
      envelope: { attack: 0.005, decay: 0.25, sustain: 0.6, release: 0.2 },
      filterEnvelope: { attack: 0.005, decay: 0.3, sustain: 0.4, baseFrequency: 180, octaves: 4.5 },
      trigger: { velocity: 0.85 } },
  },
  'preset-pluck-bass': {
    name: 'Pluck Bass', type: 'bass', engine: 'synth',
    patch: { archetype: 'mono', volume: -7,
      oscillator: { shape: 'square' },
      envelope: { attack: 0.003, decay: 0.09, sustain: 0.05, release: 0.1 },
      filterEnvelope: { attack: 0.003, decay: 0.08, sustain: 0.2, baseFrequency: 400, octaves: 3 },
      trigger: { velocity: 0.85 } },
  },
  'preset-moog-bass': {
    name: 'Moog', type: 'bass', engine: 'synth',
    patch: { archetype: 'mono', volume: -7,
      oscillator: { shape: 'sawtooth' },
      envelope: { attack: 0.01, decay: 0.35, sustain: 0.5, release: 0.25 },
      filterEnvelope: { attack: 0.008, decay: 0.3, sustain: 0.45, baseFrequency: 300, octaves: 3.5 },
      trigger: { velocity: 0.85 } },
  },
  // Chords (poly)
  'preset-poly-pad': {
    name: 'Poly Pad', type: 'chords', engine: 'synth',
    patch: { archetype: 'poly', volume: -16,
      oscillator: { shape: 'triangle' },
      envelope: { attack: 0.08, decay: 0.4, sustain: 0.7, release: 0.8 },
      filter: { type: 'lowpass', freq: 2000 },
      trigger: { velocity: 0.3 } },
  },
  'preset-stab': {
    name: 'Stab', type: 'chords', engine: 'synth',
    patch: { archetype: 'poly', volume: -16,
      oscillator: { shape: 'sawtooth' },
      envelope: { attack: 0.005, decay: 0.12, sustain: 0, release: 0.15 },
      filter: { type: 'lowpass', freq: 5000 },
      trigger: { velocity: 0.35 } },
  },
  'preset-organ': {
    name: 'Organ', type: 'chords', engine: 'synth',
    patch: { archetype: 'poly', volume: -18,
      oscillator: { shape: 'square' },
      envelope: { attack: 0.005, decay: 0.1, sustain: 1, release: 0.2 },
      filter: { type: 'lowpass', freq: 6000 },
      trigger: { velocity: 0.3 } },
  },
  'preset-glass': {
    name: 'Glass', type: 'chords', engine: 'synth',
    patch: { archetype: 'poly', volume: -16,
      oscillator: { shape: 'sine' },
      envelope: { attack: 0.06, decay: 0.3, sustain: 0.25, release: 0.5 },
      filter: { type: 'lowpass', freq: 8000 },
      trigger: { velocity: 0.3 } },
  },
  // Melody (poly)
  'preset-square-lead': {
    name: 'Square Lead', type: 'melody', engine: 'synth',
    patch: { archetype: 'poly', volume: -11,
      oscillator: { shape: 'square' },
      envelope: { attack: 0.004, decay: 0.16, sustain: 0.25, release: 0.18 },
      trigger: { velocity: 0.82 } },
  },
  'preset-saw-lead': {
    name: 'Saw Lead', type: 'melody', engine: 'synth',
    patch: { archetype: 'poly', volume: -12,
      oscillator: { shape: 'sawtooth' },
      envelope: { attack: 0.004, decay: 0.2, sustain: 0.3, release: 0.2 },
      trigger: { velocity: 0.82 } },
  },
  'preset-soft-pad': {
    name: 'Soft Pad', type: 'melody', engine: 'synth',
    patch: { archetype: 'poly', volume: -12,
      oscillator: { shape: 'triangle' },
      envelope: { attack: 0.07, decay: 0.4, sustain: 0.65, release: 0.5 },
      trigger: { velocity: 0.75 } },
  },
  'preset-pluck-lead': {
    name: 'Pluck Lead', type: 'melody', engine: 'synth',
    patch: { archetype: 'poly', volume: -11,
      oscillator: { shape: 'pulse', width: 0.25 },
      envelope: { attack: 0.004, decay: 0.08, sustain: 0, release: 0.12 },
      trigger: { velocity: 0.82 } },
  },
  'preset-fat-saw': {
    name: 'Fat Saw', type: 'melody', engine: 'synth',
    patch: { archetype: 'poly', volume: -12,
      oscillator: { shape: 'fatsawtooth' },
      envelope: { attack: 0.006, decay: 0.22, sustain: 0.35, release: 0.2 },
      trigger: { velocity: 0.82 } },
  },
  'preset-reso-saw': {
    // Quacky resonant saw lead (the MGMT "Kids" topline character): one bright
    // detuned saw → resonant lowpass in the upper-mids (the nasal "quack") →
    // wide ~4 Hz pitch vibrato (the wobble). fatsawtooth's unison detune stands
    // in for the record's chorus/ensemble.
    name: 'Reso Saw', type: 'melody', engine: 'synth',
    patch: { archetype: 'poly', volume: -11,
      oscillator: { shape: 'fatsawtooth' },
      envelope: { attack: 0.004, decay: 0.2, sustain: 0.55, release: 0.25 },
      filter: { type: 'lowpass', freq: 1300, Q: 11 },
      vibrato: { rate: 4.2, depth: 0.18 },
      trigger: { velocity: 0.85 } },
  },
  'preset-triangle-lead': {
    name: 'Triangle Lead', type: 'melody', engine: 'synth',
    patch: { archetype: 'poly', volume: -11,
      oscillator: { shape: 'triangle' },
      envelope: { attack: 0.004, decay: 0.18, sustain: 0.2, release: 0.2 },
      trigger: { velocity: 0.82 } },
  },
  'preset-sine-lead': {
    name: 'Sine Lead', type: 'melody', engine: 'synth',
    patch: { archetype: 'poly', volume: -10,
      oscillator: { shape: 'sine' },
      envelope: { attack: 0.004, decay: 0.18, sustain: 0.2, release: 0.2 },
      trigger: { velocity: 0.82 } },
  },
};

// One-time migration: the retired per-lane `tone` (oscillator override on the
// default lead) maps to the matching melody preset. Used at the load boundary
// to upgrade old/shared songs; nothing downstream reads `tone`.
export const LEGACY_TONE_PRESET = {
  pulse: 'gb-lead',
  square: 'preset-square-lead',
  sawtooth: 'preset-saw-lead',
  fatsawtooth: 'preset-fat-saw',
  triangle: 'preset-triangle-lead',
  sine: 'preset-sine-lead',
};

// ─── Drum instrument presets (Slice 2) ────────────────────────────────────────
// type:'drum' patches the kits below assemble. Kicks/toms = membrane (shaped via
// pitch + trigger.dur + filter; no envelope). Snares/hats/crashes = noise (shaped
// via envelope + filter). STARTER values — ear-test gated.
export const DRUM_PRESETS = {
  // 808 — deep sub kick, snappy snare, tight hats
  'drum-808-kick':  { name: '808 Kick',  type: 'drum', engine: 'synth',
    patch: { archetype: 'membrane', volume: -3, pitch: { pitchDecay: 0.45, octaves: 6 }, trigger: { note: 'C1', dur: '2n', velocity: 1 } } },
  'drum-808-snare': { name: '808 Snare', type: 'drum', engine: 'synth',
    patch: { archetype: 'noise', volume: -10, envelope: { attack: 0.001, decay: 0.2, sustain: 0 }, filter: { type: 'highpass', freq: 1400 }, trigger: { dur: '16n', velocity: 0.9 } } },
  'drum-808-hat':   { name: '808 Hat',   type: 'drum', engine: 'synth',
    patch: { archetype: 'noise', volume: -18, envelope: { attack: 0.001, decay: 0.04, sustain: 0 }, filter: { type: 'highpass', freq: 9000 }, trigger: { dur: '32n', velocity: 0.6 } } },
  // 909 — punchy kick, noisy snare, sizzly hats
  'drum-909-kick':  { name: '909 Kick',  type: 'drum', engine: 'synth',
    patch: { archetype: 'membrane', volume: -4, pitch: { pitchDecay: 0.06, octaves: 4 }, trigger: { note: 'C1', dur: '8n', velocity: 1 } } },
  'drum-909-snare': { name: '909 Snare', type: 'drum', engine: 'synth',
    patch: { archetype: 'noise', volume: -10, envelope: { attack: 0.001, decay: 0.18, sustain: 0 }, filter: { type: 'highpass', freq: 1800 }, trigger: { dur: '16n', velocity: 0.9 } } },
  'drum-909-hat':   { name: '909 Hat',   type: 'drum', engine: 'synth',
    patch: { archetype: 'noise', volume: -17, envelope: { attack: 0.001, decay: 0.05, sustain: 0 }, filter: { type: 'highpass', freq: 8000 }, trigger: { dur: '32n', velocity: 0.65 } } },
  // Acoustic — natural thud, fuller snare
  'drum-acoustic-kick':  { name: 'Acoustic Kick',  type: 'drum', engine: 'synth',
    patch: { archetype: 'membrane', volume: -5, pitch: { pitchDecay: 0.03, octaves: 3 }, trigger: { note: 'C1', dur: '8n', velocity: 0.9 } } },
  'drum-acoustic-snare': { name: 'Acoustic Snare', type: 'drum', engine: 'synth',
    patch: { archetype: 'noise', volume: -9, envelope: { attack: 0.001, decay: 0.22, sustain: 0 }, filter: { type: 'highpass', freq: 1100 }, trigger: { dur: '8n', velocity: 0.85 } } },
  'drum-acoustic-hat':   { name: 'Acoustic Hat',   type: 'drum', engine: 'synth',
    patch: { archetype: 'noise', volume: -19, envelope: { attack: 0.001, decay: 0.05, sustain: 0 }, filter: { type: 'highpass', freq: 7500 }, trigger: { dur: '32n', velocity: 0.55 } } },
  // Lo-Fi — soft warm kick (low-passed), dusty snare, muffled hat
  'drum-lofi-kick':  { name: 'Lo-Fi Kick',  type: 'drum', engine: 'synth',
    patch: { archetype: 'membrane', volume: -6, pitch: { pitchDecay: 0.05, octaves: 2.5 }, filter: { type: 'lowpass', freq: 2200 }, trigger: { note: 'C1', dur: '8n', velocity: 0.8 } } },
  'drum-lofi-snare': { name: 'Lo-Fi Snare', type: 'drum', engine: 'synth',
    patch: { archetype: 'noise', volume: -12, envelope: { attack: 0.002, decay: 0.25, sustain: 0 }, filter: { type: 'highpass', freq: 700 }, trigger: { dur: '8n', velocity: 0.7 } } },
  'drum-lofi-hat':   { name: 'Lo-Fi Hat',   type: 'drum', engine: 'synth',
    patch: { archetype: 'noise', volume: -22, envelope: { attack: 0.001, decay: 0.06, sustain: 0 }, filter: { type: 'highpass', freq: 5000 }, trigger: { dur: '32n', velocity: 0.5 } } },
  // Boom Bap — punchy mid kick, fat cracky snare, dark short hats
  'drum-boombap-kick':  { name: 'Boom Bap Kick',  type: 'drum', engine: 'synth',
    patch: { archetype: 'membrane', volume: -4, pitch: { pitchDecay: 0.04, octaves: 2 }, filter: { type: 'lowpass', freq: 4000 }, trigger: { note: 'C1', dur: '8n', velocity: 0.95 } } },
  'drum-boombap-snare': { name: 'Boom Bap Snare', type: 'drum', engine: 'synth',
    patch: { archetype: 'noise', volume: -8, envelope: { attack: 0.001, decay: 0.3, sustain: 0 }, filter: { type: 'highpass', freq: 900 }, trigger: { dur: '8n', velocity: 0.95 } } },
  'drum-boombap-hat':   { name: 'Boom Bap Hat',   type: 'drum', engine: 'synth',
    patch: { archetype: 'noise', volume: -20, envelope: { attack: 0.001, decay: 0.035, sustain: 0 }, filter: { type: 'highpass', freq: 6500 }, trigger: { dur: '32n', velocity: 0.55 } } },
  // Techno — hard clicky kick, bright snare, OPEN sizzly hats
  'drum-techno-kick':  { name: 'Techno Kick',  type: 'drum', engine: 'synth',
    patch: { archetype: 'membrane', volume: -3, pitch: { pitchDecay: 0.025, octaves: 3.5 }, trigger: { note: 'C1', dur: '8n', velocity: 1 } } },
  'drum-techno-snare': { name: 'Techno Snare', type: 'drum', engine: 'synth',
    patch: { archetype: 'noise', volume: -9, envelope: { attack: 0.001, decay: 0.16, sustain: 0 }, filter: { type: 'highpass', freq: 2600 }, trigger: { dur: '16n', velocity: 0.95 } } },
  'drum-techno-hat':   { name: 'Techno Hat',   type: 'drum', engine: 'synth',
    patch: { archetype: 'noise', volume: -16, envelope: { attack: 0.001, decay: 0.12, sustain: 0 }, filter: { type: 'highpass', freq: 8500 }, trigger: { dur: '16n', velocity: 0.7 } } },
  // Electro — ultra-short zappy everything
  'drum-electro-kick':  { name: 'Electro Kick',  type: 'drum', engine: 'synth',
    patch: { archetype: 'membrane', volume: -4, pitch: { pitchDecay: 0.015, octaves: 5 }, trigger: { note: 'C1', dur: '16n', velocity: 1 } } },
  'drum-electro-snare': { name: 'Electro Snare', type: 'drum', engine: 'synth',
    patch: { archetype: 'noise', volume: -11, envelope: { attack: 0.001, decay: 0.08, sustain: 0 }, filter: { type: 'highpass', freq: 3500 }, trigger: { dur: '32n', velocity: 0.9 } } },
  'drum-electro-hat':   { name: 'Electro Hat',   type: 'drum', engine: 'synth',
    patch: { archetype: 'noise', volume: -19, envelope: { attack: 0.001, decay: 0.025, sustain: 0 }, filter: { type: 'highpass', freq: 10000 }, trigger: { dur: '32n', velocity: 0.55 } } },
  // Brush — soft low kick, long swept warm snare, brushy hats
  'drum-brush-kick':  { name: 'Brush Kick',  type: 'drum', engine: 'synth',
    patch: { archetype: 'membrane', volume: -7, pitch: { pitchDecay: 0.04, octaves: 2 }, filter: { type: 'lowpass', freq: 1800 }, trigger: { note: 'C1', dur: '8n', velocity: 0.75 } } },
  'drum-brush-snare': { name: 'Brush Snare', type: 'drum', engine: 'synth',
    patch: { archetype: 'noise', volume: -13, envelope: { attack: 0.003, decay: 0.35, sustain: 0 }, filter: { type: 'highpass', freq: 500 }, trigger: { dur: '4n', velocity: 0.6 } } },
  'drum-brush-hat':   { name: 'Brush Hat',   type: 'drum', engine: 'synth',
    patch: { archetype: 'noise', volume: -23, envelope: { attack: 0.002, decay: 0.08, sustain: 0 }, filter: { type: 'highpass', freq: 4500 }, trigger: { dur: '16n', velocity: 0.45 } } },

  // ─ Clap · Open Hat · Tom · Crash · Ride per kit (the 8-slot completion) ─
  // 808
  'drum-808-clap':    { name: '808 Clap',    type: 'drum', engine: 'synth', patch: { archetype: 'noise', volume: -10, envelope: { attack: 0.001, decay: 0.18, sustain: 0 }, filter: { type: 'highpass', freq: 1300 }, trigger: { dur: '16n', velocity: 0.85 } } },
  'drum-808-openhat': { name: '808 Open Hat', type: 'drum', engine: 'synth', patch: { archetype: 'noise', volume: -17, envelope: { attack: 0.001, decay: 0.4, sustain: 0 }, filter: { type: 'highpass', freq: 9000 }, trigger: { dur: '8n', velocity: 0.6 } } },
  'drum-808-tom':     { name: '808 Tom',     type: 'drum', engine: 'synth', patch: { archetype: 'membrane', volume: -5, pitch: { pitchDecay: 0.3, octaves: 4 }, trigger: { note: 'A2', dur: '8n', velocity: 0.85 } } },
  'drum-808-crash':   { name: '808 Crash',   type: 'drum', engine: 'synth', patch: { archetype: 'noise', volume: -13, envelope: { attack: 0.001, decay: 1.3, sustain: 0, release: 0.3 }, filter: { type: 'highpass', freq: 4000 }, trigger: { dur: '8n', velocity: 0.7 } } },
  'drum-808-ride':    { name: '808 Ride',    type: 'drum', engine: 'synth', patch: { archetype: 'noise', volume: -19, envelope: { attack: 0.001, decay: 0.5, sustain: 0 }, filter: { type: 'highpass', freq: 8500 }, trigger: { dur: '4n', velocity: 0.5 } } },
  // 909
  'drum-909-clap':    { name: '909 Clap',    type: 'drum', engine: 'synth', patch: { archetype: 'noise', volume: -10, envelope: { attack: 0.001, decay: 0.16, sustain: 0 }, filter: { type: 'highpass', freq: 1500 }, trigger: { dur: '16n', velocity: 0.85 } } },
  'drum-909-openhat': { name: '909 Open Hat', type: 'drum', engine: 'synth', patch: { archetype: 'noise', volume: -16, envelope: { attack: 0.001, decay: 0.45, sustain: 0 }, filter: { type: 'highpass', freq: 8000 }, trigger: { dur: '8n', velocity: 0.65 } } },
  'drum-909-tom':     { name: '909 Tom',     type: 'drum', engine: 'synth', patch: { archetype: 'membrane', volume: -5, pitch: { pitchDecay: 0.08, octaves: 4 }, trigger: { note: 'A2', dur: '8n', velocity: 0.85 } } },
  'drum-909-crash':   { name: '909 Crash',   type: 'drum', engine: 'synth', patch: { archetype: 'noise', volume: -12, envelope: { attack: 0.001, decay: 1.2, sustain: 0, release: 0.3 }, filter: { type: 'highpass', freq: 3500 }, trigger: { dur: '8n', velocity: 0.75 } } },
  'drum-909-ride':    { name: '909 Ride',    type: 'drum', engine: 'synth', patch: { archetype: 'noise', volume: -18, envelope: { attack: 0.001, decay: 0.55, sustain: 0 }, filter: { type: 'highpass', freq: 8000 }, trigger: { dur: '4n', velocity: 0.55 } } },
  // Acoustic
  'drum-acoustic-clap':    { name: 'Acoustic Clap',    type: 'drum', engine: 'synth', patch: { archetype: 'noise', volume: -11, envelope: { attack: 0.002, decay: 0.2, sustain: 0 }, filter: { type: 'highpass', freq: 1000 }, trigger: { dur: '8n', velocity: 0.8 } } },
  'drum-acoustic-openhat': { name: 'Acoustic Open Hat', type: 'drum', engine: 'synth', patch: { archetype: 'noise', volume: -18, envelope: { attack: 0.001, decay: 0.4, sustain: 0 }, filter: { type: 'highpass', freq: 7500 }, trigger: { dur: '8n', velocity: 0.55 } } },
  'drum-acoustic-tom':     { name: 'Acoustic Tom',     type: 'drum', engine: 'synth', patch: { archetype: 'membrane', volume: -6, pitch: { pitchDecay: 0.04, octaves: 3 }, trigger: { note: 'A2', dur: '8n', velocity: 0.85 } } },
  'drum-acoustic-crash':   { name: 'Acoustic Crash',   type: 'drum', engine: 'synth', patch: { archetype: 'noise', volume: -12, envelope: { attack: 0.001, decay: 1.4, sustain: 0, release: 0.4 }, filter: { type: 'highpass', freq: 3500 }, trigger: { dur: '8n', velocity: 0.8 } } },
  'drum-acoustic-ride':    { name: 'Acoustic Ride',    type: 'drum', engine: 'synth', patch: { archetype: 'noise', volume: -19, envelope: { attack: 0.001, decay: 0.6, sustain: 0 }, filter: { type: 'highpass', freq: 7000 }, trigger: { dur: '4n', velocity: 0.5 } } },
  // Lo-Fi
  'drum-lofi-clap':    { name: 'Lo-Fi Clap',    type: 'drum', engine: 'synth', patch: { archetype: 'noise', volume: -13, envelope: { attack: 0.003, decay: 0.2, sustain: 0 }, filter: { type: 'highpass', freq: 700 }, trigger: { dur: '8n', velocity: 0.65 } } },
  'drum-lofi-openhat': { name: 'Lo-Fi Open Hat', type: 'drum', engine: 'synth', patch: { archetype: 'noise', volume: -21, envelope: { attack: 0.001, decay: 0.4, sustain: 0 }, filter: { type: 'highpass', freq: 5000 }, trigger: { dur: '8n', velocity: 0.5 } } },
  'drum-lofi-tom':     { name: 'Lo-Fi Tom',     type: 'drum', engine: 'synth', patch: { archetype: 'membrane', volume: -7, pitch: { pitchDecay: 0.05, octaves: 2.5 }, filter: { type: 'lowpass', freq: 2000 }, trigger: { note: 'A2', dur: '8n', velocity: 0.8 } } },
  'drum-lofi-crash':   { name: 'Lo-Fi Crash',   type: 'drum', engine: 'synth', patch: { archetype: 'noise', volume: -15, envelope: { attack: 0.002, decay: 1.2, sustain: 0, release: 0.4 }, filter: { type: 'highpass', freq: 2500 }, trigger: { dur: '8n', velocity: 0.65 } } },
  'drum-lofi-ride':    { name: 'Lo-Fi Ride',    type: 'drum', engine: 'synth', patch: { archetype: 'noise', volume: -22, envelope: { attack: 0.001, decay: 0.5, sustain: 0 }, filter: { type: 'highpass', freq: 4500 }, trigger: { dur: '4n', velocity: 0.45 } } },
  // Boom Bap
  'drum-boombap-clap':    { name: 'Boom Bap Clap',    type: 'drum', engine: 'synth', patch: { archetype: 'noise', volume: -9, envelope: { attack: 0.001, decay: 0.22, sustain: 0 }, filter: { type: 'highpass', freq: 1000 }, trigger: { dur: '8n', velocity: 0.9 } } },
  'drum-boombap-openhat': { name: 'Boom Bap Open Hat', type: 'drum', engine: 'synth', patch: { archetype: 'noise', volume: -19, envelope: { attack: 0.001, decay: 0.3, sustain: 0 }, filter: { type: 'highpass', freq: 6500 }, trigger: { dur: '8n', velocity: 0.55 } } },
  'drum-boombap-tom':     { name: 'Boom Bap Tom',     type: 'drum', engine: 'synth', patch: { archetype: 'membrane', volume: -5, pitch: { pitchDecay: 0.04, octaves: 2.2 }, filter: { type: 'lowpass', freq: 4000 }, trigger: { note: 'A2', dur: '8n', velocity: 0.85 } } },
  'drum-boombap-crash':   { name: 'Boom Bap Crash',   type: 'drum', engine: 'synth', patch: { archetype: 'noise', volume: -13, envelope: { attack: 0.001, decay: 1.2, sustain: 0, release: 0.3 }, filter: { type: 'highpass', freq: 3000 }, trigger: { dur: '8n', velocity: 0.75 } } },
  'drum-boombap-ride':    { name: 'Boom Bap Ride',    type: 'drum', engine: 'synth', patch: { archetype: 'noise', volume: -20, envelope: { attack: 0.001, decay: 0.55, sustain: 0 }, filter: { type: 'highpass', freq: 6500 }, trigger: { dur: '4n', velocity: 0.5 } } },
  // Techno
  'drum-techno-clap':    { name: 'Techno Clap',    type: 'drum', engine: 'synth', patch: { archetype: 'noise', volume: -9, envelope: { attack: 0.001, decay: 0.14, sustain: 0 }, filter: { type: 'highpass', freq: 2000 }, trigger: { dur: '16n', velocity: 0.9 } } },
  'drum-techno-openhat': { name: 'Techno Open Hat', type: 'drum', engine: 'synth', patch: { archetype: 'noise', volume: -15, envelope: { attack: 0.001, decay: 0.5, sustain: 0 }, filter: { type: 'highpass', freq: 8500 }, trigger: { dur: '8n', velocity: 0.7 } } },
  'drum-techno-tom':     { name: 'Techno Tom',     type: 'drum', engine: 'synth', patch: { archetype: 'membrane', volume: -5, pitch: { pitchDecay: 0.03, octaves: 3.5 }, trigger: { note: 'A2', dur: '8n', velocity: 0.85 } } },
  'drum-techno-crash':   { name: 'Techno Crash',   type: 'drum', engine: 'synth', patch: { archetype: 'noise', volume: -12, envelope: { attack: 0.001, decay: 1.3, sustain: 0, release: 0.3 }, filter: { type: 'highpass', freq: 4000 }, trigger: { dur: '8n', velocity: 0.8 } } },
  'drum-techno-ride':    { name: 'Techno Ride',    type: 'drum', engine: 'synth', patch: { archetype: 'noise', volume: -17, envelope: { attack: 0.001, decay: 0.6, sustain: 0 }, filter: { type: 'highpass', freq: 9000 }, trigger: { dur: '4n', velocity: 0.6 } } },
  // Electro
  'drum-electro-clap':    { name: 'Electro Clap',    type: 'drum', engine: 'synth', patch: { archetype: 'noise', volume: -11, envelope: { attack: 0.001, decay: 0.09, sustain: 0 }, filter: { type: 'highpass', freq: 3000 }, trigger: { dur: '32n', velocity: 0.85 } } },
  'drum-electro-openhat': { name: 'Electro Open Hat', type: 'drum', engine: 'synth', patch: { archetype: 'noise', volume: -18, envelope: { attack: 0.001, decay: 0.2, sustain: 0 }, filter: { type: 'highpass', freq: 10000 }, trigger: { dur: '16n', velocity: 0.6 } } },
  'drum-electro-tom':     { name: 'Electro Tom',     type: 'drum', engine: 'synth', patch: { archetype: 'membrane', volume: -5, pitch: { pitchDecay: 0.015, octaves: 5 }, trigger: { note: 'A2', dur: '16n', velocity: 0.85 } } },
  'drum-electro-crash':   { name: 'Electro Crash',   type: 'drum', engine: 'synth', patch: { archetype: 'noise', volume: -13, envelope: { attack: 0.001, decay: 0.9, sustain: 0, release: 0.2 }, filter: { type: 'highpass', freq: 5000 }, trigger: { dur: '8n', velocity: 0.75 } } },
  'drum-electro-ride':    { name: 'Electro Ride',    type: 'drum', engine: 'synth', patch: { archetype: 'noise', volume: -19, envelope: { attack: 0.001, decay: 0.35, sustain: 0 }, filter: { type: 'highpass', freq: 10000 }, trigger: { dur: '8n', velocity: 0.5 } } },
  // Brush
  'drum-brush-clap':    { name: 'Brush Clap',    type: 'drum', engine: 'synth', patch: { archetype: 'noise', volume: -14, envelope: { attack: 0.004, decay: 0.25, sustain: 0 }, filter: { type: 'highpass', freq: 600 }, trigger: { dur: '4n', velocity: 0.55 } } },
  'drum-brush-openhat': { name: 'Brush Open Hat', type: 'drum', engine: 'synth', patch: { archetype: 'noise', volume: -22, envelope: { attack: 0.002, decay: 0.4, sustain: 0 }, filter: { type: 'highpass', freq: 4500 }, trigger: { dur: '8n', velocity: 0.45 } } },
  'drum-brush-tom':     { name: 'Brush Tom',     type: 'drum', engine: 'synth', patch: { archetype: 'membrane', volume: -8, pitch: { pitchDecay: 0.04, octaves: 2 }, filter: { type: 'lowpass', freq: 1800 }, trigger: { note: 'A2', dur: '8n', velocity: 0.7 } } },
  'drum-brush-crash':   { name: 'Brush Crash',   type: 'drum', engine: 'synth', patch: { archetype: 'noise', volume: -15, envelope: { attack: 0.003, decay: 1.4, sustain: 0, release: 0.5 }, filter: { type: 'highpass', freq: 2500 }, trigger: { dur: '8n', velocity: 0.6 } } },
  'drum-brush-ride':    { name: 'Brush Ride',    type: 'drum', engine: 'synth', patch: { archetype: 'noise', volume: -21, envelope: { attack: 0.002, decay: 0.7, sustain: 0 }, filter: { type: 'highpass', freq: 5500 }, trigger: { dur: '4n', velocity: 0.45 } } },
};

// The full selectable set: stock defaults + preset banks. Engine inits
// `_instruments` from this so every preset id resolves.
export const ALL_INSTRUMENTS = { ...DEFAULT_INSTRUMENTS, ...SYNTH_PRESETS, ...DRUM_PRESETS };

// ─── Drum kits (Slice 2) ──────────────────────────────────────────────────────
// Every kit fills the SAME 8 GM slots (36/38/39/42/46/45/49/51) so any groove
// triggers the same slots — only the per-slot instrument differs. The 8 sounds
// follow a `drum-<prefix>-<piece>` id convention, so a kit is named by its prefix.
const kit = (name, p) => ({
  name,
  slots: [
    { note: 36, label: 'Kick',  instrument: `drum-${p}-kick` },
    { note: 38, label: 'Snare', instrument: `drum-${p}-snare` },
    { note: 39, label: 'Clap',  instrument: `drum-${p}-clap` },
    { note: 42, label: 'HH',    instrument: `drum-${p}-hat` },
    { note: 46, label: 'OH',    instrument: `drum-${p}-openhat` },
    { note: 45, label: 'Tom',   instrument: `drum-${p}-tom`, pitched: true },
    { note: 49, label: 'Crash', instrument: `drum-${p}-crash` },
    { note: 51, label: 'Ride',  instrument: `drum-${p}-ride` },
  ],
});
export const DRUM_KITS = {
  'kit-808':      kit('808',      '808'),
  'kit-909':      kit('909',      '909'),
  'kit-acoustic': kit('Acoustic', 'acoustic'),
  'kit-lofi':     kit('Lo-Fi',    'lofi'),
  'kit-boombap':  kit('Boom Bap', 'boombap'),
  'kit-techno':   kit('Techno',   'techno'),
  'kit-electro':  kit('Electro',  'electro'),
  'kit-brush':    kit('Brush',    'brush'),
};
// Selectable kits: the Oyster default + the banks.
export const ALL_KITS = { 'oyster-kit': DEFAULT_KIT, ...DRUM_KITS };
