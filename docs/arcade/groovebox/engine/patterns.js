// engine/patterns.js — pure v2 pattern/chain logic (Tone-free, unit-tested).
import { laneAudible, drumVoiceAudible, transposeNote, DRUM_KEYS } from './song.js';

export const MAX_PATTERNS = 16;

// ── chain math ────────────────────────────────────────────────────────────────
export function totalChainBars(song) {
  return song.chain.reduce((n, pi) => n + song.patterns[pi].bars, 0) || 1;
}

// Precondition: chain entries must index existing patterns; the engine mutation
// APIs maintain this. (Throws if a chain entry references a missing pattern.)
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

// Explicit setter — the multi-bar editor computes the desired state from the
// shown bar, then SETs it (not toggles) across every selected bar.
export function setDrumStep(song, patternIdx, laneId, voice, barIdx, step, on) {
  const bar = song.patterns[patternIdx].lanes[laneId][barIdx]
    || (song.patterns[patternIdx].lanes[laneId][barIdx] = {});
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

export function toggleNote(song, patternIdx, laneId, barIdx, step, note, dur = 2) {
  const arr = song.patterns[patternIdx].lanes[laneId][barIdx]
    || (song.patterns[patternIdx].lanes[laneId][barIdx] = []);
  const i = arr.findIndex(x => x[0] === step);
  // Deep compare — chords lanes store array notes (['A3','C4']); reference
  // equality would silently fail to toggle them.
  const same = i >= 0 && JSON.stringify(arr[i][1]) === JSON.stringify(note);
  if (same) { arr.splice(i, 1); return; }
  if (i >= 0) arr.splice(i, 1);                    // monophonic per step
  arr.push([step, note, dur]);
}
