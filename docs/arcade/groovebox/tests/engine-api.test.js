// tests/engine-api.test.js
import { test, expect } from 'vitest';
import { createEngine } from '../engine/index.js';
import { kids } from '../songs/kids.js';

function loaded() {
  const eng = createEngine();
  eng.load(kids);
  return eng;
}

test('load() flattens a rich song to the explicit schema', () => {
  const eng = loaded();
  const s = eng.getSong();
  expect(Array.isArray(s.patterns)).toBe(true);
  expect(s.chain.length).toBeGreaterThanOrEqual(1);
  expect(s.lanes.every(l => l.pool === undefined && l.selection === undefined)).toBe(true);
});

test('load() passes an already-explicit song through untouched', () => {
  const eng = createEngine();
  const v2 = loaded().getSong();
  eng.load(v2);
  expect(eng.getSong()).toBe(v2);
});

test('removed APIs are gone', () => {
  const eng = loaded();
  for (const fn of ['setMode', 'getMode', 'captureScene', 'clearArrangement', 'setLane']) {
    expect(eng[fn]).toBeUndefined();
  }
});

test('selectPattern sets the edit target; removePattern clamps it', () => {
  const eng = loaded();
  const n = eng.getSong().patterns.length;
  eng.selectPattern(n - 1);
  expect(eng.getEditPatternIndex()).toBe(n - 1);
  eng.removePattern(n - 1);
  expect(eng.getEditPatternIndex()).toBe(eng.getSong().patterns.length - 1);
});

test('playback target follows the last click even while stopped', () => {
  const eng = loaded();
  expect(eng.getPlaybackTarget().kind).toBe('chain');          // default
  eng.selectPattern(1);
  expect(eng.getPlaybackTarget()).toMatchObject({ kind: 'pattern', patternIdx: 1 });
  eng.playChain(0);
  expect(eng.getPlaybackTarget().kind).toBe('chain');
});

test('pattern/chain mutation APIs are wired through', () => {
  const eng = loaded();
  const before = eng.getSong().patterns.length;
  const idx = eng.addPattern();
  expect(idx).toBe(before);
  eng.appendToChain(idx);
  expect(eng.getSong().chain.at(-1)).toBe(idx);
  const len = eng.getSong().chain.length;
  eng.removeChainAt(len - 1);
  expect(eng.getSong().chain.length).toBe(len - 1);
  eng.setPatternBars(idx, 4);
  expect(eng.getSong().patterns[idx].bars).toBe(4);
});
