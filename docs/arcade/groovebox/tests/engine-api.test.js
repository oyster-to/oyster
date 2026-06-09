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
  for (const fn of ['setMode', 'getMode', 'captureScene', 'clearArrangement', 'setLane', 'setPatternBars']) {
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

test('removePattern shifts editIdx when deleting an earlier pattern', () => {
  const eng = loaded();
  const p2content = JSON.stringify(eng.getSong().patterns[2]);
  eng.selectPattern(2);
  eng.removePattern(0);
  expect(eng.getEditPatternIndex()).toBe(1);
  expect(JSON.stringify(eng.getSong().patterns[eng.getEditPatternIndex()])).toBe(p2content);
});

test('removeChainAt below the current chain target shifts pos precisely', () => {
  const eng = loaded();
  eng.playChain(2);                       // stopped → sets target directly
  eng.removeChainAt(0);
  expect(eng.getPlaybackTarget().chainPos).toBe(1);
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
});

test('addPattern seeds an empty name; setPatternName trims and caps it', () => {
  const eng = loaded();
  const i = eng.addPattern();
  expect(eng.getSong().patterns[i].name).toBe('');
  expect(eng.getPatternName(i)).toBe('');
  eng.setPatternName(i, '  Verse  ');
  expect(eng.getPatternName(i)).toBe('Verse');               // trimmed
  eng.setPatternName(i, 'x'.repeat(60));
  expect(eng.getPatternName(i).length).toBe(40);             // capped
  eng.setPatternName(i, '');
  expect(eng.getPatternName(i)).toBe('');                    // clears
});

test('getGrooves lists named grooves; flattened kids has a drums groove named from "four"', () => {
  const eng = loaded();
  const grooves = eng.getGrooves();
  expect(grooves.drums).toBeDefined();
  const drumNames = Object.keys(grooves.drums);
  // kids' first/last sections select the 'four' kit (with fills baked in).
  expect(drumNames.some(n => n.startsWith('four'))).toBe(true);
});

test('setLaneGroove changes the edit pattern pick and is validated', () => {
  const eng = loaded();
  eng.selectPattern(1);
  const drumGrooves = Object.keys(eng.getGrooves().drums);
  const target = drumGrooves[0];
  expect(eng.setLaneGroove('drums', target)).toBe(true);
  expect(eng.getSong().patterns[1].lanes.drums).toBe(target);
  expect(eng.setLaneGroove('drums', 'definitely-not-a-groove')).toBe(false);
  expect(eng.getSong().patterns[1].lanes.drums).toBe(target);   // unchanged
});

test('addPattern clones the edit pattern picks', () => {
  const eng = loaded();
  eng.selectPattern(2);
  const picks = { ...eng.getSong().patterns[2].lanes };
  const idx = eng.addPattern();
  expect(eng.getSong().patterns[idx].lanes).toEqual(picks);
});

// ── harmony API (chords belong to patterns) ─────────────────────────────────
test('getKey: kids flattens with its authored A-major key; getPatternChords reads pattern chords', () => {
  const eng = loaded();
  expect(eng.getKey()).toEqual({ root: 'A', mode: 'major' });
  expect(eng.getPatternChords(0).length).toBeGreaterThan(0);
});

test('getHarmony/setProgression are gone (replaced by pattern-owned chords)', () => {
  const eng = loaded();
  expect(eng.getHarmony).toBeUndefined();
  expect(eng.setProgression).toBeUndefined();
});

test('setPatternChords sets the EDIT pattern chords and re-derives song.key', () => {
  const eng = loaded();
  eng.selectPattern(0);
  const newChords = [{ name: 'Cm', root: 'C2', voicing: ['C3', 'D#3', 'G3'] }];
  eng.setPatternChords(newChords);
  expect(eng.getPatternChords(0)).toBe(newChords);
  // key re-derived across ALL patterns' chords (no throw; a key is found).
  expect(eng.getKey()).toBeTruthy();
});

test('setPatternChords([]) clears the edit pattern chords', () => {
  const eng = createEngine();
  eng.load({ patterns: [{ lanes: {} }], chain: [0], lanes: [], grooves: {}, meter: { beatsPerBar: 4, beatUnit: 4, stepsPerBeat: 4 }, bpm: 120 });
  expect(eng.getPatternChords(0)).toBeNull();
  const prog = [{ name: 'A', root: 'A2', voicing: ['A3', 'C#4', 'E4'] }];
  eng.setPatternChords(prog);
  expect(eng.getPatternChords(0)).toBe(prog);
  expect(eng.getKey()).toBeTruthy();
  eng.setPatternChords([]);
  expect(eng.getPatternChords(0)).toBeNull();
  expect(eng.getKey()).toBeNull();
});

test('getEditGroove returns the edit pattern groove for a lane (name + data) and tracks selectPattern', () => {
  const eng = loaded();
  const g0 = eng.getEditGroove('drums');
  expect(g0).toMatchObject({ name: eng.getSong().patterns[0].lanes.drums });
  expect(Array.isArray(g0.bars)).toBe(true);
  expect(g0.bars).toBe(eng.getGrooves().drums[g0.name]);   // returns the live data array
  eng.selectPattern(1);
  expect(eng.getEditGroove('drums').name).toBe(eng.getSong().patterns[1].lanes.drums);
  expect(eng.getEditGroove('no-such-lane')).toBe(null);
});
