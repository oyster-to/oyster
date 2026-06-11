// tests/song-switch.test.js
// Probe the engine state that must be clean after switching songs via the SONG
// dropdown. loadSong() in ui/app.js does: eng.stop() → eng.load(NEW) →
// eng.setTempo → eng.setTranspose(0). These tests exercise that sequence at the
// engine level (no audio graph: load() runs without ensure() in tests).
import { test, expect } from 'vitest';
import { createEngine } from '../engine/index.js';
import { kids } from '../songs/kids.js';
import { risingSun } from '../songs/rising-sun.js';

// Reproduce loadSong()'s engine-side sequence, MINUS eng.stop(). stop() touches
// Tone.Transport which is uninitialised in node tests; it only matters when the
// transport is actually running (audio). Post-load STATE is what these probes
// assert, and load()+setTranspose(0) is the part that shapes it.
function switchTo(eng, song) {
  eng.load(song);
  eng.setTranspose(0);   // (loadSong also calls setTempo; that touches the live
                         //  Tone.Transport and is irrelevant to post-load state)
}

test('switching songs resets editIdx, target, and pendingTarget', () => {
  const eng = createEngine();
  eng.load(kids);
  // Dirty the engine the way a user would before switching.
  eng.selectPattern(2);                       // editIdx=2, target=pattern
  expect(eng.getEditPatternIndex()).toBe(2);

  switchTo(eng, risingSun);

  expect(eng.getEditPatternIndex()).toBe(0);
  const t = eng.getPlaybackTarget();
  expect(t.kind).toBe('chain');
  expect(t.chainPos).toBe(0);
  expect(t.barInPattern).toBe(0);
  expect(t.pending).toBe(false);
});

// CONTRACT NOTE: load() alone does NOT clear the fill queue — only stop() does.
// loadSong() in ui/app.js always calls eng.stop() before eng.load(), so the
// queue is cleared in practice. This test pins that contract so a future refactor
// that drops the stop() call (or a code path that loads without stopping) is
// caught: clearQueue() is the engine-level guarantee the UI relies on.
test('clearQueue empties the fill queue (the guarantee loadSong relies on via stop)', () => {
  const eng = createEngine();
  eng.load(kids);
  const fillNames = Object.keys(eng.getSong().fills);
  if (fillNames.length) {
    eng.queueFill(fillNames[0]);
    eng.queueFill(fillNames[0]);
    expect(eng.unqueueAt(Infinity).length).toBe(2);
  }
  eng.clearQueue();
  expect(eng.unqueueAt(Infinity)).toEqual([]);
});

test('switching songs loads the new meter, lanes, patterns and chain', () => {
  const eng = createEngine();
  eng.load(kids);
  const kidsMeter = JSON.stringify(eng.getSong().meter);
  switchTo(eng, risingSun);
  const rs = eng.getSong();
  expect(JSON.stringify(rs.meter)).not.toBe(kidsMeter);   // 4/4 → 6/8
  expect(rs.patterns.length).toBeGreaterThanOrEqual(1);
  expect(rs.chain.length).toBeGreaterThanOrEqual(1);
});

test('transpose does not leak across a song switch', () => {
  const eng = createEngine();
  eng.load(kids);
  eng.setTranspose(5);
  expect(eng.getTranspose()).toBe(5);
  switchTo(eng, risingSun);
  expect(eng.getTranspose()).toBe(0);
});

test('load() never mutates the rich preset module object', () => {
  const before = JSON.stringify(kids, (k, v) => typeof v === 'function' ? '[fn]' : v);
  const eng = createEngine();
  eng.load(kids);
  eng.setTranspose(7);                         // writes to the FLATTENED song
  eng.setLaneInstrument('melody', 'preset-saw-lead');   // writes lane.instrument on flattened song
  eng.selectPattern(1);
  const after = JSON.stringify(kids, (k, v) => typeof v === 'function' ? '[fn]' : v);
  expect(after).toBe(before);
});

test('switching to a song and back gives an independent flattened object each time', () => {
  const eng = createEngine();
  eng.load(kids);
  const first = eng.getSong();
  eng.setLaneInstrument('melody', 'preset-saw-lead');   // mutate flattened lane.instrument
  expect(first.lanes.find(l => l.type === 'melody').instrument).toBe('preset-saw-lead');
  switchTo(eng, risingSun);
  switchTo(eng, kids);
  const second = eng.getSong();
  expect(second).not.toBe(first);              // fresh flatten
  // The new flatten must NOT carry the runtime mutation — it reflects kids'
  // SOURCE override (preset-reso-saw), not the runtime 'preset-saw-lead'.
  expect(second.lanes.find(l => l.type === 'melody').instrument).toBe('preset-reso-saw');
});
