import { describe, it, expect } from 'vitest';
import {
  GM, slotKey, gmName, normalizeDrumBar, normalizeDrumGrooves,
  validateInstrument, validateKit, DEFAULT_INSTRUMENTS, DEFAULT_KIT,
  PATCH_PARAMS, ARCHETYPES, SYNTH_PRESETS,
} from '../engine/instruments.js';

describe('slotKey — names and numbers are both valid input, numbers canonical', () => {
  it('maps the legacy five voice names to their GM notes', () => {
    expect(slotKey('kick')).toBe(36);
    expect(slotKey('snare')).toBe(38);
    expect(slotKey('hat')).toBe(42);
    expect(slotKey('tom')).toBe(45);
    expect(slotKey('crash')).toBe(49);
  });
  it('accepts numbers and numeric strings', () => {
    expect(slotKey(36)).toBe(36);
    expect(slotKey('36')).toBe(36);
  });
  it('is case-insensitive on names', () => {
    expect(slotKey('Kick')).toBe(36);
    expect(slotKey('CRASH')).toBe(49);
  });
  it('rejects garbage', () => {
    expect(slotKey('cymbalzz')).toBe(null);
    expect(slotKey(-1)).toBe(null);
    expect(slotKey(128)).toBe(null);
    expect(slotKey(36.5)).toBe(null);
    expect(slotKey(null)).toBe(null);
    expect(slotKey({})).toBe(null);
  });
  it('round-trips via gmName', () => {
    for (const [name, note] of Object.entries(GM)) expect(slotKey(gmName(note))).toBe(slotKey(name));
  });
});

describe('normalizeDrumBar — one boundary, numeric past it', () => {
  it('normalizes name keys and keeps step shapes untouched', () => {
    const bar = { kick: [0, 8], snare: [12], tom: [[4, 2], [6, -1]] };
    expect(normalizeDrumBar(bar)).toEqual({ 36: [0, 8], 38: [12], 45: [[4, 2], [6, -1]] });
  });
  it('passes numeric keys through', () => {
    expect(normalizeDrumBar({ 36: [0] })).toEqual({ 36: [0] });
  });
  it('drops unrecognisable keys instead of crashing', () => {
    expect(normalizeDrumBar({ kick: [0], wibble: [1] })).toEqual({ 36: [0] });
  });
  it('survives bad data', () => {
    expect(normalizeDrumBar(null)).toEqual({});
    expect(normalizeDrumBar([])).toEqual({});
    expect(normalizeDrumBar('x')).toEqual({});
  });
});

describe('normalizeDrumGrooves', () => {
  it('normalizes every bar of every groove', () => {
    const g = { fanfare: [{ kick: [0] }, { snare: [4] }] };
    expect(normalizeDrumGrooves(g)).toEqual({ fanfare: [{ 36: [0] }, { 38: [4] }] });
  });
  it('handles empty/missing tables', () => {
    expect(normalizeDrumGrooves(undefined)).toEqual({});
  });
});

describe('validateInstrument', () => {
  it('accepts every default instrument', () => {
    for (const inst of Object.values(DEFAULT_INSTRUMENTS)) expect(validateInstrument(inst)).toBe(true);
  });
  it('rejects non-synth engines (the v2 seam is reserved, not open)', () => {
    const inst = { ...DEFAULT_INSTRUMENTS['gb-kick'], engine: 'sample' };
    expect(validateInstrument(inst)).toBe(false);
  });
  it('rejects unknown archetypes', () => {
    const inst = JSON.parse(JSON.stringify(DEFAULT_INSTRUMENTS['gb-kick']));
    inst.patch.archetype = 'fm';
    expect(validateInstrument(inst)).toBe(false);
  });
  it('rejects out-of-range params', () => {
    const inst = JSON.parse(JSON.stringify(DEFAULT_INSTRUMENTS['gb-snare']));
    inst.patch.envelope.decay = 99;
    expect(validateInstrument(inst)).toBe(false);
  });
  it('rejects non-finite params (Infinity/NaN)', () => {
    const inst = JSON.parse(JSON.stringify(DEFAULT_INSTRUMENTS['gb-bass']));
    inst.patch.volume = Infinity;
    expect(validateInstrument(inst)).toBe(false);
    inst.patch.volume = NaN;
    expect(validateInstrument(inst)).toBe(false);
  });
  it('rejects bad oscillator shapes and filter types', () => {
    const a = JSON.parse(JSON.stringify(DEFAULT_INSTRUMENTS['gb-bass']));
    a.patch.oscillator.shape = 'wub';
    expect(validateInstrument(a)).toBe(false);
    const b = JSON.parse(JSON.stringify(DEFAULT_INSTRUMENTS['gb-hat']));
    b.patch.filter.type = 'bandpass';
    expect(validateInstrument(b)).toBe(false);
  });
  it('rejects names that would break pad/row layout', () => {
    const inst = { ...DEFAULT_INSTRUMENTS['gb-kick'], name: 'X'.repeat(25) };
    expect(validateInstrument(inst)).toBe(false);
    expect(validateInstrument({ ...DEFAULT_INSTRUMENTS['gb-kick'], name: '' })).toBe(false);
  });
  it('rejects null/garbage without throwing', () => {
    expect(validateInstrument(null)).toBe(false);
    expect(validateInstrument({})).toBe(false);
    expect(validateInstrument('kick')).toBe(false);
  });
});

describe('validateKit', () => {
  it('accepts the default kit against the default instruments', () => {
    expect(validateKit(DEFAULT_KIT, DEFAULT_INSTRUMENTS)).toBe(true);
  });
  it('rejects duplicate slot notes', () => {
    const kit = JSON.parse(JSON.stringify(DEFAULT_KIT));
    kit.slots[1].note = 36;
    expect(validateKit(kit, DEFAULT_INSTRUMENTS)).toBe(false);
  });
  it('rejects slots referencing unknown or non-drum instruments', () => {
    const kit = JSON.parse(JSON.stringify(DEFAULT_KIT));
    kit.slots[0].instrument = 'nope';
    expect(validateKit(kit, DEFAULT_INSTRUMENTS)).toBe(false);
    kit.slots[0].instrument = 'gb-bass';   // exists, but type 'bass'
    expect(validateKit(kit, DEFAULT_INSTRUMENTS)).toBe(false);
  });
  it('accepts name-keyed slot notes (input syntax) — a 7-piece kit with two toms', () => {
    const kit = {
      name: 'BIG KIT',
      slots: [
        { note: 'kick', label: 'Kick', instrument: 'gb-kick' },
        { note: 'snare', label: 'Snare', instrument: 'gb-snare' },
        { note: 'hat', label: 'HH', instrument: 'gb-hat' },
        { note: 'tomlow', label: 'Tom L', instrument: 'gb-tom' },
        { note: 'tomhi', label: 'Tom H', instrument: 'gb-tom' },
        { note: 'ride', label: 'Ride', instrument: 'gb-crash' },
        { note: 'crash', label: 'Crash', instrument: 'gb-crash' },
      ],
    };
    expect(validateKit(kit, DEFAULT_INSTRUMENTS)).toBe(true);
  });
  it('rejects empty and oversized kits', () => {
    expect(validateKit({ name: 'K', slots: [] }, DEFAULT_INSTRUMENTS)).toBe(false);
    const kit = { name: 'K', slots: Array.from({ length: 17 }, (_, i) => ({ note: 36 + i, label: 'S', instrument: 'gb-kick' })) };
    expect(validateKit(kit, DEFAULT_INSTRUMENTS)).toBe(false);
  });
});

describe('PATCH_PARAMS registry', () => {
  it('declares min/max/scale for every param (editor + validation read these)', () => {
    for (const [id, p] of Object.entries(PATCH_PARAMS)) {
      expect(p.min, id).toBeTypeOf('number');
      expect(p.max, id).toBeTypeOf('number');
      expect(p.min).toBeLessThan(p.max);
      expect(['linear', 'log']).toContain(p.scale);
    }
  });
  it('log-scale params never include zero or negatives', () => {
    for (const [id, p] of Object.entries(PATCH_PARAMS)) {
      if (p.scale === 'log') expect(p.min, id).toBeGreaterThan(0);
    }
  });
  it('archetypes are the four todays voices need', () => {
    expect(ARCHETYPES).toEqual(['membrane', 'noise', 'mono', 'poly']);
  });
});

describe('schema v2 — filter resonance + vibrato', () => {
  const resoSaw = () => JSON.parse(JSON.stringify(SYNTH_PRESETS['preset-reso-saw']));

  it('declares filter.Q and vibrato rate/depth in PATCH_PARAMS', () => {
    expect(PATCH_PARAMS['filter.Q']).toBeDefined();
    expect(PATCH_PARAMS['vibrato.rate']).toBeDefined();
    expect(PATCH_PARAMS['vibrato.depth']).toBeDefined();
  });
  it('accepts the Reso Saw preset (resonant lowpass + vibrato)', () => {
    expect(validateInstrument(SYNTH_PRESETS['preset-reso-saw'])).toBe(true);
  });
  it('rejects out-of-range resonance', () => {
    const inst = resoSaw(); inst.patch.filter.Q = 99;
    expect(validateInstrument(inst)).toBe(false);
  });
  it('rejects out-of-range vibrato rate', () => {
    const inst = resoSaw(); inst.patch.vibrato.rate = 50;
    expect(validateInstrument(inst)).toBe(false);
  });
  it('rejects a malformed (non-object) vibrato block', () => {
    const inst = resoSaw(); inst.patch.vibrato = 5;
    expect(validateInstrument(inst)).toBe(false);
  });
});
