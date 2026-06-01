import { test, expect } from 'vitest';
import { resolveDrumPattern, chordAt, hasDrumHit } from '../engine/song.js';

const one = { kick:[0,4,8,12], snare:[4,12] };
const two = [ { kick:[0,4,8,12] }, { kick:[0,4,8] } ];

test('single-bar pattern resolves to itself for any bar', () => {
  expect(resolveDrumPattern(one, 0, 4)).toBe(one);
  expect(resolveDrumPattern(one, 3, 4)).toBe(one);
});
test('multi-bar pattern cycles by bar', () => {
  expect(resolveDrumPattern(two, 0, 4)).toBe(two[0]);
  expect(resolveDrumPattern(two, 1, 4)).toBe(two[1]);
  expect(resolveDrumPattern(two, 2, 4)).toBe(two[0]);
});
test('cycleLen overrides array length for custom patterns', () => {
  const four = [ {kick:[0]}, {kick:[4]}, {kick:[8]}, {kick:[12]} ];
  expect(resolveDrumPattern(four, 5, 2)).toBe(four[1]); // 5 % 2 = 1
});
test('hasDrumHit reads kick/snare/etc and toms by step', () => {
  expect(hasDrumHit(one, 'kick', 4)).toBe(true);
  expect(hasDrumHit(one, 'kick', 5)).toBe(false);
  expect(hasDrumHit({ tom:[[2,7]] }, 'tom', 2)).toBe(true);
  expect(hasDrumHit({}, 'crash', 0)).toBe(false);
});
test('chordAt cycles the progression by bar', () => {
  const prog = [{name:'F#m'},{name:'D'},{name:'A'},{name:'E/G#'}];
  expect(chordAt(prog, 0).name).toBe('F#m');
  expect(chordAt(prog, 5).name).toBe('D');
});
