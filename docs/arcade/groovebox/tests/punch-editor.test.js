import { describe, it, expect } from 'vitest';
import { draftFromPreset, paramPos, paramValue, availableParams, defaultAutomation, PARAM_UI } from '../ui/punch-editor.js';
import { DEFAULT_PRESETS, validatePreset } from '../engine/punch-presets.js';
import { MODULE_PARAMS } from '../engine/punch.js';

describe('PARAM_UI', () => {
  it('labels every registry param', () => {
    for (const id of Object.keys(MODULE_PARAMS)) expect(PARAM_UI[id]?.label).toBeTruthy();
  });
});

describe('draftFromPreset', () => {
  it('deep clones — editing the draft never touches the source', () => {
    const src = DEFAULT_PRESETS[1];
    const draft = draftFromPreset(src);
    draft.name = 'WRECK';
    draft.automations[0].to = 0.1;
    expect(src.name).toBe('CRUSH');
    expect(src.automations[0].to).toBe(0.9);
  });
});

describe('paramPos / paramValue (slider mapping in registry scale space)', () => {
  it('round-trips linear params', () => {
    expect(paramValue('crusher.wet', paramPos('crusher.wet', 0.9))).toBeCloseTo(0.9);
  });
  it('round-trips log params', () => {
    expect(paramValue('filter.freq', paramPos('filter.freq', 150))).toBeCloseTo(150, 1);
  });
  it('maps endpoints to 0 and 1', () => {
    expect(paramPos('filter.freq', 100)).toBeCloseTo(0);
    expect(paramPos('filter.freq', 20000)).toBeCloseTo(1);
  });
});

describe('availableParams', () => {
  it('excludes params already used by the draft', () => {
    const draft = draftFromPreset(DEFAULT_PRESETS[1]); // CRUSH uses crusher.wet
    const avail = availableParams(draft);
    expect(avail).not.toContain('crusher.wet');
    expect(avail).toContain('gate.depth');
  });
});

describe('defaultAutomation', () => {
  it('produces a valid automation for every registry param', () => {
    for (const id of Object.keys(MODULE_PARAMS)) {
      const draft = { name: 'X', key: '1', engageQuantize: 'immediate', releaseQuantize: 'immediate', automations: [defaultAutomation(id)] };
      expect(validatePreset(draft)).toBe(true);
    }
  });
  it('gives gate automations a division', () => {
    expect(defaultAutomation('gate.depth').division).toBe('1/16');
  });
});
