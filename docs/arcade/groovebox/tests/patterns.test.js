import { test, expect } from 'vitest';
import {
  totalChainBars, chainBarAt, eventsForStepV2, advanceTarget, patternBars,
  addPattern, duplicatePattern, removePattern,
  appendToChain, removeChainAt, moveChain,
  setDrumStep, toggleNote, setLaneGroove, grooveFor, emptyBarFor,
  addGrooveBar, removeGrooveBar,
} from '../engine/patterns.js';

const meter44 = { beatsPerBar: 4, beatUnit: 4, stepsPerBeat: 4 };

function makeSong() {
  return {
    meter: meter44,
    lanes: [
      { id: 'drums', type: 'drums', name: 'drums', muted: false, soloed: false },
      { id: 'melody', type: 'melody', name: 'melody', muted: false, soloed: false },
    ],
    grooves: {
      drums: {
        groove2: [{ kick: [0, 8] }, { kick: [0], snare: [12] }],   // 2-bar
        hats:   [{ hat: [0, 4, 8, 12] }],                          // 1-bar
      },
      melody: {
        riff:  [[[0, 'C4', 2]], []],                               // 2-bar
        chord: [[[4, ['E4', 'G4'], 'bar']]],                       // 1-bar
      },
    },
    patterns: [
      { lanes: { drums: 'groove2', melody: 'riff' } },   // both 2-bar → derived 2
      { lanes: { drums: 'hats',    melody: 'chord' } },   // both 1-bar → derived 1
    ],
    chain: [0, 0, 1],
    fills: {},
  };
}

// ── chain math ──
test('totalChainBars sums pattern bars over the chain', () => {
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
test('eventsForStepV2 emits drum + melody events resolved through grooves', () => {
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
  s.grooves.chords = { prog: [[[0, ['A3', 'C4'], 'bar'], [2, 'A3', 1]], []] };
  s.patterns[0].lanes.chords = 'prog';
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

test('eventsForStepV2: a 1-bar groove under a longer (derived) pattern cycles (b % length)', () => {
  const s = makeSong();
  // Pattern 1 mixes the 1-bar 'hats' drums groove with a 4-bar melody groove →
  // derived length 4; the 1-bar 'hats' must repeat on every bar.
  s.grooves.melody.long = [[], [], [], []];          // 4-bar
  s.patterns[1].lanes.melody = 'long';
  expect(patternBars(s, 1)).toBe(4);
  for (const barInPattern of [0, 1, 2, 3]) {
    const ev = eventsForStepV2(s, 1, barInPattern, 4, null, 0);
    expect(ev).toContainEqual({ laneId: 'drums', type: 'drums', voice: 'hat' });
  }
});

test('eventsForStepV2: a 2-bar groove under a 4-bar (derived) pattern alternates its two bars', () => {
  const s = makeSong();
  // Pattern 0 has the 2-bar 'groove2' drums; give it a 4-bar melody so the
  // pattern derives to 4 and the 2-bar drums groove cycles underneath.
  s.grooves.melody.long = [[], [], [], []];          // 4-bar
  s.patterns[0].lanes.melody = 'long';
  expect(patternBars(s, 0)).toBe(4);
  // bar 0 ≡ bar 2 (groove bar 0: kick at 0); bar 1 ≡ bar 3 (groove bar 1: snare at 12)
  expect(eventsForStepV2(s, 0, 2, 0, null, 0)).toContainEqual({ laneId: 'drums', type: 'drums', voice: 'kick' });
  expect(eventsForStepV2(s, 0, 3, 12, null, 0)).toContainEqual({ laneId: 'drums', type: 'drums', voice: 'snare' });
});

test('eventsForStepV2: missing or empty groove → silent lane', () => {
  const s = makeSong();
  s.patterns[0].lanes.drums = 'nope';                 // dangling ref
  expect(eventsForStepV2(s, 0, 0, 0, null, 0).some(e => e.type === 'drums')).toBe(false);
  s.grooves.drums.blank = [];                         // empty groove
  s.patterns[0].lanes.drums = 'blank';
  expect(eventsForStepV2(s, 0, 0, 0, null, 0).some(e => e.type === 'drums')).toBe(false);
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
test('addPattern clones the picks of patterns[fromIdx] (groove refs shared); cap 16', () => {
  const s = makeSong();
  const idx = addPattern(s, 1);
  expect(idx).toBe(2);
  expect(s.patterns[2]).toEqual({ lanes: { drums: 'hats', melody: 'chord' } });
  // picks are a shallow copy — editing the new pattern's pick doesn't touch the source
  s.patterns[2].lanes.drums = 'groove2';
  expect(s.patterns[1].lanes.drums).toBe('hats');
  while (s.patterns.length < 16) addPattern(s, 0);
  expect(addPattern(s, 0)).toBeNull();
});

test('duplicatePattern is the same affordance as addPattern (clones picks)', () => {
  const s = makeSong();
  expect(duplicatePattern).toBe(addPattern);
  const idx = duplicatePattern(s, 0);
  expect(s.patterns[idx]).toEqual({ lanes: { drums: 'groove2', melody: 'riff' } });
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

test('patternBars derives from the longest picked groove (equal grooves → that length)', () => {
  const s = makeSong();
  expect(patternBars(s, 0)).toBe(2);               // groove2 (2) + riff (2)
  expect(patternBars(s, 1)).toBe(1);               // hats (1) + chord (1)
});

test('patternBars: mixed-length picks → max; missing/empty grooves floor at 1', () => {
  const s = makeSong();
  s.grooves.melody.long = [[], [], [], []];        // 4-bar
  s.patterns[1].lanes.melody = 'long';
  expect(patternBars(s, 1)).toBe(4);               // 1-bar drums, 4-bar melody → 4
  s.patterns[1].lanes.drums = 'nope';              // dangling ref ignored
  expect(patternBars(s, 1)).toBe(4);
  s.grooves.melody.long = [];                       // both empty/missing
  s.patterns[1].lanes.melody = 'long';
  expect(patternBars(s, 1)).toBe(1);               // minimum 1
  expect(patternBars(s, 99)).toBe(1);              // bad index
});

// ── groove pick / lookup ──
test('setLaneGroove sets the edit pattern pick; rejects unknown grooves', () => {
  const s = makeSong();
  expect(setLaneGroove(s, 0, 'drums', 'hats')).toBe(true);
  expect(s.patterns[0].lanes.drums).toBe('hats');
  expect(setLaneGroove(s, 0, 'drums', 'nope')).toBe(false);
  expect(s.patterns[0].lanes.drums).toBe('hats');   // unchanged
  expect(setLaneGroove(s, 99, 'drums', 'hats')).toBe(false); // bad pattern idx
});

test('grooveFor returns {name, bars} or null', () => {
  const s = makeSong();
  const g = grooveFor(s, 0, 'drums');
  expect(g.name).toBe('groove2');
  expect(g.bars).toBe(s.grooves.drums.groove2);
  s.patterns[0].lanes.drums = 'nope';
  expect(grooveFor(s, 0, 'drums')).toBeNull();
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

// ── step edits (write into grooves) ──
test('setDrumStep writes into the named groove; on idempotent, off removes', () => {
  const s = makeSong();
  setDrumStep(s, 'drums', 'groove2', 0, 'kick', 0, true);     // already present
  expect(s.grooves.drums.groove2[0].kick).toEqual([0, 8]);    // idempotent on
  setDrumStep(s, 'drums', 'groove2', 0, 'kick', 4, true);     // add new
  expect(s.grooves.drums.groove2[0].kick).toEqual([0, 8, 4]);
  setDrumStep(s, 'drums', 'groove2', 0, 'kick', 8, false);    // remove
  expect(s.grooves.drums.groove2[0].kick).toEqual([0, 4]);
  setDrumStep(s, 'drums', 'groove2', 0, 'kick', 13, false);   // off when absent: no-op
  expect(s.grooves.drums.groove2[0].kick).toEqual([0, 4]);
});

test('setDrumStep tom: on preserves existing semi, adds [step,3] if absent, off removes', () => {
  const s = makeSong();
  s.grooves.drums.groove2[0].tom = [[5, 1]];
  setDrumStep(s, 'drums', 'groove2', 0, 'tom', 5, true);      // already present — keep semi 1
  expect(s.grooves.drums.groove2[0].tom).toEqual([[5, 1]]);
  setDrumStep(s, 'drums', 'groove2', 0, 'tom', 9, true);      // absent — default semi 3
  expect(s.grooves.drums.groove2[0].tom).toEqual([[5, 1], [9, 3]]);
  setDrumStep(s, 'drums', 'groove2', 0, 'tom', 5, false);     // off — remove
  expect(s.grooves.drums.groove2[0].tom).toEqual([[9, 3]]);
});

test('setDrumStep on a missing groove is a no-op', () => {
  const s = makeSong();
  expect(() => setDrumStep(s, 'drums', 'nope', 0, 'kick', 0, true)).not.toThrow();
});

test('toggleNote: same note removes, different note replaces (monophonic per step)', () => {
  const s = makeSong();
  toggleNote(s, 'melody', 'riff', 0, 0, 'C4', 2);
  expect(s.grooves.melody.riff[0]).toEqual([]);
  toggleNote(s, 'melody', 'riff', 0, 4, 'E4', 2);
  toggleNote(s, 'melody', 'riff', 0, 4, 'G4', 2);
  expect(s.grooves.melody.riff[0]).toEqual([[4, 'G4', 2]]);
});

test('toggleNote deep-compares array notes (chords)', () => {
  const s = makeSong();
  s.grooves.chords = { prog: [[[0, ['A3', 'C4'], 'bar']], []] };
  toggleNote(s, 'chords', 'prog', 0, 0, ['A3', 'C4'], 'bar');
  expect(s.grooves.chords.prog[0]).toEqual([]);   // removed, not duplicated
});

test('editing a groove changes every pattern that references it', () => {
  const s = makeSong();
  // both pattern 0 (chain pos 0,1) reference drums groove 'groove2'
  setDrumStep(s, 'drums', 'groove2', 0, 'snare', 4, true);
  expect(eventsForStepV2(s, 0, 0, 4, null, 0)).toContainEqual({ laneId: 'drums', type: 'drums', voice: 'snare' });
});

test('emptyBarFor returns {} for drums lanes and [] for others', () => {
  expect(emptyBarFor({ type: 'drums' })).toEqual({});
  expect(emptyBarFor({ type: 'melody' })).toEqual([]);
});

// ── groove bar count ──
test('addGrooveBar grows by a deep copy of the last bar; mutating it leaves the old intact', () => {
  const s = makeSong();
  expect(addGrooveBar(s, 'drums', 'groove2')).toBe(3);   // 2 → 3
  const g = s.grooves.drums.groove2;
  expect(g.length).toBe(3);
  expect(g[2]).toEqual(g[1]);                             // copy of last bar
  // deep copy: mutating the drums object on the new bar doesn't touch the old
  g[2].kick.push(7);
  expect(g[1].kick).toEqual([0]);                          // original snare-bar kick unchanged
  // melodic arrays deep-copied too
  expect(addGrooveBar(s, 'melody', 'riff')).toBe(3);
  const m = s.grooves.melody.riff;
  m[2].push([0, 'Z9', 1]);
  expect(m[1]).toEqual([]);                                // original last bar (empty) unchanged
});

test('addGrooveBar caps at 4 and returns null past it / missing groove', () => {
  const s = makeSong();
  s.grooves.melody.long = [[], [], [], []];               // 4-bar
  expect(addGrooveBar(s, 'melody', 'long')).toBeNull();   // already at cap
  expect(s.grooves.melody.long.length).toBe(4);
  expect(addGrooveBar(s, 'drums', 'nope')).toBeNull();    // missing groove
  expect(addGrooveBar(s, 'nolane', 'x')).toBeNull();      // missing lane
});

test('removeGrooveBar drops the last bar; min 1 returns null; missing groove null', () => {
  const s = makeSong();
  expect(removeGrooveBar(s, 'drums', 'groove2')).toBe(1); // 2 → 1
  expect(s.grooves.drums.groove2.length).toBe(1);
  expect(removeGrooveBar(s, 'drums', 'groove2')).toBeNull(); // already at min
  expect(s.grooves.drums.groove2.length).toBe(1);
  expect(removeGrooveBar(s, 'drums', 'nope')).toBeNull(); // missing groove
});

test('patternBars follows groove length changes (pattern duration tracks the groove)', () => {
  const s = makeSong();
  expect(patternBars(s, 0)).toBe(2);                      // groove2 (2) + riff (2)
  addGrooveBar(s, 'drums', 'groove2');                    // 2 → 3
  expect(patternBars(s, 0)).toBe(3);                      // pattern grows with the groove
  removeGrooveBar(s, 'drums', 'groove2');                 // 3 → 2
  removeGrooveBar(s, 'drums', 'groove2');                 // 2 → 1
  removeGrooveBar(s, 'melody', 'riff');                   // 2 → 1 (both now 1)
  expect(patternBars(s, 0)).toBe(1);
});
