# Groovebox Patterns + Chain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the groovebox's two competing sequencing models (per-lane cycle-2/4 bar editing + global Arrangement scenes) with one model: whole-machine patterns (1/2/4 bars) sequenced by an always-non-empty chain.

**Architecture:** A load-time flattener bakes the 7 rich-format preset songs (pools/generators/harmony/arrangement) into an explicit `patterns[] + chain[]` schema; the engine and UI only ever see the explicit schema. Playback state is a "target" (chain position or temporary pattern loop) that switches at bar boundaries. A frozen legacy reference renderer proves note-stream parity before any engine change lands.

**Tech Stack:** Vanilla ES modules, Tone.js 14 (audio only — all sequencing logic is Tone-free and unit-testable), Vitest.

**Spec:** `docs/superpowers/specs/2026-06-06-groovebox-patterns-chain-design.md` — read it first.

**Worktree:** `~/Dev/oyster.worktrees/groovebox-patterns-chain` (branch `groovebox-patterns-chain`, already created). All paths below are relative to `docs/arcade/groovebox/` in that worktree. Run tests with `npm test` (or `npx vitest run <file>`) from `docs/arcade/groovebox/`.

**Conventions that apply (from CLAUDE.md + memory):**
- NO `CHANGELOG.md` entry — arcade changes are excluded from the consumer changelog.
- Don't pipe `git commit` through `tail`/etc.
- Manual deploy only; do not deploy as part of this plan.

---

## File structure

| File | Status | Responsibility |
|---|---|---|
| `tests/legacy/legacy-engine.js` | create | FROZEN copy of pre-change resolution logic + legacy song-mode stream renderer. Never imports from `engine/`. |
| `tests/helpers/stream.js` | create | v2 chain-stream renderer + event normalization shared by parity tests |
| `engine/patterns.js` | create | All pure v2 logic: chain math, `eventsForStepV2`, pattern/chain mutations, step-edit toggles |
| `engine/flatten.js` | create | Rich-format → v2 converter (the read-only bridge). Self-contained copies of rich resolution logic. |
| `engine/index.js` | modify | Playback target state machine, new API surface, remove mode/arrangement/captureScene |
| `engine/scheduler.js` | delete | Superseded by `eventsForStepV2` in patterns.js |
| `engine/arrangement.js` | delete | Superseded by chain math in patterns.js |
| `engine/song.js` | modify | Keep `laneAudible`/`drumVoiceAudible`/`transposeNote`/`DRUM_KEYS`; delete `resolveDrumPattern`/`hasDrumHit`/`chordAt` |
| `engine/lanes.js` | modify | Lane add/dup/remove become pattern-data aware; delete pools/selection/captureScene machinery |
| `ui/app.js` | modify | PATTERNS module replaces Arrangement; strips lose pattern dropdowns; onStep rewiring |
| `ui/viz.js` | modify | Stacked multi-bar drum grid; rolls/blocks use pattern length; edits write into the selected pattern; delete barsel/cycle/fork machinery |
| `ui/app.css` | modify | Styles for the PATTERNS module; delete barsel/cycle styles |
| `tests/*.test.js` | modify/delete | Per-file disposition in Task 5 Step 1 |

---

### Task 1: Frozen legacy reference renderer

The parity spine. A self-contained copy of today's resolution logic that renders a rich-format song's **song-mode** playback to a flat note-event stream. It must not import from `engine/` so later engine changes can't silently move the goalposts.

**Files:**
- Create: `tests/legacy/legacy-engine.js`
- Test: `tests/legacy-reference.test.js`

- [ ] **Step 1: Write `tests/legacy/legacy-engine.js`**

Copy the bodies of `resolveDrumPattern`, `chordAt`, `hasDrumHit` from `engine/song.js@HEAD`, `sectionAt` from `engine/arrangement.js@HEAD`, and the resolution switch of `eventsForStep` from `engine/scheduler.js@HEAD` (current file contents — copy them verbatim, do not re-derive). Then add the stream renderer:

```js
// tests/legacy/legacy-engine.js
// FROZEN copy of the pre-patterns-redesign engine resolution logic.
// Deliberately duplicated — this is the parity reference; it must stay
// independent of engine/ so refactors there cannot change it.

export function stepsPerBar(m) { return m.beatsPerBar * m.stepsPerBeat; }

const DRUM_KEYS = ['kick', 'snare', 'hat', 'crash'];

function resolveDrumPattern(pattern, bar, cycleLen) {
  if (!Array.isArray(pattern)) return pattern;
  const len = cycleLen ? Math.min(cycleLen, pattern.length) : pattern.length;
  return pattern[((bar % len) + len) % len];
}

function hasDrumHit(pat, k, step) {
  if (k === 'tom') return !!(pat.tom && pat.tom.some(([s]) => s === step));
  return !!(pat[k] && pat[k].includes(step));
}

function chordAt(progression, bar) {
  const n = progression.length || 1;
  return progression[((bar % n) + n) % n];
}

function sectionAt(arrangement, songBar) {
  const total = arrangement.reduce((n, s) => n + s.bars, 0) || 1;
  let b = ((songBar % total) + total) % total;
  for (let i = 0; i < arrangement.length; i++) {
    const s = arrangement[i];
    if (b < s.bars) return { index: i, section: s, barInSection: b, isLastBar: b === s.bars - 1 };
    b -= s.bars;
  }
  const last = arrangement.length - 1;
  return { index: last, section: arrangement[last], barInSection: 0, isLastBar: true };
}

// Verbatim resolution logic from engine/scheduler.js eventsForStep, minus
// mute/solo (reference assumes everything audible) and minus transpose (tr=0).
function eventsForStep(song, lanes, absStep, fillPat) {
  const spb = stepsPerBar(song.meter);
  const bar = Math.floor(absStep / spb);
  const step = absStep % spb;
  const chord = chordAt(song.harmony.progression, bar);
  const ev = [];
  for (const lane of lanes) {
    if (lane.type === 'drums') {
      const pat = fillPat || (resolveDrumPattern(lane.pool[lane.selection], bar, lane.cycleLen) || {});
      for (const k of DRUM_KEYS) {
        if (hasDrumHit(pat, k, step)) ev.push({ laneId: lane.id, type: 'drums', voice: k });
      }
      if (pat.tom) {
        for (const [s, semi] of pat.tom) {
          if (s === step) ev.push({ laneId: lane.id, type: 'drums', voice: 'tom', semi: semi ?? 0 });
        }
      }
    } else if (lane.type === 'bass') {
      if (!lane.pool || !lane.pool[lane.selection]) continue;
      const gen = lane.pool[lane.selection];
      const notes = typeof gen === 'function'
        ? (gen(bar, chord) || [])
        : (Array.isArray(gen) && gen.length ? (gen[bar % gen.length] || []) : []);
      for (const [s, note, dur] of notes) {
        if (s === step) ev.push({ laneId: lane.id, type: 'bass', note, dur });
      }
    } else if (lane.type === 'chords') {
      if (!chord || !Array.isArray(chord.voicing) || !chord.voicing.length) continue;
      const mode = lane.selection;
      if (mode === 'pad' && step === 0) ev.push({ laneId: lane.id, type: 'chords', notes: chord.voicing, dur: 'bar' });
      if (mode === 'stab' && (step === 0 || step === spb / 2)) ev.push({ laneId: lane.id, type: 'chords', notes: chord.voicing, dur: 2 });
      if (mode === 'arp') ev.push({ laneId: lane.id, type: 'chords', note: chord.voicing[step % chord.voicing.length], dur: 1 });
    } else if (lane.type === 'melody') {
      if (!lane.pool || !lane.pool[lane.selection]) continue;
      const bars = lane.pool[lane.selection];
      const phrase = (Array.isArray(bars) && bars.length ? bars[bar % bars.length] : null) || [];
      for (const [s, note, dur] of phrase) {
        if (s === step) ev.push({ laneId: lane.id, type: 'melody', note, dur });
      }
    }
  }
  return ev;
}

// Object-shape lanes → list (copy of normalizeLanes essentials).
function laneList(song) {
  if (Array.isArray(song.lanes)) return song.lanes.map(l => ({ ...l }));
  return ['drums', 'bass', 'chords', 'melody'].map(type => ({ id: type, type, ...(song.lanes[type] || {}) }));
}

// Stable, deduped per-step event key. `mode` is intentionally excluded
// (pad vs stab produce identical trigger behaviour for the same notes/dur).
export function eventKey(bar, step, e) {
  return JSON.stringify([bar, step, e.laneId, e.type, e.voice ?? null, e.semi ?? null,
    e.note ?? null, e.notes ?? null, e.dur ?? null]);
}

/**
 * renderLegacyStream(song, {cycles, skipCycles})
 * Simulates song-mode playback bar by bar, including section fills and the
 * engine's post-fill crash flourish. Returns a sorted, deduped array of
 * eventKey strings covering bars [skipCycles*total, cycles*total).
 * skipCycles=1 by default: parity is checked in the steady state because the
 * old engine only fires the wrap-around crash flourish from cycle 2 onward.
 */
export function renderLegacyStream(song, { cycles = 3, skipCycles = 1 } = {}) {
  const lanes = laneList(song);
  const spb = stepsPerBar(song.meter);
  const total = song.arrangement.reduce((n, s) => n + s.bars, 0);
  const out = new Set();
  let activeFill = null;
  for (let bar = 0; bar < total * cycles; bar++) {
    const prevFill = activeFill;
    const at = sectionAt(song.arrangement, bar);
    for (const [typeName, selection] of Object.entries(at.section.lanes)) {
      const lane = lanes.find(l => l.type === typeName);
      if (lane) lane.selection = selection;
    }
    activeFill = at.isLastBar ? (at.section.fill || null) : null;
    const fillPat = activeFill ? (song.fills?.[activeFill] ?? null) : null;
    const emit = bar >= total * skipCycles;
    if (!emit) continue;
    const outBar = bar - total * skipCycles;
    if (prevFill && !activeFill) {
      const dl = lanes.find(l => l.type === 'drums');
      if (dl) out.add(eventKey(outBar, 0, { laneId: dl.id, type: 'drums', voice: 'crash' }));
    }
    for (let step = 0; step < spb; step++) {
      for (const e of eventsForStep(song, lanes, bar * spb + step, fillPat)) {
        out.add(eventKey(outBar, step, e));
      }
    }
  }
  return [...out].sort();
}
```

Note the two deliberate normalizations (both encode real trigger-level equivalences — document them in the file header comment):
1. **`mode` excluded from the key:** `pad`/`stab` chords events trigger identically for identical `notes`+`dur`; `arp` stays distinguishable because it's the only single-`note` chords shape.
2. **Set-dedupe:** the old engine can fire the post-fill crash flourish AND a pattern `crash:[0]` at the same instant (e.g. Kids' NIN section) — two same-time triggers on one NoiseSynth sound as one hit, so set semantics is the honest comparison.

- [ ] **Step 2: Write the sanity test**

```js
// tests/legacy-reference.test.js
import { test, expect } from 'vitest';
import { renderLegacyStream } from './legacy/legacy-engine.js';
import { kids } from '../songs/kids.js';
import { risingSun } from '../songs/rising-sun.js';
import { electricFeel } from '../songs/electric-feel.js';
import { heartbeats } from '../songs/heartbeats.js';
import { digitalLove } from '../songs/digital-love.js';
import { memoryReboot } from '../songs/memory-reboot.js';
import { takeOnMe } from '../songs/take-on-me.js';

const SONGS = { kids, risingSun, electricFeel, heartbeats, digitalLove, memoryReboot, takeOnMe };

for (const [name, song] of Object.entries(SONGS)) {
  test(`legacy stream for ${name} is non-empty and deterministic`, () => {
    const a = renderLegacyStream(song);
    const b = renderLegacyStream(song);
    expect(a.length).toBeGreaterThan(0);
    expect(a).toEqual(b);
  });
}

test('kids steady state contains the post-fill crash flourish at bar 0', () => {
  // glitch fill ends cycle N → crash lands on the wrapped bar 0 of cycle N+1.
  const stream = renderLegacyStream(kids);
  expect(stream.some(k => k.startsWith('[0,0,') && k.includes('"crash"'))).toBe(true);
});
```

- [ ] **Step 3: Run and verify it passes**

Run: `cd ~/Dev/oyster.worktrees/groovebox-patterns-chain/docs/arcade/groovebox && npx vitest run tests/legacy-reference.test.js`
Expected: PASS (8 tests). If a song throws (e.g. a generator needs a field the renderer didn't carry), fix the *renderer copy* to match real engine behaviour — never the song.

- [ ] **Step 4: Run the full suite to confirm nothing else broke**

Run: `npm test` — Expected: all green (this task adds files only).

- [ ] **Step 5: Commit**

```bash
git add tests/legacy tests/legacy-reference.test.js
git commit -m "test(groovebox): frozen legacy reference stream for parity testing"
```

---

### Task 2: Pure v2 logic — `engine/patterns.js`

All Tone-free pattern/chain logic in one new module. TDD each group.

**Files:**
- Create: `engine/patterns.js`
- Test: `tests/patterns.test.js`

The v2 song shape (from the spec):

```js
// song = {
//   title, artist, meter, bpm,
//   lanes: [ { id, type, name, muted, soloed, tone? } ],   // mixer/instrument only
//   patterns: [ { bars: 1|2|4, lanes: { [laneId]: perBarData[] } } ],
//   chain: [patternIndex, ...],                            // INVARIANT length >= 1
//   fills: { name: drumBar }
// }
// perBarData: drums lane → { kick:[steps], snare:[..], hat:[..], crash:[..], tom:[[step,semi],..] }
//             other lanes → [ [step, noteOrNotesArray, durStepsOr'bar'], ... ]
// Arrays may hold MORE bars than `bars` — those are inactive bars (spec: named
// concept; they never play or render, they survive length round-trips).
```

- [ ] **Step 1: Write failing tests for chain math + event resolution**

```js
// tests/patterns.test.js
import { test, expect } from 'vitest';
import {
  totalChainBars, chainBarAt, eventsForStepV2, advanceTarget,
  addPattern, duplicatePattern, removePattern, setPatternBars,
  appendToChain, removeChainAt, moveChain,
  toggleDrumStep, toggleNote, emptyBarFor,
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

test('toggleNote: same note removes, different note replaces (monophonic per step)', () => {
  const s = makeSong();
  toggleNote(s, 0, 'melody', 0, 0, 'C4', 2);
  expect(s.patterns[0].lanes.melody[0]).toEqual([]);
  toggleNote(s, 0, 'melody', 0, 4, 'E4', 2);
  toggleNote(s, 0, 'melody', 0, 4, 'G4', 2);
  expect(s.patterns[0].lanes.melody[0]).toEqual([[4, 'G4', 2]]);
});

test('emptyBarFor returns {} for drums lanes and [] for others', () => {
  expect(emptyBarFor({ type: 'drums' })).toEqual({});
  expect(emptyBarFor({ type: 'melody' })).toEqual([]);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/patterns.test.js` — Expected: FAIL ("Cannot find module '../engine/patterns.js'").

- [ ] **Step 3: Implement `engine/patterns.js`**

```js
// engine/patterns.js — pure v2 pattern/chain logic (Tone-free, unit-tested).
import { laneAudible, drumVoiceAudible, transposeNote, DRUM_KEYS } from './song.js';

export const MAX_PATTERNS = 16;

// ── chain math ────────────────────────────────────────────────────────────────
export function totalChainBars(song) {
  return song.chain.reduce((n, pi) => n + song.patterns[pi].bars, 0) || 1;
}

export function chainBarAt(song, songBar) {
  const total = totalChainBars(song);
  let b = ((songBar % total) + total) % total;
  for (let pos = 0; pos < song.chain.length; pos++) {
    const bars = song.patterns[song.chain[pos]].bars;
    if (b < bars) return { chainPos: pos, patternIdx: song.chain[pos], barInPattern: b };
    b -= bars;
  }
  return { chainPos: 0, patternIdx: song.chain[0], barInPattern: 0 }; // unreachable
}

// ── playback target ───────────────────────────────────────────────────────────
// target: { kind:'chain', pos, barInPattern } | { kind:'pattern', idx, barInPattern }
export function targetPattern(target, song) {
  return target.kind === 'chain' ? song.chain[target.pos] : target.idx;
}

export function advanceTarget(target, song) {
  const bars = song.patterns[targetPattern(target, song)].bars;
  const nextBar = target.barInPattern + 1;
  if (nextBar < bars) return { ...target, barInPattern: nextBar };
  if (target.kind === 'pattern') return { ...target, barInPattern: 0 };
  return { kind: 'chain', pos: (target.pos + 1) % song.chain.length, barInPattern: 0 };
}

// ── event resolution ──────────────────────────────────────────────────────────
export function eventsForStepV2(song, patternIdx, barInPattern, step, fillPat = null, transpose = 0) {
  const pat = song.patterns[patternIdx];
  const ev = [];
  const tr = transpose | 0;
  const T = n => (tr ? transposeNote(n, tr) : n);
  for (const lane of song.lanes) {
    if (!laneAudible(song.lanes, lane)) continue;
    const data = pat.lanes[lane.id];
    if (lane.type === 'drums') {
      const bar = fillPat || (data && data[barInPattern]) || {};
      for (const k of DRUM_KEYS) {
        if (bar[k] && bar[k].includes(step) && drumVoiceAudible(lane, k))
          ev.push({ laneId: lane.id, type: 'drums', voice: k });
      }
      if (bar.tom) {
        for (const [s, semi] of bar.tom) {
          if (s === step && drumVoiceAudible(lane, 'tom'))
            ev.push({ laneId: lane.id, type: 'drums', voice: 'tom', semi: semi ?? 0 });
        }
      }
    } else {
      const notes = (data && data[barInPattern]) || [];
      for (const [s, n, dur] of notes) {
        if (s !== step) continue;
        if (lane.type === 'chords') {
          if (Array.isArray(n)) ev.push({ laneId: lane.id, type: 'chords', mode: 'pad', notes: n.map(T), dur });
          else ev.push({ laneId: lane.id, type: 'chords', mode: 'arp', note: T(n), dur });
        } else {
          ev.push({ laneId: lane.id, type: lane.type, note: T(n), dur });
        }
      }
    }
  }
  return ev;
}

// ── pattern mutations ─────────────────────────────────────────────────────────
export function emptyBarFor(lane) { return lane.type === 'drums' ? {} : []; }

export function addPattern(song) {
  if (song.patterns.length >= MAX_PATTERNS) return null;
  const lanes = {};
  for (const lane of song.lanes) lanes[lane.id] = [emptyBarFor(lane)];
  song.patterns.push({ bars: 1, lanes });
  return song.patterns.length - 1;
}

export function duplicatePattern(song, idx) {
  if (song.patterns.length >= MAX_PATTERNS) return null;
  const src = song.patterns[idx];
  if (!src) return null;
  song.patterns.push(JSON.parse(JSON.stringify(src)));
  return song.patterns.length - 1;
}

export function removePattern(song, idx) {
  if (song.patterns.length <= 1 || !song.patterns[idx]) return false;
  song.patterns.splice(idx, 1);
  song.chain = song.chain.filter(pi => pi !== idx).map(pi => (pi > idx ? pi - 1 : pi));
  if (!song.chain.length) song.chain = [0];        // invariant: never empty
  return true;
}

export function setPatternBars(song, idx, bars) {
  const pat = song.patterns[idx];
  if (!pat || ![1, 2, 4].includes(bars)) return;
  pat.bars = bars;
  // Grow: pad with empty bars up to `bars`. Shrink: retain inactive bars (spec).
  for (const lane of song.lanes) {
    const data = pat.lanes[lane.id] || (pat.lanes[lane.id] = []);
    while (data.length < bars) data.push(emptyBarFor(lane));
  }
}

// ── chain mutations ───────────────────────────────────────────────────────────
export function appendToChain(song, patternIdx) {
  if (!song.patterns[patternIdx]) return;
  song.chain.push(patternIdx);
}

export function removeChainAt(song, pos) {
  if (song.chain.length <= 1) return false;        // invariant: never empty
  if (pos < 0 || pos >= song.chain.length) return false;
  song.chain.splice(pos, 1);
  return true;
}

export function moveChain(song, from, to) {
  if (from < 0 || from >= song.chain.length) return;
  const [x] = song.chain.splice(from, 1);
  song.chain.splice(Math.max(0, Math.min(to, song.chain.length)), 0, x);
}

// ── step edits (used by the editors) ─────────────────────────────────────────
export function toggleDrumStep(song, patternIdx, laneId, voice, barIdx, step) {
  const bar = song.patterns[patternIdx].lanes[laneId][barIdx]
    || (song.patterns[patternIdx].lanes[laneId][barIdx] = {});
  if (voice === 'tom') {
    bar.tom = bar.tom || [];
    const i = bar.tom.findIndex(x => x[0] === step);
    if (i >= 0) bar.tom.splice(i, 1); else bar.tom.push([step, 3]);
  } else {
    bar[voice] = bar[voice] || [];
    const i = bar[voice].indexOf(step);
    if (i >= 0) bar[voice].splice(i, 1); else bar[voice].push(step);
  }
}

export function toggleNote(song, patternIdx, laneId, barIdx, step, note, dur = 2) {
  const arr = song.patterns[patternIdx].lanes[laneId][barIdx]
    || (song.patterns[patternIdx].lanes[laneId][barIdx] = []);
  const i = arr.findIndex(x => x[0] === step);
  if (i >= 0 && arr[i][1] === note) { arr.splice(i, 1); return; }
  if (i >= 0) arr.splice(i, 1);                    // monophonic per step
  arr.push([step, note, dur]);
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/patterns.test.js` — Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add engine/patterns.js tests/patterns.test.js
git commit -m "feat(groovebox): pure v2 pattern/chain logic — chain math, events, mutations"
```

---

### Task 3: Flattener + steady-state parity across all 7 presets

**Files:**
- Create: `engine/flatten.js`
- Create: `tests/helpers/stream.js`
- Test: `tests/flatten-parity.test.js`

- [ ] **Step 1: Write the v2 stream renderer test helper**

```js
// tests/helpers/stream.js
import { stepsPerBar } from '../../engine/meter.js';
import { totalChainBars, chainBarAt, eventsForStepV2 } from '../../engine/patterns.js';
import { eventKey } from '../legacy/legacy-engine.js';

/** Mirror of renderLegacyStream for v2 songs: walk the chain, emit steady-state keys. */
export function renderChainStream(song, { cycles = 3, skipCycles = 1 } = {}) {
  const spb = stepsPerBar(song.meter);
  const total = totalChainBars(song);
  const out = new Set();
  for (let bar = total * skipCycles; bar < total * cycles; bar++) {
    const { patternIdx, barInPattern } = chainBarAt(song, bar);
    const outBar = bar - total * skipCycles;
    for (let step = 0; step < spb; step++) {
      for (const e of eventsForStepV2(song, patternIdx, barInPattern, step, null, 0)) {
        out.add(eventKey(outBar, step, e));
      }
    }
  }
  return [...out].sort();
}
```

- [ ] **Step 2: Write the failing parity test**

```js
// tests/flatten-parity.test.js
import { test, expect } from 'vitest';
import { flattenSong } from '../engine/flatten.js';
import { renderLegacyStream } from './legacy/legacy-engine.js';
import { renderChainStream } from './helpers/stream.js';
import { kids } from '../songs/kids.js';
import { risingSun } from '../songs/rising-sun.js';
import { electricFeel } from '../songs/electric-feel.js';
import { heartbeats } from '../songs/heartbeats.js';
import { digitalLove } from '../songs/digital-love.js';
import { memoryReboot } from '../songs/memory-reboot.js';
import { takeOnMe } from '../songs/take-on-me.js';

const SONGS = { kids, risingSun, electricFeel, heartbeats, digitalLove, memoryReboot, takeOnMe };

for (const [name, song] of Object.entries(SONGS)) {
  test(`flattened ${name} reproduces the legacy note stream (steady state)`, () => {
    const v2 = flattenSong(song);
    expect(renderChainStream(v2)).toEqual(renderLegacyStream(song));
  });

  test(`flattened ${name} satisfies schema invariants`, () => {
    const v2 = flattenSong(song);
    expect(v2.chain.length).toBeGreaterThanOrEqual(1);
    expect(v2.patterns.length).toBeGreaterThanOrEqual(1);
    for (const p of v2.patterns) {
      expect([1, 2, 4]).toContain(p.bars);
      for (const lane of v2.lanes) expect(p.lanes[lane.id].length).toBeGreaterThanOrEqual(p.bars);
    }
    for (const lane of v2.lanes) {
      expect(lane.pool).toBeUndefined();
      expect(lane.selection).toBeUndefined();
    }
    expect(JSON.parse(JSON.stringify(v2))).toBeTruthy();   // fully JSON-serializable
  });
}
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run tests/flatten-parity.test.js` — Expected: FAIL (flatten.js missing).

- [ ] **Step 4: Implement `engine/flatten.js`**

```js
// engine/flatten.js — the READ-ONLY bridge from the legacy rich song format
// (pools / generators / harmony / arrangement) to the explicit patterns+chain
// schema. Nothing else in the app reads the rich format; nothing ever writes it.
// The rich-resolution copies below live here ON PURPOSE — when the presets are
// eventually re-authored as explicit JSON, this whole file is deleted.
import { stepsPerBar } from './meter.js';

const DRUM_SET_KEYS = ['kick', 'snare', 'hat', 'crash'];

function resolveDrumPattern(pattern, bar, cycleLen) {
  if (!Array.isArray(pattern)) return pattern;
  const len = cycleLen ? Math.min(cycleLen, pattern.length) : pattern.length;
  return pattern[((bar % len) + len) % len];
}

function chordAt(progression, bar) {
  const n = progression.length || 1;
  return progression[((bar % n) + n) % n];
}

function sectionAt(arrangement, songBar) {
  const total = arrangement.reduce((n, s) => n + s.bars, 0) || 1;
  let b = ((songBar % total) + total) % total;
  for (let i = 0; i < arrangement.length; i++) {
    const s = arrangement[i];
    if (b < s.bars) return { index: i, section: s, barInSection: b, isLastBar: b === s.bars - 1 };
    b -= s.bars;
  }
  return { index: arrangement.length - 1, section: arrangement[arrangement.length - 1], barInSection: 0, isLastBar: true };
}

function laneList(rich) {
  if (Array.isArray(rich.lanes)) return rich.lanes.map(l => ({ ...l }));
  return ['drums', 'bass', 'chords', 'melody'].map(type => ({ id: type, type, name: type, ...(rich.lanes[type] || {}) }));
}

// Bake one drums bar to explicit {kick,snare,hat,crash,tom} (sorted, deduped).
function bakeDrumBar(pat, addCrash0) {
  const out = {};
  for (const k of DRUM_SET_KEYS) {
    const steps = new Set(pat[k] || []);
    if (k === 'crash' && addCrash0) steps.add(0);
    if (steps.size) out[k] = [...steps].sort((a, b) => a - b);
  }
  if (pat.tom && pat.tom.length) out.tom = pat.tom.map(([s, semi]) => [s, semi ?? 0]).sort((a, b) => a[0] - b[0]);
  return out;
}

// Bake one bar of one lane to explicit per-bar data.
function bakeBar(rich, lane, bar, spb, fillPat, crashFlourish) {
  if (lane.type === 'drums') {
    const pat = fillPat || resolveDrumPattern(lane.pool[lane.selection], bar, lane.cycleLen) || {};
    return bakeDrumBar(pat, crashFlourish);
  }
  const chord = chordAt(rich.harmony.progression, bar);
  if (lane.type === 'bass') {
    const gen = lane.pool?.[lane.selection];
    if (!gen) return [];
    const notes = typeof gen === 'function'
      ? (gen(bar, chord) || [])
      : (Array.isArray(gen) && gen.length ? (gen[bar % gen.length] || []) : []);
    return notes.map(([s, n, d]) => [s, n, d]);
  }
  if (lane.type === 'chords') {
    if (!chord || !Array.isArray(chord.voicing) || !chord.voicing.length) return [];
    const mode = lane.selection;
    if (mode === 'pad')  return [[0, [...chord.voicing], 'bar']];
    if (mode === 'stab') return [[0, [...chord.voicing], 2], [spb / 2, [...chord.voicing], 2]];
    if (mode === 'arp')  return Array.from({ length: spb }, (_, s) => [s, chord.voicing[s % chord.voicing.length], 1]);
    return [];
  }
  if (lane.type === 'melody') {
    const bars = lane.pool?.[lane.selection];
    const phrase = (Array.isArray(bars) && bars.length ? bars[bar % bars.length] : null) || [];
    return phrase.map(([s, n, d]) => [s, n, d]);
  }
  return [];
}

// Greedy chunk sizes for a section that has no 1/2/4 period: [4,4,2,1...]
function chunkSizes(n) {
  const out = [];
  while (n > 0) {
    if (n >= 4) { out.push(4); n -= 4; }
    else if (n >= 2) { out.push(2); n -= 2; }
    else { out.push(1); n -= 1; }
  }
  return out;
}

/** flattenSong(rich) → v2 song. Pure; does not mutate `rich`. */
export function flattenSong(rich) {
  const working = laneList(rich);                                   // selections get driven per bar
  const spb = stepsPerBar(rich.meter);
  const arrangement = rich.arrangement?.length
    ? rich.arrangement
    : [{ bars: 4, lanes: Object.fromEntries(working.map(l => [l.type, l.selection])) }];
  const total = arrangement.reduce((n, s) => n + s.bars, 0);

  // 1. Bake every bar of one full arrangement cycle (steady state: the
  //    post-fill crash flourish is baked wherever it fires from cycle 2 onward,
  //    including the wrap onto bar 0).
  const lastSection = arrangement[arrangement.length - 1];
  const baked = [];                                                 // [bar] = { [laneId]: barData }
  let activeFill = null;
  for (let bar = 0; bar < total; bar++) {
    const prevFill = bar === 0 ? (lastSection.fill || null) : activeFill;   // wrap-aware
    const at = sectionAt(arrangement, bar);
    for (const [typeName, selection] of Object.entries(at.section.lanes)) {
      const lane = working.find(l => l.type === typeName);
      if (lane) lane.selection = selection;
    }
    activeFill = at.isLastBar ? (at.section.fill || null) : null;
    const fillPat = activeFill ? (rich.fills?.[activeFill] ?? null) : null;
    const crashFlourish = !!(prevFill && !activeFill);
    const barData = {};
    for (const lane of working) barData[lane.id] = bakeBar(rich, lane, bar, spb, lane.type === 'drums' ? fillPat : null, crashFlourish);
    baked.push(barData);
  }

  // 2. Section → pattern(s): detect a 1/2/4-bar period, else chunk into ≤4-bar runs.
  const patterns = [];
  const chain = [];
  const seen = new Map();                                           // JSON(pattern) → index
  function pushPattern(bars, barRange) {
    const lanes = {};
    for (const lane of working) lanes[lane.id] = barRange.map(b => baked[b][lane.id]);
    const pat = { bars, lanes };
    const key = JSON.stringify(pat);
    if (seen.has(key)) return seen.get(key);
    patterns.push(pat);
    seen.set(key, patterns.length - 1);
    return patterns.length - 1;
  }
  let offset = 0;
  for (const section of arrangement) {
    const n = section.bars;
    const range = Array.from({ length: n }, (_, i) => offset + i);
    const period = [1, 2, 4].find(P =>
      P <= n && n % P === 0 &&
      range.every(b => JSON.stringify(baked[b]) === JSON.stringify(baked[offset + ((b - offset) % P)])));
    if (period) {
      const idx = pushPattern(period, range.slice(0, period));
      for (let r = 0; r < n / period; r++) chain.push(idx);
    } else {
      let at = 0;
      for (const size of chunkSizes(n)) {
        chain.push(pushPattern(size, range.slice(at, at + size)));
        at += size;
      }
    }
    offset += n;
  }

  // 3. Mixer-only lanes.
  const lanes = working.map(l => ({
    id: l.id, type: l.type, name: l.name || l.id,
    muted: !!l.muted, soloed: !!l.soloed,
    ...(l.type === 'melody' ? { tone: l.tone || 'pulse' } : {}),
  }));

  return {
    title: rich.title, artist: rich.artist, meter: rich.meter, bpm: rich.bpm,
    lanes, patterns, chain, fills: rich.fills || {},
  };
}
```

- [ ] **Step 5: Run the parity tests**

Run: `npx vitest run tests/flatten-parity.test.js` — Expected: PASS (14 tests).

Debugging guidance if a song fails parity (use systematic-debugging; diff the two sorted streams — the first differing key names the bar/step/lane):
- Off-by-one on the wrap crash → check the `prevFill` seeding for `bar === 0`.
- A bass generator that varies with absolute `bar` beyond the section period → the period detector will already have kept distinct bars; if streams still differ, the generator varies *across cycles* (e.g. `bar % 32`) — flag to the user, do not hack around it.
- Chord/melody mismatch only in `dur` → check `'bar'` passes through untouched as a string.

- [ ] **Step 6: Run the full suite, then commit**

Run: `npm test` — Expected: all green.

```bash
git add engine/flatten.js tests/helpers tests/flatten-parity.test.js
git commit -m "feat(groovebox): rich→v2 flattener with steady-state note-stream parity on all 7 presets"
```

---

### Task 4: Lane mutations become pattern-aware (`engine/lanes.js`)

In v2, what a lane *plays* lives in patterns, so adding/duplicating/removing a lane must touch every pattern's data.

**Staging note (keeps this commit green):** this task ONLY rewrites `addLane`/`duplicateLane`/`removeLane` and replaces their test file. The legacy exports (`normalizeLanes`, `cachePoolsByType`, `setLane`, `captureScene`) STAY in `engine/lanes.js` for now — `engine/index.js` and several test files still import them; they are all deleted together in Task 5. Do not touch `tests/lanes.test.js` or `tests/capture.test.js` in this task.

**Files:**
- Modify: `engine/lanes.js` (three functions only)
- Replace: `tests/lane-mutations.test.js`

- [ ] **Step 1: Rewrite the lane-mutation tests for v2 shapes**

Replace the contents of `tests/lane-mutations.test.js` with v2-shaped tests (the old file tests pool/selection plumbing that no longer exists). Keep its structure/test names where behaviour is unchanged (unique ids, unique names, insert-after-source, last-lane guard, moveLane clamping):

```js
// tests/lane-mutations.test.js
import { test, expect } from 'vitest';
import { addLane, duplicateLane, removeLane, renameLane, moveLane, uniqueLaneId } from '../engine/lanes.js';

function makeSong() {
  return {
    lanes: [
      { id: 'drums', type: 'drums', name: 'drums', muted: false, soloed: false },
      { id: 'melody', type: 'melody', name: 'melody', muted: false, soloed: false, tone: 'pulse' },
    ],
    patterns: [
      { bars: 2, lanes: { drums: [{ kick: [0] }, { kick: [8] }], melody: [[[0, 'C4', 2]], []] } },
      { bars: 1, lanes: { drums: [{ hat: [0] }], melody: [[]] } },
    ],
    chain: [0, 1],
    fills: {},
  };
}

test('addLane appends a lane and gives it empty data in EVERY pattern', () => {
  const s = makeSong();
  const lane = addLane(s, 'bass');
  expect(lane.id).toBe('bass');
  expect(s.patterns[0].lanes.bass).toEqual([[], []]);     // bars:2 → 2 empty bars
  expect(s.patterns[1].lanes.bass).toEqual([[]]);
});

test('addLane on a duplicate type gets a fresh id', () => {
  const s = makeSong();
  const lane = addLane(s, 'drums');
  expect(lane.id).toBe('drums-2');
  expect(s.patterns[0].lanes['drums-2']).toEqual([{}, {}]);
});

test('duplicateLane deep-copies the source data in every pattern', () => {
  const s = makeSong();
  const lane = duplicateLane(s, 'drums');
  expect(lane.id).toBe('drums-2');
  expect(s.patterns[0].lanes['drums-2']).toEqual([{ kick: [0] }, { kick: [8] }]);
  s.patterns[0].lanes['drums-2'][0].kick.push(4);
  expect(s.patterns[0].lanes.drums[0].kick).toEqual([0]); // deep copy, not shared
  expect(s.lanes[1].id).toBe('drums-2');                  // inserted after source
});

test('removeLane removes its data from every pattern; last lane is guarded', () => {
  const s = makeSong();
  expect(removeLane(s, 'melody')).toBe('melody');
  expect(s.patterns[0].lanes.melody).toBeUndefined();
  expect(removeLane(s, 'drums')).toBeNull();              // last lane
});

test('renameLane trims and ignores empty; moveLane clamps', () => {
  const s = makeSong();
  renameLane(s, 'drums', '  kit  ');
  expect(s.lanes[0].name).toBe('kit');
  renameLane(s, 'drums', '   ');
  expect(s.lanes[0].name).toBe('kit');
  moveLane(s, 'drums', 99);
  expect(s.lanes[1].id).toBe('drums');
});

test('uniqueLaneId skips taken ids', () => {
  expect(uniqueLaneId([{ id: 'bass' }, { id: 'bass-2' }], 'bass')).toBe('bass-3');
});
```

(Test files that exercise the legacy exports — `tests/lanes.test.js`, `tests/capture.test.js`, `tests/solo.test.js`, `tests/drum-voice.test.js` — are untouched here and swept in Task 5 Step 1.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/lane-mutations.test.js` — Expected: FAIL (addLane still pool-based).

- [ ] **Step 3: Rewrite the mutation half of `engine/lanes.js`**

Replace ONLY the bodies of `addLane`, `duplicateLane`, `removeLane` (everything else — including the legacy exports — stays until Task 5). New implementations:

```js
import { emptyBarFor } from './patterns.js';

/** addLane(song, type) → new mixer-only lane + empty data slots in every pattern. */
export function addLane(song, type) {
  const lanes = song.lanes;
  const lane = {
    id: uniqueLaneId(lanes, type),
    type,
    name: uniqueLaneName(lanes, type),
    muted: false,
    soloed: false,
    ...(type === 'melody' ? { tone: 'pulse' } : {}),
  };
  lanes.push(lane);
  for (const pat of song.patterns) {
    pat.lanes[lane.id] = Array.from({ length: pat.bars }, () => emptyBarFor(lane));
  }
  return lane;
}

/** duplicateLane(song, id) → clone lane + deep-copy its data in every pattern. */
export function duplicateLane(song, id) {
  const lanes = song.lanes;
  const srcIdx = lanes.findIndex(l => l.id === id);
  if (srcIdx < 0) return null;
  const src = lanes[srcIdx];
  const lane = { ...src, id: uniqueLaneId(lanes, src.type), name: uniqueLaneName(lanes, src.name), muted: false, soloed: false };
  lanes.splice(srcIdx + 1, 0, lane);
  for (const pat of song.patterns) {
    pat.lanes[lane.id] = JSON.parse(JSON.stringify(pat.lanes[src.id] ?? []));
  }
  return lane;
}

/** removeLane(song, id) → removed id or null; also drops its pattern data. */
export function removeLane(song, id) {
  const lanes = song.lanes;
  if (lanes.length <= 1) return null;
  const idx = lanes.findIndex(l => l.id === id);
  if (idx < 0) return null;
  lanes.splice(idx, 1);
  for (const pat of song.patterns) delete pat.lanes[id];
  return id;
}
```

- [ ] **Step 4: Run the full suite — it must be green**

Run: `npm test` — Expected: ALL green. The legacy exports are still in place, so nothing else is disturbed; the only behaviour change (lane mutations) had its test file replaced in Step 1. If anything is red, fix it before committing — no red commits.

- [ ] **Step 5: Commit**

```bash
git add tests/lane-mutations.test.js engine/lanes.js
git commit -m "feat(groovebox): lane add/duplicate/remove operate on pattern data"
```

---

### Task 5: Engine core — playback target state machine + new API

**Files:**
- Modify: `engine/index.js`
- Modify: `engine/lanes.js` (delete the legacy exports kept alive in Task 4)
- Modify: `engine/song.js` (delete `resolveDrumPattern`, `hasDrumHit`, `chordAt`)
- Delete: `engine/scheduler.js`, `engine/arrangement.js`
- Test: `tests/engine-api.test.js` (rewrite); delete `tests/scheduler.test.js`, `tests/arrangement.test.js`, `tests/song.test.js`, `tests/capture.test.js`; surgical import/test fixes in `tests/lanes.test.js`, `tests/solo.test.js`, `tests/drum-voice.test.js`

- [ ] **Step 1: Rewrite `tests/engine-api.test.js`**

The engine is mostly a thin Tone wrapper; the unit-testable surface is the API contract on a loaded (flattened) song without calling `play()`:

```js
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
```

**Test-suite sweep — explicit per-file dispositions.** Vitest fails a whole file on one dangling named import, so the import lines matter as much as the test bodies:

- **Delete entirely:** `tests/scheduler.test.js`, `tests/arrangement.test.js` (subjects deleted; chain math covered by `tests/patterns.test.js`), `tests/song.test.js` (all 5 tests target `resolveDrumPattern`/`chordAt`/`hasDrumHit` — nothing would survive), `tests/capture.test.js` (captureScene is gone).
- **`tests/lanes.test.js`:** remove `normalizeLanes` and `captureScene` from the `../engine/lanes.js` import; delete the `import { eventsForStep } from '../engine/scheduler.js'` line entirely; delete the `makeLanes` helper if it calls `normalizeLanes`, plus all tests of `normalizeLanes`, `cachePoolsByType`, `captureScene`, `setLane`, and `eventsForStep`. Keep (rewriting any lane-list construction to plain arrays): the `laneByType` and `laneAudible` tests.
- **`tests/solo.test.js`:** remove `normalizeLanes` from the import; rewrite its `makeLanes` helper to accept a raw lane-list array (its callers can all pass arrays). All solo/mute behaviour tests stay.
- **`tests/drum-voice.test.js`:** remove `normalizeLanes` from the lanes import and delete the `eventsForStep` import line; delete the tests that call `eventsForStep` (4 of them); keep the `toggleDrumMute`/`toggleDrumSolo`/`drumVoiceAudible` tests.
- **`tests/transpose.test.js`, `tests/meter.test.js`:** keep; before committing run `grep -l "eventsForStep\|resolveDrumPattern\|chordAt\|hasDrumHit\|normalizeLanes\|captureScene" tests/*.test.js` — it must return nothing outside `tests/legacy/`-importing files.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/engine-api.test.js` — Expected: FAIL (no `selectPattern` etc.).

- [ ] **Step 3: Modify `engine/index.js`**

Precise edits (the FX/voices/master-chain code is untouched — only sequencing changes):

1. **Imports:** drop `eventsForStep` (scheduler.js), `sectionAt` (arrangement.js), `setLane as _setLane`, `captureScene as _captureScene`, `normalizeLanes`, `cachePoolsByType`. Add:

```js
import { flattenSong } from './flatten.js';
import {
  eventsForStepV2, advanceTarget, targetPattern,
  addPattern as _addPattern, duplicatePattern as _duplicatePattern, removePattern as _removePattern,
  setPatternBars as _setPatternBars, appendToChain as _appendToChain,
  removeChainAt as _removeChainAt, moveChain as _moveChain,
  toggleDrumStep as _toggleDrumStep, toggleNote as _toggleNote,
} from './patterns.js';
```

2. **State:** replace `let mode = 'live', songBar = 0;` with:

```js
  // Playback target — what is driving sound. Chain is the default; clicking a
  // pattern slot while playing temporarily loops it (spec: no modes).
  let target = { kind: 'chain', pos: 0, barInPattern: 0 };
  let pendingTarget = null;      // applied at the next bar boundary
  let chainStart = 0;            // chain position play() starts from
  let editIdx = 0;               // pattern open in the editors
```

3. **`load(s)`:** replace the body's first line with:

```js
      const v2 = (s.patterns && s.chain) ? s : flattenSong(s);
      song = v2;
      editIdx = 0; chainStart = 0; pendingTarget = null;
      target = { kind: 'chain', pos: 0, barInPattern: 0 };
      tempo = (typeof v2.bpm === 'number' && isFinite(v2.bpm)) ? v2.bpm : tempo;
```

(keep the existing voice rebuild loop, it reads `s.lanes` → change to `v2.lanes`).

4. **`play()` scheduler callback:** replace the whole `if (step % spb === 0) { ... }` block with:

```js
        if (step % spb === 0) {
          if (pendingTranspose !== null) { song.transpose = pendingTranspose; pendingTranspose = null; }
          if (step === 0) {
            target = { kind: 'chain', pos: chainStart, barInPattern: 0 };  // play always starts the chain
          } else if (pendingTarget) {
            target = pendingTarget; pendingTarget = null;                  // switch at bar boundary
          } else {
            target = advanceTarget(target, song);
          }
          const prevFill = activeFill;
          activeFill = fillQueue.length ? fillQueue.shift() : pendingFill;
          pendingFill = null;
          if (prevFill && !activeFill) {
            const drumsVoice = voices[laneByType(song.lanes, 'drums')?.id];
            if (drumsVoice) drumsVoice.crash.triggerAttackRelease('8n', t, 0.9);
          }
        }
        const patternIdx = targetPattern(target, song);
        const fillPat = activeFill ? (song.fills?.[activeFill] ?? null) : null;
        for (const ev of eventsForStepV2(song, patternIdx, target.barInPattern, step % spb, fillPat, song.transpose || 0)) {
          const v = voices[ev.laneId];
          if (v) trigger(v, ev, t, sixteenth, barSeconds);
        }
```

(Remove the old `const fillPat = ...; for (const ev of eventsForStep(...))` lines this replaces. Note `eventsForStepV2` now applies transpose — the old per-event transpose lived inside `eventsForStep`.)

5. **`onStep` payload:** replace the `Tone.Draw.schedule` payload with:

```js
          const s = step; const qSnap = fillQueue.slice();
          const tSnap = { kind: target.kind, chainPos: target.kind === 'chain' ? target.pos : -1,
                          patternIdx: targetPattern(target, song), barInPattern: target.barInPattern };
          Tone.Draw.schedule(() => {
            onStepCb({ absStep: s, bar: Math.floor(s / spb), stepInBar: s % spb,
                       fill: activeFill, queue: qSnap, target: tSnap });
          }, t);
```

6. **`stop()`:** add `pendingTarget = null; chainStart = 0; target = { kind: 'chain', pos: 0, barInPattern: 0 };` to the existing resets.

7. **API:** delete `setLane`, `setMode`, `getMode`, `captureScene`, `clearArrangement`. Add:

```js
    // ── patterns + chain ──────────────────────────────────────────────────────
    getPatterns()        { return song ? song.patterns : []; },
    getChain()           { return song ? song.chain : []; },
    getEditPatternIndex(){ return editIdx; },
    selectPattern(i) {
      if (!song || !song.patterns[i]) return;
      editIdx = i;
      if (playing) pendingTarget = { kind: 'pattern', idx: i, barInPattern: 0 };
    },
    playChain(pos) {
      if (!song) return;
      const p = Math.max(0, Math.min(pos, song.chain.length - 1));
      if (playing) pendingTarget = { kind: 'chain', pos: p, barInPattern: 0 };
      else chainStart = p;
    },
    getPlaybackTarget() {
      return { kind: target.kind, chainPos: target.kind === 'chain' ? target.pos : -1,
               patternIdx: song ? targetPattern(target, song) : 0, barInPattern: target.barInPattern,
               pending: !!pendingTarget };
    },
    addPattern()            { return song ? _addPattern(song) : null; },
    duplicatePattern(i)     { return song ? _duplicatePattern(song, i) : null; },
    removePattern(i) {
      if (!song || !_removePattern(song, i)) return false;
      if (editIdx >= song.patterns.length) editIdx = song.patterns.length - 1;
      if (target.kind === 'pattern') target = { kind: 'chain', pos: 0, barInPattern: 0 };
      if (target.kind === 'chain' && target.pos >= song.chain.length) target = { kind: 'chain', pos: 0, barInPattern: 0 };
      pendingTarget = null;
      return true;
    },
    setPatternBars(i, n)    { if (song) _setPatternBars(song, i, n); },
    appendToChain(i)        { if (song) _appendToChain(song, i); },
    removeChainAt(pos) {
      if (!song || !_removeChainAt(song, pos)) return false;
      if (target.kind === 'chain' && target.pos >= song.chain.length) target = { kind: 'chain', pos: 0, barInPattern: 0 };
      return true;
    },
    moveChain(from, to)     { if (song) _moveChain(song, from, to); },
    toggleDrumStep(laneId, voice, barIdx, stepIdx) { if (song) _toggleDrumStep(song, editIdx, laneId, voice, barIdx, stepIdx); },
    toggleNote(laneId, barIdx, stepIdx, note, dur) { if (song) _toggleNote(song, editIdx, laneId, barIdx, stepIdx, note, dur); },
```

8. **`engine/song.js`:** delete `resolveDrumPattern`, `hasDrumHit`, `chordAt` (and their exports). Keep `DRUM_KEYS`, `DRUM_VOICES`, `laneAudible`, `drumVoiceAudible`, `transposeNote`.

9. **`engine/lanes.js`:** now delete the legacy exports kept alive in Task 4 — `normalizeLanes`, `cachePoolsByType`, `setLane`, `captureScene` (their only remaining call-sites are the `index.js` imports removed in item 1).

10. Delete `engine/scheduler.js` and `engine/arrangement.js`.

- [ ] **Step 4: Run engine tests, then full suite**

Run: `npx vitest run tests/engine-api.test.js tests/patterns.test.js tests/flatten-parity.test.js` — Expected: PASS.
Run: `npm test` — Expected: all green (UI files aren't under test). Fix any straggler imports (`grep -rn "scheduler.js\|arrangement.js\|resolveDrumPattern\|hasDrumHit\|chordAt\|captureScene\|setMode\|setLane(" engine/ tests/` must only hit `tests/legacy/` and `engine/flatten.js`, which own their copies).

- [ ] **Step 5: Commit**

```bash
git add -A engine tests
git commit -m "feat(groovebox): engine v2 — chain playback target, bar-boundary switching, patterns API"
```

---### Task 6: UI — PATTERNS module replaces ARRANGEMENT

**Files:**
- Modify: `ui/app.js` (replace `renderArrange` + onStep handler + strips + loadSong)
- Modify: `ui/app.css` (new module styles)

No unit tests exist for UI; verification is the dev server (Task 8) — state that honestly in commits.

- [ ] **Step 1: Replace `renderArrange()` in `ui/app.js`**

Delete `renderArrange()` and `SECTION_COLORS`, replace with (the `#arrange` element id and `SECTION_IDS` entry are KEPT so saved `gb-section-order` layouts keep working):

```js
// ─── PATTERNS module (patterns row + chain row + playback label) ─────────────
let _chainDragFrom = null;

function renderPatterns() {
  const host = document.getElementById('arrange');   // id kept for saved section order
  if (!host) return;
  host.innerHTML = '';
  const patterns = eng.getPatterns();
  const chain = eng.getChain();
  const editIdx = eng.getEditPatternIndex();
  const editPat = patterns[editIdx];

  const head = document.createElement('div');
  head.className = 'arrange-head';
  head.innerHTML = `<span class="albl">PATTERNS</span><span class="pat-playing" id="pat-playing"></span>`;
  host.appendChild(head);

  // Patterns row: slots + length + duplicate/delete for the selected pattern.
  const prow = document.createElement('div');
  prow.className = 'pat-row';
  patterns.forEach((p, i) => {
    const b = document.createElement('button');
    b.className = 'pat-slot' + (i === editIdx ? ' sel' : '');
    b.dataset.idx = i;
    b.textContent = i + 1;
    b.title = 'edit (loops while playing)';
    b.onclick = () => { eng.selectPattern(i); renderPatterns(); refreshVizPattern(); };
    prow.appendChild(b);
  });
  const add = document.createElement('button');
  add.className = 'pat-slot pat-add';
  add.textContent = '＋';
  add.title = 'add pattern';
  add.disabled = patterns.length >= 16;
  add.onclick = () => {
    const idx = eng.addPattern();
    if (idx !== null) { eng.selectPattern(idx); renderPatterns(); refreshVizPattern(); }
  };
  prow.appendChild(add);

  const len = document.createElement('span');
  len.className = 'pat-len';
  len.innerHTML = `<span class="pat-lbl">length</span>` +
    [1, 2, 4].map(n => `<button class="pat-len-btn${editPat?.bars === n ? ' on' : ''}" data-n="${n}">${n}</button>`).join('');
  len.querySelectorAll('.pat-len-btn').forEach(b => b.onclick = () => {
    eng.setPatternBars(editIdx, +b.dataset.n);
    renderPatterns(); refreshVizPattern();
  });
  prow.appendChild(len);

  const dup = document.createElement('button');
  dup.className = 'pat-act'; dup.textContent = '⧉'; dup.title = 'duplicate pattern';
  dup.disabled = patterns.length >= 16;
  dup.onclick = () => {
    const idx = eng.duplicatePattern(editIdx);
    if (idx !== null) { eng.selectPattern(idx); renderPatterns(); refreshVizPattern(); }
  };
  prow.appendChild(dup);

  const del = document.createElement('button');
  del.className = 'pat-act'; del.textContent = '✕'; del.title = 'delete pattern';
  del.disabled = patterns.length <= 1;
  del.onclick = () => { eng.removePattern(editIdx); renderPatterns(); refreshVizPattern(); };
  prow.appendChild(del);
  host.appendChild(prow);

  // Chain row: chips (click = play chain from there; hover-✕ removes; drag reorders) + append.
  const crow = document.createElement('div');
  crow.className = 'chain-row';
  crow.innerHTML = `<span class="pat-lbl">chain</span>`;
  chain.forEach((pi, pos) => {
    const chip = document.createElement('button');
    chip.className = 'chain-chip';
    chip.dataset.pos = pos;
    chip.draggable = true;
    chip.innerHTML = `<span>${pi + 1}</span><span class="chip-x" title="remove">✕</span>`;
    chip.onclick = e => {
      if (e.target.classList.contains('chip-x')) { if (eng.removeChainAt(pos)) renderPatterns(); return; }
      eng.playChain(pos);
      renderPatterns();
    };
    chip.ondragstart = () => { _chainDragFrom = pos; chip.classList.add('dragging'); };
    chip.ondragend = () => { _chainDragFrom = null; chip.classList.remove('dragging'); };
    chip.ondragover = e => { e.preventDefault(); };
    chip.ondrop = e => {
      e.preventDefault();
      if (_chainDragFrom === null || _chainDragFrom === pos) return;
      eng.moveChain(_chainDragFrom, pos);
      renderPatterns();
    };
    crow.appendChild(chip);
  });
  const append = document.createElement('button');
  append.className = 'chain-chip chain-add';
  append.textContent = '＋';
  append.title = 'append selected pattern to chain';
  append.onclick = () => { eng.appendToChain(eng.getEditPatternIndex()); renderPatterns(); };
  crow.appendChild(append);
  host.appendChild(crow);

  updatePatternsPlayback(eng.getPlaybackTarget());
}

// Glow + label + row dimming — called from renderPatterns and every step.
function updatePatternsPlayback(target) {
  const host = document.getElementById('arrange');
  if (!host || !target) return;
  const isPattern = target.kind === 'pattern';
  const prow = host.querySelector('.pat-row');
  const crow = host.querySelector('.chain-row');
  if (prow) prow.classList.toggle('dimmed', !isPattern);
  if (crow) crow.classList.toggle('dimmed', isPattern);
  host.querySelectorAll('.pat-slot').forEach(b => {
    b.classList.toggle('playing', isPattern && +b.dataset.idx === target.patternIdx);
  });
  host.querySelectorAll('.chain-chip').forEach(c => {
    c.classList.toggle('playing', !isPattern && +c.dataset.pos === target.chainPos);
  });
  const lbl = host.querySelector('#pat-playing');
  if (lbl) {
    const chain = eng.getChain();
    lbl.textContent = isPattern
      ? `Playing: Pattern ${target.patternIdx + 1} (loop)`
      : `Playing: Chain · ${chain.map((pi, i) => (i === target.chainPos ? '▸' : '') + (pi + 1)).join(' ')}`;
  }
}

// Tell the viz the edit pattern changed (rebuilds the open editor).
function refreshVizPattern() {
  if (_editingLaneId) activateEditLane(_editingLaneId);
}
```

- [ ] **Step 2: Rewire `mount()`, `loadSong()`, and the onStep handler**

In `mount()`: change `renderArrange();` → `renderPatterns();`.
In `loadSong()`: delete the `eng.setMode('live');` line.
Replace the whole `eng.onStep(...)` handler with:

```js
eng.onStep(({ absStep, bar, stepInBar, fill, queue, target }) => {
  viz.setStep({ absStep, bar, stepInBar, target });
  const fillsHost = document.getElementById('fills');
  if (fillsHost) {
    fillsHost.querySelectorAll('.fillbtn').forEach(btn => {
      btn.classList.toggle('firing', btn.dataset.fill === fill);
    });
    renderChain(queue);
  }
  updatePatternsPlayback(target);
});
```

(The fill-queue `renderChain` is unrelated to the pattern chain — leave its name alone.)

- [ ] **Step 3: Strips become mixer-only**

In `renderStrips()`:
- Delete the `options(lane)` helper, `chordModes` const, and the `const opts = ...` line; in the template replace `<div class="mctl"><select data-lane="${lane.id}">${opts}</select>${tone}</div>` with `<div class="mctl">${tone}</div>`.
- Delete the pattern-select wiring block (`host.querySelectorAll('select[data-lane]').forEach(s => { if (s.dataset.tone !== undefined) return; s.onchange = ... })`). Keep the tone-select wiring.

Also delete the now-unused `import { laneByType } from '../engine/lanes.js';` if nothing in app.js still uses it (grep first).

- [ ] **Step 4: CSS for the PATTERNS module**

Append to `ui/app.css` (reuse the existing theme variables; delete the old `.timeline`/`.tcell`/`#modeBtn` rules and the `.barsel`/`.bsel`/`.cyc` rules which Task 7 orphans):

```css
/* ─── PATTERNS module ─── */
.pat-playing { margin-left: auto; font-size: 11px; color: var(--hot); opacity: .9; }
.pat-row, .chain-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin: 6px 0; transition: opacity .2s; }
.pat-row.dimmed, .chain-row.dimmed { opacity: .45; }
.pat-lbl { font-size: 10px; letter-spacing: .12em; text-transform: uppercase; color: var(--dim); margin-right: 4px; }
.pat-slot { min-width: 34px; height: 30px; border-radius: 6px; border: 1px solid var(--line); background: var(--panel); color: var(--ink); cursor: pointer; }
.pat-slot.sel { background: var(--acc); color: var(--bg); border-color: var(--acc); font-weight: 700; }
.pat-slot.playing { box-shadow: 0 0 8px var(--hot); border-color: var(--hot); }
.pat-add { opacity: .6; }
.pat-len { display: flex; align-items: center; gap: 4px; margin-left: 12px; }
.pat-len-btn { border: 1px solid var(--line); background: var(--panel); color: var(--ink); border-radius: 5px; padding: 3px 9px; cursor: pointer; }
.pat-len-btn.on { border-color: var(--acc); color: var(--acc); }
.pat-act { border: 1px solid var(--line); background: var(--panel); color: var(--ink); border-radius: 5px; padding: 3px 8px; cursor: pointer; margin-left: 4px; }
.chain-chip { display: inline-flex; align-items: center; gap: 5px; min-width: 30px; height: 27px; border-radius: 5px; padding: 0 8px; border: 1px solid var(--line); background: var(--panel); color: var(--ink); cursor: pointer; }
.chain-chip.playing { border-color: var(--hot); color: var(--hot); box-shadow: 0 0 6px var(--hot); }
.chain-chip.dragging { opacity: .4; }
.chain-chip .chip-x { opacity: 0; font-size: 10px; }
.chain-chip:hover .chip-x { opacity: .7; }
.chain-add { opacity: .6; }
```

(`--ink` is verified as the foreground variable in `app.css`. Before pasting, check the `:root` block at the top of `app.css` and substitute the real names for the OTHER variables used above — `--acc`, `--hot`, `--line`, `--panel`, `--dim`, `--bg` — they have not all been verified. Do not invent new variables.)

- [ ] **Step 5: Build check + commit**

Run: `npx vite build` (from `docs/arcade/groovebox/`) — Expected: builds clean (catches import errors; behavioural verification is Task 8).

```bash
git add ui/app.js ui/app.css
git commit -m "feat(groovebox): PATTERNS module — slots, length, chain with playback label; strips mixer-only"
```

---

### Task 7: UI — editors read/write the selected pattern

**Files:**
- Modify: `ui/viz.js`
- Modify: `ui/app.css` (stacked-bar styles; delete barsel/cycle styles if not done in Task 6)

- [ ] **Step 1: Delete the cycle/barsel/fork machinery from `ui/viz.js`**

Remove: `editBars`, `customLen`, `primaryBar()`, `ensureCustom()`, `fork4`, `clonePat` (if now unused — grep), `buildBarSelector()`, the `.bsel`/`.cyc` click wiring in `build()`, the `groove·added` legend, and the `added`/`removed`/`_base` diff-classes in `paint()`. Remove `resolveDrumPattern`/`hasDrumHit` imports (deleted from engine) — the explicit data needs neither.

Add at the top of `makeViz`:

```js
  let lastTarget = null;            // last onStep target payload (playback position)
  function editPattern() { return eng.getPatterns()[eng.getEditPatternIndex()]; }
  function laneBars(L) {            // active bars of the edited pattern for lane L
    const P = editPattern();
    return Array.from({ length: P.bars }, (_, b) => (P.lanes[L.id] && P.lanes[L.id][b]) || (L.type === 'drums' ? {} : []));
  }
```

- [ ] **Step 2: Stacked multi-bar drum grid**

Replace the `view === 'drums'` branch of `build()` with one group of 5 voice rows per active bar (bar label between groups, M/S buttons only on the first group, per-bar cell cache for the fast playhead path):

```js
    if (view === 'drums') {
      const L = getTargetLane();
      const P = editPattern();
      let html = buildBeatHeader(spb);
      for (let b = 0; b < P.bars; b++) {
        if (P.bars > 1) html += `<div class="vbar-lbl">bar ${b + 1}</div>`;
        html += `<div class="vbar" data-bar="${b}">` + DROWS.map(([k, l]) =>
          `<div class="vrow" data-k="${k}"><span class="vl"><span class="vl-lbl">${l}</span></span>${cells(spb)}` +
          (b === 0
            ? `<span class="vr"><button class="dvm" data-voice="${k}" title="mute ${l}">M</button><button class="dvs" data-voice="${k}" title="solo ${l}">S</button></span>`
            : `<span class="vr"></span>`)
          + `</div>`).join('') + `</div>`;
      }
      host.innerHTML = html;

      // Cell clicks → toggle the hit in (bar, step) of the edited pattern.
      host.querySelectorAll('.vbar').forEach(barEl => {
        const b = +barEl.dataset.bar;
        barEl.querySelectorAll('.vrow').forEach(row => {
          const k = row.dataset.k;
          [...row.querySelectorAll('.vc')].forEach((c, i) => c.onclick = () => {
            eng.toggleDrumStep(L.id, k, b, i);
            paint(lastBar, lastStepInBar);
          });
        });
      });

      // Per-voice mute/solo (first group only).
      host.querySelectorAll('.dvm').forEach(btn => {
        btn.onclick = e => { e.stopPropagation(); eng.toggleDrumMute(btn.dataset.voice); paint(lastBar, lastStepInBar); };
      });
      host.querySelectorAll('.dvs').forEach(btn => {
        btn.onclick = e => { e.stopPropagation(); eng.toggleDrumSolo(btn.dataset.voice); paint(lastBar, lastStepInBar); };
      });

      // Cache: _drumVcCache[bar][voice] = [cells] for the fast playhead path.
      _drumVcCache = {};
      _lastDrumNowStep = -1;
      host.querySelectorAll('.vbar').forEach(barEl => {
        const b = +barEl.dataset.bar;
        _drumVcCache[b] = {};
        barEl.querySelectorAll('.vrow').forEach(row => {
          _drumVcCache[b][row.dataset.k] = [...row.querySelectorAll('.vc')];
        });
      });
    }
```

`drumEdit()` is deleted (inlined above via `eng.toggleDrumStep`).

- [ ] **Step 3: Update `paint()` and `setStep()` for the drums view**

`paint()` drums branch — paint hits per bar from explicit data, playhead in the sounding bar only when the sounding pattern IS the edited pattern:

```js
    if (view === 'drums') {
      const L = getTargetLane();
      const bars = laneBars(L);
      const editIdx = eng.getEditPatternIndex();
      const sounding = lastTarget && lastTarget.patternIdx === editIdx ? lastTarget.barInPattern : -1;
      const laneOK = laneAudible(eng.getLanes(), L);
      host.querySelectorAll('.vbar').forEach(barEl => {
        const b = +barEl.dataset.bar;
        const pat = bars[b] || {};
        barEl.querySelectorAll('.vrow').forEach(row => {
          const k = row.dataset.k;
          const audible = laneOK && drumVoiceAudible(L, k);
          row.classList.toggle('silenced', !audible);
          const mBtn = row.querySelector('.dvm');
          const sBtn = row.querySelector('.dvs');
          if (mBtn) mBtn.classList.toggle('muted', !!(L.voiceMute || {})[k]);
          if (sBtn) sBtn.classList.toggle('soloed', !!(L.voiceSolo || {})[k]);
          row.querySelectorAll('.vc').forEach((c, i) => {
            const on = k === 'tom'
              ? !!(pat.tom && pat.tom.some(x => x[0] === i))
              : !!(pat[k] && pat[k].includes(i));
            c.classList.toggle('hit', on);
            c.classList.toggle('now', b === sounding && i === stepInBar);
          });
        });
      });
    }
```

`setStep` signature changes to `setStep({ absStep, bar, stepInBar, target })` (Task 6 already passes this object). Inside: set `lastTarget = target; lastBar = bar; lastStepInBar = stepInBar;`. Drums fast path becomes:

```js
      if (view === 'drums') {
        const editIdx = eng.getEditPatternIndex();
        const visible = target.patternIdx === editIdx;
        const key = visible ? `${target.barInPattern}:${stepInBar}` : null;
        if (key !== _lastDrumNowStep) {
          if (_lastDrumNowStep !== null && _lastDrumNowStep !== -1) {
            const [ob, os] = String(_lastDrumNowStep).split(':').map(Number);
            for (const cells of Object.values(_drumVcCache[ob] || {})) cells[os]?.classList.remove('now');
          }
          if (key) {
            for (const cells of Object.values(_drumVcCache[target.barInPattern] || {})) cells[stepInBar]?.classList.add('now');
          }
          _lastDrumNowStep = key;
        }
      }
```

(The melody/bass/blocks playhead paths: replace `bar * spb + stepInBar` with `target.patternIdx === eng.getEditPatternIndex() ? target.barInPattern * spb + stepInBar : -1`.)

- [ ] **Step 4: Rolls and blocks read pattern data + pattern length**

- `drawRoll`: replace `const totalSteps = 4 * spb` with `const P = editPattern(); const totalSteps = P.bars * spb;` (bar gridline loop bound `4` → `P.bars`). Replace the note-block source `const bars = L.pool[L.selection] || []` / `for (let bi = 0; bi < 4; bi++)` with `const bars = laneBars(L); for (let bi = 0; bi < bars.length; bi++)`. Skip array-note entries (chords don't render here): `if (Array.isArray(noteName)) continue;`.
- `rollClick`: replace the fork-to-custom block and the mutation block with:

```js
    const L = getTargetLane();
    const bar = Math.floor(absStep / spb);
    const st = absStep % spb;
    eng.toggleNote(L.id, bar, st, noteName, 2);
    drawRoll(currentPlayheadAbs());
```

where `currentPlayheadAbs()` is a small helper: `return lastTarget && lastTarget.patternIdx === eng.getEditPatternIndex() ? lastTarget.barInPattern * spbNow() + lastStepInBar : -1;` (`spbNow = () => stepsPerBar(song.meter)`).
- `blocksEdit`: same replacement (`eng.toggleNote(L.id, bar, st, noteName, 2)` then `paintBlocksGrid('melody', ...)`).
- `buildBlocksGrid`/`paintBlocksGrid`: replace `const BARS = 4` with `const BARS = editPattern().bars`; melody hit-set reads `laneBars(L)`; **bass hit-set** replaces the generator-resolution block with the same explicit read (`laneBars(L)` — bass is explicit data now). Bass stays read-only (no click wiring) — making it editable is a natural follow-up, not in scope.
- `drawBassRoll`: replace the generator resolution with explicit data for the bar being shown:

```js
    const L = getTargetLane();
    const bars = laneBars(L);
    const showBar = (lastTarget && lastTarget.patternIdx === eng.getEditPatternIndex()) ? lastTarget.barInPattern : 0;
    const notes = bars[showBar] || [];
```

- `editLane(id)`: delete the `editBars = new Set([0]); customLen = lane.cycleLen || 4;` lines.

- [ ] **Step 5: CSS + build check + commit**

Append to `app.css`:

```css
.vbar-lbl { font-size: 10px; color: var(--dim); letter-spacing: .1em; text-transform: uppercase; margin: 8px 0 2px; }
```

Delete the `.barsel`, `.bsel`, `.cyc` rules (and `.vc.added` / `.vc.removed` if present).

Run: `npx vite build` — Expected: clean. Run `npm test` — Expected: all green.

```bash
git add ui/viz.js ui/app.css
git commit -m "feat(groovebox): editors show all pattern bars — stacked drum grid, pattern-length rolls, direct bar edits"
```

---

### Task 8: Cleanup, full verification, hand-test

**Files:**
- Modify: `dev.html` (if it touches removed APIs), `index.html` (help text)
- Verify: everything

- [ ] **Step 1: Sweep for stragglers**

Run: `grep -rn "setMode\|getMode\|captureScene\|clearArrangement\|cycleLen\|setLane(\|pool\b" --include="*.js" --include="*.html" engine ui dev.html index.html | grep -v flatten.js`
Expected: no hits outside comments. `songs/*.js` still legitimately contain `pool`/`cycleLen`/`selection` (rich format — the flattener's input); do not touch the song files. Check `dev.html` (10 lines) — if it calls a removed API, update it to the v2 equivalent.

- [ ] **Step 2: Update the help modal**

In `index.html`, the help `Controls` section: add `<dt>PATTERNS</dt><dd>Click a pattern to edit it (it loops while playing). Click a chain chip to play the song from there. + adds, ⧉ duplicates.</dd>` after the FILLS row.

- [ ] **Step 3: Full test suite**

Run: `npm test`
Expected: all green, including the 7-preset parity suite. Report the test count.

- [ ] **Step 4: Hand-test against the running app**

Run: `npx vite --port 5180` (background) and open `http://localhost:5180/`. Check, for at least Kids and House of the Rising Sun (6/8, 6-bar sections → 4+2-bar pattern chunks):
1. Play → chain plays; label reads `Playing: Chain · ▸1 …`; chain row lit, patterns row dimmed.
2. Click a pattern slot mid-playback → at the next bar it loops; label flips to `Playing: Pattern N (loop)`; rows swap dimming.
3. Click a chain chip → chain resumes from there at the next bar.
4. Drum editor shows all bars stacked; toggling a hit in bar 2 only affects bar 2; the playhead walks the correct bar group.
5. Length 4→2→4 round-trips bars 3–4 (edit bar 4, shrink, grow, edits intact).
6. Duplicate pattern → edit the copy → original unchanged. Delete guards: last pattern undeletable, last chain chip unremovable.
7. Fills still queue and fire; melody piano-roll/blocks editing works; tempo/key/mute/solo/knobs/song-switching unaffected.
8. Presets *sound* like they did (spot-check against `main` at http://localhost:4173 via `git stash` or a second checkout if unsure — the parity tests are the real guarantee; this is a sanity listen).

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "chore(groovebox): cleanup after patterns+chain — help text, dev harness, stragglers"
```

Then hand back for review (superpowers:finishing-a-development-branch): push + PR against main. PR body should mention: the one deliberate audible change (the post-fill crash flourish is baked into the steady-state data, so it now also sounds on the very first bar-0 of fresh playback; velocity 0.9→0.8 on that flourish), and that bass lanes became explicit data (read-only editor retained — editable bass is a cheap follow-up).

---

## Self-review notes (already applied)

- **Spec coverage:** single-model bridge → Task 5 `load()`; chain invariant → Task 2 mutations + Task 5 guards; inactive bars → Task 2 `setPatternBars` + Task 7 round-trip hand-test; playback label + dimming → Task 6; bar-boundary switching → Task 5 + patterns.test advanceTarget; parity-before-change → Tasks 1/3 ordering; fills untouched → Tasks 5/6 keep queue path; strips mixer-only → Task 6; stacked editors → Task 7.
- **Known deliberate deviations** (surface in PR, not silent): steady-state crash baking (first-bar crash now present on fresh play), crash flourish velocity unification, chords lane loses its pad/stab/arp dropdown (baked into data; chords have no editor), `added/removed` groove-diff highlighting removed with `pool._base`.
- **Type consistency check:** `eng.toggleDrumStep(laneId, voice, barIdx, stepIdx)` (engine) wraps `toggleDrumStep(song, patternIdx, laneId, voice, barIdx, step)` (pure) — argument orders differ by design (engine injects `editIdx`); Task 6/7 call sites use the engine signature. `setStep` payload object is produced in Task 6 Step 2 and consumed in Task 7 Step 3.
