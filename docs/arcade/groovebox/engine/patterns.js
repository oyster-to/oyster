// engine/patterns.js — pure v2 pattern/chain logic (Tone-free, unit-tested).
//
// Grooves model: patterns are combos of named groove references, not inline data.
//   song.grooves  = { [laneId]: { [grooveName]: perBarData[] } }   // named, shared
//   song.patterns = [ { lanes: { [laneId]: grooveName } } ]
// A groove owns its length (its array); at pattern bar b it plays
// groove[b % groove.length]. A pattern's loop length is DERIVED — the longest
// picked groove (see patternBars); shorter grooves cycle underneath.
import { laneAudible, drumVoiceAudible, transposeNote, DRUM_KEYS } from './song.js';

export const MAX_PATTERNS = 16;

// patternBars(song, idx) → the pattern's derived duration: the longest groove
// among its picks (grooves are 1/2/4 bars; shorter ones cycle). Minimum 1.
export function patternBars(song, patternIdx) {
  const pat = song.patterns[patternIdx];
  if (!pat) return 1;
  let max = 1;
  for (const laneId of Object.keys(pat.lanes)) {
    const g = song.grooves[laneId]?.[pat.lanes[laneId]];
    if (Array.isArray(g) && g.length > max) max = g.length;
  }
  return max;
}

// ── chain math ────────────────────────────────────────────────────────────────
export function totalChainBars(song) {
  return song.chain.reduce((n, pi) => n + patternBars(song, pi), 0) || 1;
}

// Precondition: chain entries must index existing patterns; the engine mutation
// APIs maintain this. (Throws if a chain entry references a missing pattern.)
export function chainBarAt(song, songBar) {
  const total = totalChainBars(song);
  let b = ((songBar % total) + total) % total;
  for (let pos = 0; pos < song.chain.length; pos++) {
    const bars = patternBars(song, song.chain[pos]);
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
  const bars = patternBars(song, targetPattern(target, song));
  const nextBar = target.barInPattern + 1;
  if (nextBar < bars) return { ...target, barInPattern: nextBar };
  if (target.kind === 'pattern') return { ...target, barInPattern: 0 };
  return { kind: 'chain', pos: (target.pos + 1) % song.chain.length, barInPattern: 0 };
}

// ── groove resolution ───────────────────────────────────────────────────────
// Resolve the groove data array for a lane at a pattern. Returns the array or
// null (missing groove / empty → silent lane).
function grooveData(song, pat, laneId) {
  const name = pat.lanes[laneId];
  const g = song.grooves[laneId]?.[name];
  return (Array.isArray(g) && g.length) ? g : null;
}

// grooveFor(song, patternIdx, laneId) → { name, bars } | null
// `bars` is the groove's own data array (named `bars` per the rework contract).
export function grooveFor(song, patternIdx, laneId) {
  const pat = song.patterns[patternIdx];
  if (!pat) return null;
  const name = pat.lanes[laneId];
  const data = song.grooves[laneId]?.[name];
  return data ? { name, bars: data } : null;
}

// ── event resolution ──────────────────────────────────────────────────────────
export function eventsForStepV2(song, patternIdx, barInPattern, step, fillPat = null, transpose = 0) {
  const pat = song.patterns[patternIdx];
  const ev = [];
  const tr = transpose | 0;
  const T = n => (tr ? transposeNote(n, tr) : n);
  for (const lane of song.lanes) {
    if (!laneAudible(song.lanes, lane)) continue;
    const g = grooveData(song, pat, lane.id);
    if (lane.type === 'drums') {
      const bar = fillPat || (g ? g[barInPattern % g.length] : null) || {};
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
      const notes = (g ? g[barInPattern % g.length] : null) || [];
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

// addPattern(song, fromIdx) — clone the picks of patterns[fromIdx] (groove refs
// shared). An empty combo would be silence, so we always clone an existing one.
export function addPattern(song, fromIdx = 0) {
  if (song.patterns.length >= MAX_PATTERNS) return null;
  const src = song.patterns[fromIdx] || song.patterns[0];
  if (!src) return null;
  song.patterns.push({ lanes: { ...src.lanes } });
  return song.patterns.length - 1;
}

// duplicatePattern is the same affordance as addPattern (clone the picks).
export const duplicatePattern = addPattern;

export function removePattern(song, idx) {
  if (song.patterns.length <= 1 || !song.patterns[idx]) return false;
  song.patterns.splice(idx, 1);
  song.chain = song.chain.filter(pi => pi !== idx).map(pi => (pi > idx ? pi - 1 : pi));
  if (!song.chain.length) song.chain = [0];        // invariant: never empty
  return true;
}

// ── groove pick / lookup ──────────────────────────────────────────────────────
// setLaneGroove(song, patternIdx, laneId, grooveName) — set the edit pattern's
// pick for a lane. Validates the groove exists.
export function setLaneGroove(song, patternIdx, laneId, grooveName) {
  const pat = song.patterns[patternIdx];
  if (!pat) return false;
  if (!song.grooves[laneId]?.[grooveName]) return false;
  pat.lanes[laneId] = grooveName;
  return true;
}

// ── groove bar count ──────────────────────────────────────────────────────────
// Groove lengths are powers of two (1/2/4/8). This keeps every groove dividing
// the pattern's longest groove cleanly — no audible drift/wrapping.
const MAX_GROOVE_BARS = 8;

// doubleGroove(song, laneId, grooveName) — double the groove's length by appending
// a DEEP copy of ALL its current bars (2 bars → 1,2,1,2). Returns the new length,
// or null when the result would exceed 8 / when the groove is missing.
export function doubleGroove(song, laneId, grooveName) {
  const groove = song.grooves[laneId]?.[grooveName];
  if (!Array.isArray(groove) || !groove.length) return null;
  if (groove.length * 2 > MAX_GROOVE_BARS) return null;
  const copy = JSON.parse(JSON.stringify(groove));
  groove.push(...copy);
  return groove.length;
}

// halveGroove(song, laneId, grooveName) — keep the first half. Returns the new
// length, or null at min 1 / when the groove is missing. Defensive: a legacy
// odd length (e.g. 3 from earlier sessions) rounds down to the next power of two
// below (3 → 2).
export function halveGroove(song, laneId, grooveName) {
  const groove = song.grooves[laneId]?.[grooveName];
  if (!Array.isArray(groove) || groove.length <= 1) return null;
  const target = groove.length % 2 === 0
    ? groove.length / 2
    : Math.pow(2, Math.floor(Math.log2(groove.length)));   // odd → next pow2 below
  groove.length = target;
  return groove.length;
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

// ── step edits (used by the editors) — write into GROOVES ─────────────────────
// barIdx is within the referenced groove's own length; the caller guarantees range.
export function setDrumStep(song, laneId, grooveName, barIdx, voice, step, on) {
  const groove = song.grooves[laneId]?.[grooveName];
  if (!groove) return;
  const bar = groove[barIdx] || (groove[barIdx] = {});
  if (voice === 'tom') {
    bar.tom = bar.tom || [];
    const i = bar.tom.findIndex(x => x[0] === step);
    if (on) { if (i < 0) bar.tom.push([step, 3]); }
    else if (i >= 0) bar.tom.splice(i, 1);
  } else {
    bar[voice] = bar[voice] || [];
    const i = bar[voice].indexOf(step);
    if (on) { if (i < 0) bar[voice].push(step); }
    else if (i >= 0) bar[voice].splice(i, 1);
  }
}

export function toggleNote(song, laneId, grooveName, barIdx, step, note, dur = 2) {
  const groove = song.grooves[laneId]?.[grooveName];
  if (!groove) return;
  const arr = groove[barIdx] || (groove[barIdx] = []);
  const i = arr.findIndex(x => x[0] === step);
  // Deep compare — chords lanes store array notes (['A3','C4']); reference
  // equality would silently fail to toggle them.
  const same = i >= 0 && JSON.stringify(arr[i][1]) === JSON.stringify(note);
  if (same) { arr.splice(i, 1); return; }
  if (i >= 0) arr.splice(i, 1);                    // monophonic per step
  arr.push([step, note, dur]);
}
