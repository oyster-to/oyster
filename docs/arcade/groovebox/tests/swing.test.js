import { test, expect } from 'vitest';
import { swingOffset } from '../engine/scheduler.js';

test('even step returns 0 regardless of amount', () => {
  expect(swingOffset(0, 0.5, 0.1)).toBe(0);
  expect(swingOffset(2, 0.8, 0.15)).toBe(0);
  expect(swingOffset(14, 1, 0.1)).toBe(0);
});

test('odd step returns amount * 0.55 * sixteenth', () => {
  const sixteenth = 0.125;
  const amount = 0.6;
  expect(swingOffset(1, amount, sixteenth)).toBeCloseTo(amount * 0.55 * sixteenth);
  expect(swingOffset(3, amount, sixteenth)).toBeCloseTo(amount * 0.55 * sixteenth);
  expect(swingOffset(11, amount, sixteenth)).toBeCloseTo(amount * 0.55 * sixteenth);
});

test('amount 0 returns 0 for any step', () => {
  expect(swingOffset(0, 0, 0.125)).toBe(0);
  expect(swingOffset(1, 0, 0.125)).toBe(0);
  expect(swingOffset(7, 0, 0.125)).toBe(0);
});

test('amount 1 odd step returns 0.55 * sixteenth and is strictly less than sixteenth', () => {
  const sixteenth = 0.125;
  const result = swingOffset(1, 1, sixteenth);
  expect(result).toBeCloseTo(0.55 * sixteenth);
  expect(result).toBeLessThan(sixteenth);
});
