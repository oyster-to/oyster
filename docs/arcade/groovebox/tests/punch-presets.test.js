import { describe, it, expect } from 'vitest';
import { DEFAULT_PRESETS, validatePreset } from '../engine/punch-presets.js';
import { MODULE_PARAMS } from '../engine/punch.js';

describe('DEFAULT_PRESETS', () => {
  it('ships exactly five slots with keys 1-5', () => {
    expect(DEFAULT_PRESETS.map(p => p.key)).toEqual(['1', '2', '3', '4', '5']);
    expect(DEFAULT_PRESETS.map(p => p.name)).toEqual(['STUT', 'CRUSH', 'DIVE', 'THROW', 'STOP']);
  });
  it('every preset validates', () => {
    for (const p of DEFAULT_PRESETS) expect(validatePreset(p)).toBe(true);
  });
  it('every automation targets a registered param', () => {
    for (const p of DEFAULT_PRESETS)
      for (const a of p.automations)
        expect(MODULE_PARAMS[`${a.module}.${a.param}`]).toBeDefined();
  });
  it('CRUSH carries the dogfood-approved 0.9 target', () => {
    const crush = DEFAULT_PRESETS.find(p => p.name === 'CRUSH');
    expect(crush.automations[0].to).toBe(0.9);
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
