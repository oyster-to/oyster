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
export const PATCH_SCHEMA_VERSION = 1;

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
 *  Step shapes pass through untouched (numbers or [step, semi] pairs). */
export function normalizeDrumBar(bar) {
  if (!bar || typeof bar !== 'object' || Array.isArray(bar)) return {};
  const out = {};
  for (const [k, v] of Object.entries(bar)) {
    const note = slotKey(k);
    if (note !== null) out[note] = v;
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
    name: 'GB KICK', type: 'drum', engine: 'synth',
    patch: { archetype: 'membrane', volume: -5, trigger: { note: 'C1', dur: '8n' } },
  },
  'gb-snare': {
    name: 'GB SNARE', type: 'drum', engine: 'synth',
    patch: { archetype: 'noise', volume: -11,
      envelope: { attack: 0.001, decay: 0.16, sustain: 0 },
      trigger: { dur: '16n' } },
  },
  'gb-hat': {
    name: 'GB HAT', type: 'drum', engine: 'synth',
    patch: { archetype: 'noise', volume: -20,
      envelope: { attack: 0.001, decay: 0.03, sustain: 0 },
      filter: { type: 'highpass', freq: 7000 },
      trigger: { dur: '32n', velocity: 0.6 } },
  },
  'gb-tom': {
    name: 'GB TOM', type: 'drum', engine: 'synth',
    patch: { archetype: 'membrane', volume: -6,
      pitch: { pitchDecay: 0.06, octaves: 2 },
      trigger: { note: 'A2', dur: '8n' } },
  },
  'gb-crash': {
    name: 'GB CRASH', type: 'drum', engine: 'synth',
    patch: { archetype: 'noise', volume: -12,
      envelope: { attack: 0.001, decay: 1.1, sustain: 0, release: 0.3 },
      filter: { type: 'highpass', freq: 3500 },
      trigger: { dur: '8n', velocity: 0.8 } },
  },
  'gb-bass': {
    name: 'GB BASS', type: 'bass', engine: 'synth',
    patch: { archetype: 'mono', volume: -7,
      oscillator: { shape: 'triangle' },
      envelope: { attack: 0.005, decay: 0.18, sustain: 0.35, release: 0.18 },
      filterEnvelope: { attack: 0.005, decay: 0.12, sustain: 0.4, baseFrequency: 120, octaves: 3 },
      trigger: { velocity: 0.85 } },
  },
  'gb-chords': {
    name: 'GB CHORDS', type: 'chords', engine: 'synth',
    patch: { archetype: 'poly', volume: -17,
      oscillator: { shape: 'triangle' },
      envelope: { attack: 0.05, decay: 0.3, sustain: 0.6, release: 0.5 },
      filter: { type: 'lowpass', freq: 4200 },
      trigger: { velocity: 0.3 } },
  },
  'gb-lead': {
    name: 'GB LEAD', type: 'melody', engine: 'synth',
    patch: { archetype: 'poly', volume: -11,
      oscillator: { shape: 'pulse', width: 0.3 },
      envelope: { attack: 0.004, decay: 0.18, sustain: 0.2, release: 0.2 },
      trigger: { velocity: 0.82 } },
  },
};

export const DEFAULT_KIT = {
  name: 'GB KIT',
  slots: [
    { note: 36, label: 'Kick',  instrument: 'gb-kick' },
    { note: 38, label: 'Snare', instrument: 'gb-snare' },
    { note: 42, label: 'HH',    instrument: 'gb-hat' },
    { note: 45, label: 'Tom',   instrument: 'gb-tom', pitched: true },   // steps carry [step, semi]
    { note: 49, label: 'Crash', instrument: 'gb-crash' },
  ],
};
