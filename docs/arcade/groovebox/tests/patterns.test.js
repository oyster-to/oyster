import { test, expect } from 'vitest';
import {
  totalChainBars, chainBarAt, eventsForStepV2, advanceTarget,
  addPattern, duplicatePattern, removePattern, setPatternBars,
  appendToChain, removeChainAt, moveChain,
  toggleDrumStep, setDrumStep, toggleNote, emptyBarFor,
} from '../engine/patterns.js';

const meter44 = { beatsPerBar: 4, beatUnit: 4, stepsPerBeat: 4 };

function makeSong() {
  return {
    meter: meter44,
    lanes: [
      { id: 'drums', type: 'drums', name: 'drums', muted: false, soloed: false },
      { id: 'melody', type: 'melody', name: 'melody', muted: false, soloed: false },
    ],
    patterns: [
      { bars: 2, lanes: { drums: [{ kick: [0, 8] }, { kick: [0], snare: [12] }], melody: [[[0, 'C4', 2]], []] } },
      { bars: 1, lanes: { drums: [{ hat: [0, 4, 8, 12] }], melody: [[[4, ['E4', 'G4'], 'bar']]] } },
    ],
    chain: [0, 0, 1],
    fills: {},
  };
}

// ── chain math ──
test('totalChainBars sums active bars over the chain', () => {
  expect(totalChainBars(makeSong())).toBe(5);     // 2 + 2 + 1
});

test('chainBarAt maps song bars to (chainPos, patternIdx, barInPattern) and wraps', () => {
  const s = makeSong();
  expect(chainBarAt(s, 0)).toEqual({ chainPos: 0, patternIdx: 0, barInPattern: 0 });
  expect(chainBarAt(s, 3)).toEqual({ chainPos: 1, patternIdx: 0, barInPattern: 1 });
  expect(chainBarAt(s, 4)).toEqual({ chainPos: 2, patternIdx: 1, barInPattern: 0 });
  expect(chainBarAt(s, 5)).toEqual({ chainPos: 0, patternIdx: 0, barInPattern: 0 }); // wrap
});

// ── event resolution ──
test('eventsForStepV2 emits drum + melody events from explicit data', () => {
  const s = makeSong();
  expect(eventsForStepV2(s, 0, 0, 0, null, 0)).toEqual([
    { laneId: 'drums', type: 'drums', voice: 'kick' },
    { laneId: 'melody', type: 'melody', note: 'C4', dur: 2 },
  ]);
  expect(eventsForStepV2(s, 0, 1, 12, null, 0)).toEqual([
    { laneId: 'drums', type: 'drums', voice: 'snare' },
  ]);
});

test('eventsForStepV2: array note → poly chords event, single note on chords lane → arp event', () => {
  const s = makeSong();
  s.lanes.push({ id: 'chords', type: 'chords', name: 'chords', muted: false, soloed: false });
  s.patterns[0].lanes.chords = [[[0, ['A3', 'C4'], 'bar'], [2, 'A3', 1]], []];
  const ev = eventsForStepV2(s, 0, 0, 0, null, 0);
  expect(ev).toContainEqual({ laneId: 'chords', type: 'chords', mode: 'pad', notes: ['A3', 'C4'], dur: 'bar' });
  const ev2 = eventsForStepV2(s, 0, 0, 2, null, 0);
  expect(ev2).toContainEqual({ laneId: 'chords', type: 'chords', mode: 'arp', note: 'A3', dur: 1 });
});

test('eventsForStepV2 honours transpose, fill override, and mute', () => {
  const s = makeSong();
  expect(eventsForStepV2(s, 0, 0, 0, null, 2)[1].note).toBe('D4');
  // fill replaces the drum bar entirely
  const ev = eventsForStepV2(s, 0, 0, 0, { snare: [0] }, 0);
  expect(ev.filter(e => e.type === 'drums')).toEqual([{ laneId: 'drums', type: 'drums', voice: 'snare' }]);
  s.lanes[0].muted = true;
  expect(eventsForStepV2(s, 0, 0, 0, null, 0).some(e => e.type === 'drums')).toBe(false);
});

test('eventsForStepV2 ignores inactive bars implicitly (caller passes barInPattern < bars)', () => {
  const s = makeSong();
  s.patterns[1].lanes.drums.push({ kick: [0] });   // stored beyond bars:1 — inactive
  expect(totalChainBars(s)).toBe(5);                // unchanged: bars still 1
});

// ── playback target ──
test('advanceTarget walks chain positions and wraps; pattern loop stays put', () => {
  const s = makeSong();
  let t = { kind: 'chain', pos: 0, barInPattern: 0 };
  t = advanceTarget(t, s); expect(t).toEqual({ kind: 'chain', pos: 0, barInPattern: 1 });
  t = advanceTarget(t, s); expect(t).toEqual({ kind: 'chain', pos: 1, barInPattern: 0 });
  let p = { kind: 'pattern', idx: 1, barInPattern: 0 };
  p = advanceTarget(p, s); expect(p).toEqual({ kind: 'pattern', idx: 1, barInPattern: 0 }); // 1-bar loop
});

// ── pattern mutations ──
test('addPattern appends an empty 1-bar pattern with data slots for every lane; cap 16', () => {
  const s = makeSong();
  const idx = addPattern(s);
  expect(idx).toBe(2);
  expect(s.patterns[2].bars).toBe(1);
  expect(s.patterns[2].lanes.drums).toEqual([{}]);
  expect(s.patterns[2].lanes.melody).toEqual([[]]);
  while (s.patterns.length < 16) addPattern(s);
  expect(addPattern(s)).toBeNull();
});

test('duplicatePattern deep-clones', () => {
  const s = makeSong();
  const idx = duplicatePattern(s, 0);
  expect(idx).toBe(2);
  s.patterns[2].lanes.drums[0].kick.push(15);
  expect(s.patterns[0].lanes.drums[0].kick).toEqual([0, 8]);
});

test('removePattern: blocked on last; reindexes chain; falls back to [0] if chain empties', () => {
  const s = makeSong();
  expect(removePattern(s, 0)).toBe(true);
  expect(s.patterns.length).toBe(1);
  expect(s.chain).toEqual([0]);                     // chips for old 0 removed, old 1 reindexed
  expect(removePattern(s, 0)).toBe(false);          // last pattern guard
  const s2 = makeSong();
  s2.chain = [1];                                   // chain made entirely of pattern 1
  removePattern(s2, 1);
  expect(s2.chain).toEqual([0]);                    // fallback: first remaining pattern
});

test('setPatternBars: grow pads with empty bars, shrink retains inactive bars', () => {
  const s = makeSong();
  setPatternBars(s, 0, 4);
  expect(s.patterns[0].bars).toBe(4);
  expect(s.patterns[0].lanes.drums.length).toBe(4);
  expect(s.patterns[0].lanes.drums[2]).toEqual({});
  setPatternBars(s, 0, 1);
  expect(s.patterns[0].bars).toBe(1);
  expect(s.patterns[0].lanes.drums.length).toBe(4); // inactive bars retained
  setPatternBars(s, 0, 2);
  expect(s.patterns[0].lanes.drums[1]).toEqual({ kick: [0], snare: [12] }); // round-trip
});

// ── chain mutations ──
test('appendToChain / removeChainAt (last-chip blocked) / moveChain', () => {
  const s = makeSong();
  appendToChain(s, 1);
  expect(s.chain).toEqual([0, 0, 1, 1]);
  expect(removeChainAt(s, 0)).toBe(true);
  expect(s.chain).toEqual([0, 1, 1]);
  moveChain(s, 2, 0);
  expect(s.chain).toEqual([1, 0, 1]);
  s.chain = [0];
  expect(removeChainAt(s, 0)).toBe(false);          // invariant: never empty
  expect(s.chain).toEqual([0]);
});

// ── step edits ──
test('toggleDrumStep toggles hits; tom gets default semi 3', () => {
  const s = makeSong();
  toggleDrumStep(s, 0, 'drums', 'kick', 0, 0);
  expect(s.patterns[0].lanes.drums[0].kick).toEqual([8]);
  toggleDrumStep(s, 0, 'drums', 'tom', 0, 5);
  expect(s.patterns[0].lanes.drums[0].tom).toEqual([[5, 3]]);
  toggleDrumStep(s, 0, 'drums', 'tom', 0, 5);
  expect(s.patterns[0].lanes.drums[0].tom).toEqual([]);
});

test('setDrumStep sets state (not toggle); on is idempotent, off removes', () => {
  const s = makeSong();
  setDrumStep(s, 0, 'drums', 'kick', 0, 0, true);     // already present
  expect(s.patterns[0].lanes.drums[0].kick).toEqual([0, 8]); // idempotent on
  setDrumStep(s, 0, 'drums', 'kick', 0, 4, true);     // add new
  expect(s.patterns[0].lanes.drums[0].kick).toEqual([0, 8, 4]);
  setDrumStep(s, 0, 'drums', 'kick', 0, 8, false);    // remove
  expect(s.patterns[0].lanes.drums[0].kick).toEqual([0, 4]);
  setDrumStep(s, 0, 'drums', 'kick', 0, 13, false);   // off when absent: no-op
  expect(s.patterns[0].lanes.drums[0].kick).toEqual([0, 4]);
});

test('setDrumStep tom: on preserves existing semi, adds [step,3] if absent, off removes', () => {
  const s = makeSong();
  s.patterns[0].lanes.drums[0].tom = [[5, 1]];
  setDrumStep(s, 0, 'drums', 'tom', 0, 5, true);      // already present — keep semi 1
  expect(s.patterns[0].lanes.drums[0].tom).toEqual([[5, 1]]);
  setDrumStep(s, 0, 'drums', 'tom', 0, 9, true);      // absent — default semi 3
  expect(s.patterns[0].lanes.drums[0].tom).toEqual([[5, 1], [9, 3]]);
  setDrumStep(s, 0, 'drums', 'tom', 0, 5, false);     // off — remove
  expect(s.patterns[0].lanes.drums[0].tom).toEqual([[9, 3]]);
});

test('toggleNote: same note removes, different note replaces (monophonic per step)', () => {
  const s = makeSong();
  toggleNote(s, 0, 'melody', 0, 0, 'C4', 2);
  expect(s.patterns[0].lanes.melody[0]).toEqual([]);
  toggleNote(s, 0, 'melody', 0, 4, 'E4', 2);
  toggleNote(s, 0, 'melody', 0, 4, 'G4', 2);
  expect(s.patterns[0].lanes.melody[0]).toEqual([[4, 'G4', 2]]);
});

test('toggleNote deep-compares array notes (chords)', () => {
  const s = makeSong();
  s.lanes.push({ id: 'chords', type: 'chords', name: 'chords', muted: false, soloed: false });
  s.patterns[0].lanes.chords = [[[0, ['A3', 'C4'], 'bar']], []];
  toggleNote(s, 0, 'chords', 0, 0, ['A3', 'C4'], 'bar');
  expect(s.patterns[0].lanes.chords[0]).toEqual([]);   // removed, not duplicated
});

test('emptyBarFor returns {} for drums lanes and [] for others', () => {
  expect(emptyBarFor({ type: 'drums' })).toEqual({});
  expect(emptyBarFor({ type: 'melody' })).toEqual([]);
});
