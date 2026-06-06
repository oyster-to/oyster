import { test, expect } from 'vitest';
import { stepsPerBar, beatStarts } from '../engine/meter.js';

// 16th-note resolution: stepsPerBeat = 16th notes per beat unit.
test('4/4 = 16 steps, beats every 4', () => {
  const m = { beatsPerBar: 4, beatUnit: 4, stepsPerBeat: 4 };
  expect(stepsPerBar(m)).toBe(16);
  expect(beatStarts(m)).toEqual([0, 4, 8, 12]);
});
test('3/4 = 12 steps, beats every 4', () => {
  const m = { beatsPerBar: 3, beatUnit: 4, stepsPerBeat: 4 };
  expect(stepsPerBar(m)).toBe(12);
  expect(beatStarts(m)).toEqual([0, 4, 8]);
});
test('6/8 = 12 steps, two dotted-quarter beats (eighth groups)', () => {
  const m = { beatsPerBar: 6, beatUnit: 8, stepsPerBeat: 2, group: 3 };
  expect(stepsPerBar(m)).toBe(12);
  expect(beatStarts(m)).toEqual([0, 2, 4, 6, 8, 10]);
});
