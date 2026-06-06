import { describe, it, expect } from 'vitest';
import { DEFAULT_PRESETS, validatePreset } from '../engine/punch-presets.js';
import { MODULE_PARAMS } from '../engine/punch.js';

describe('DEFAULT_PRESETS', () => {
  it('ships exactly five slots with keys 1-5', () => {
    expect(DEFAULT_PRESETS.map(p => p.key)).toEqual(['1', '2', '3', '4', '5']);
    expect(DEFAULT_PRESETS.map(p => p.name)).toEqual(['STUTTER', 'STUTTER BASS', 'DIVE', 'THROW', 'STOP']);
  });
  it('every preset validates', () => {
    for (const p of DEFAULT_PRESETS) expect(validatePreset(p)).toBe(true);
  });
  it('every automation targets a registered param', () => {
    for (const p of DEFAULT_PRESETS)
      for (const a of p.automations)
        expect(MODULE_PARAMS[`${a.module}.${a.param}`]).toBeDefined();
  });
  it('both stutters chop at 1/8 with their own sections', () => {
    const mel = DEFAULT_PRESETS.find(p => p.name === 'STUTTER');
    const bas = DEFAULT_PRESETS.find(p => p.name === 'STUTTER BASS');
    expect(mel.automations[0].division).toBe('1/8');
    expect(mel.lanes).toEqual(['melody']);
    expect(bas.automations[0].division).toBe('1/8');
    expect(bas.lanes).toEqual(['drums', 'bass']);
  });
});

describe('validatePreset', () => {
  const base = { name: 'X', key: '1', engageQuantize: 'immediate', releaseQuantize: 'immediate' };
  it('rejects unknown duration units (seconds reserved for future)', () => {
    expect(validatePreset({ ...base,
      automations: [{ module: 'filter', param: 'freq', from: 'neutral', to: 150,
        engage: { ramp: { unit: 'seconds', value: 1 } } }] })).toBe(false);
  });
  it('rejects unknown quantize values', () => {
    expect(validatePreset({ ...base, engageQuantize: 'sometime', automations: [] })).toBe(false);
  });
  it('rejects automations on unregistered params', () => {
    expect(validatePreset({ ...base,
      automations: [{ module: 'nope', param: 'nah', from: 'neutral', to: 1 }] })).toBe(false);
  });
  it('accepts a numeric from override and a scale override', () => {
    expect(validatePreset({ ...base,
      automations: [{ module: 'filter', param: 'freq', from: 8000, to: 150, scale: 'linear',
        engage: { ramp: { unit: 'beats', value: 1 } } }] })).toBe(true);
  });
});

describe('validatePreset hardening (user-supplied localStorage overrides)', () => {
  const base = { name: 'X', key: '1', engageQuantize: 'immediate', releaseQuantize: 'immediate' };
  it('rejects non-finite to/from', () => {
    expect(validatePreset({ ...base, automations: [{ module: 'crusher', param: 'wet', from: 'neutral', to: Infinity }] })).toBe(false);
    expect(validatePreset({ ...base, automations: [{ module: 'crusher', param: 'wet', from: NaN, to: 0.5 }] })).toBe(false);
  });
  it('rejects non-positive values on log-scaled params (scaleValue would NaN)', () => {
    expect(validatePreset({ ...base, automations: [{ module: 'filter', param: 'freq', from: 'neutral', to: 0 }] })).toBe(false);
    expect(validatePreset({ ...base, automations: [{ module: 'filter', param: 'freq', from: -5, to: 150 }] })).toBe(false);
    expect(validatePreset({ ...base, automations: [{ module: 'crusher', param: 'wet', from: 'neutral', to: 0.5, scale: 'log' }] })).toBe(false); // neutral 0 + log
  });
  it('rejects bad gate divisions and out-of-range gate depth', () => {
    expect(validatePreset({ ...base, automations: [{ module: 'gate', param: 'depth', from: 'neutral', to: 1, division: '1/7' }] })).toBe(false);
    expect(validatePreset({ ...base, automations: [{ module: 'gate', param: 'depth', from: 'neutral', to: 1.5 }] })).toBe(false);
  });
  it('accepts a valid gate automation with explicit division', () => {
    expect(validatePreset({ ...base, automations: [{ module: 'gate', param: 'depth', from: 'neutral', to: 0.8, division: '1/32' }] })).toBe(true);
  });
});

describe('registry ranges (v3.5 — single source of truth)', () => {
  const base = { name: 'X', key: '1', engageQuantize: 'immediate', releaseQuantize: 'immediate' };
  it('rejects delay.feedback above 0.95 (the v3 runaway hole)', () => {
    expect(validatePreset({ ...base, automations: [{ module: 'delay', param: 'feedback', from: 'neutral', to: 5 }] })).toBe(false);
    expect(validatePreset({ ...base, automations: [{ module: 'delay', param: 'feedback', from: 'neutral', to: 0.9 }] })).toBe(true);
  });
  it('rejects out-of-range from (release would park the param out of bounds)', () => {
    expect(validatePreset({ ...base, automations: [{ module: 'filter', param: 'freq', from: 90000, to: 150 }] })).toBe(false);
    expect(validatePreset({ ...base, automations: [{ module: 'delay', param: 'feedback', from: 2, to: 0.5 }] })).toBe(false);
  });
  it('rejects out-of-range to on any ranged param', () => {
    expect(validatePreset({ ...base, automations: [{ module: 'crusher', param: 'wet', from: 'neutral', to: 1.5 }] })).toBe(false);
    expect(validatePreset({ ...base, automations: [{ module: 'filter', param: 'freq', from: 'neutral', to: 50000 }] })).toBe(false);
  });
});

describe('lane masks (v3.5 — per-preset targeting)', () => {
  const base = { name: 'X', key: '1', engageQuantize: 'immediate', releaseQuantize: 'immediate', automations: [] };
  it('STUTTER defaults to 1/8 on melody', () => {
    const stut = DEFAULT_PRESETS.find(p => p.name === 'STUTTER');
    expect(stut.automations[0].division).toBe('1/8');
    expect(stut.lanes).toEqual(['melody']);
  });
  it('validates lanes as a subset of known lane types', () => {
    expect(validatePreset({ ...base, lanes: ['drums', 'bass'] })).toBe(true);
    expect(validatePreset({ ...base, lanes: ['drums', 'vocals'] })).toBe(false);
    expect(validatePreset({ ...base, lanes: 'drums' })).toBe(false);
  });
  it('omitted lanes means all (other defaults carry no mask)', () => {
    expect(DEFAULT_PRESETS.find(p => p.name === 'DIVE').lanes).toBeUndefined();
  });
});

describe('per-preset amount (v3.5 — replaces the global AMT knob)', () => {
  const base = { name: 'X', key: '1', engageQuantize: 'immediate', releaseQuantize: 'immediate', automations: [] };
  it('accepts amount in 0..1, rejects outside', () => {
    expect(validatePreset({ ...base, amount: 0.5 })).toBe(true);
    expect(validatePreset({ ...base, amount: 1.5 })).toBe(false);
    expect(validatePreset({ ...base, amount: -0.1 })).toBe(false);
  });
  it('defaults carry no amount (= full strength)', () => {
    for (const p of DEFAULT_PRESETS) expect(p.amount).toBeUndefined();
  });
});
