// engine/patterns.js — pure v2 pattern/chain logic (Tone-free, unit-tested).
//
// Grooves model: patterns are combos of named groove references, not inline data.
//   song.grooves  = { [laneId]: { [grooveName]: perBarData[] } }   // named, shared
//   song.patterns = [ { lanes: { [laneId]: grooveName } } ]
// A groove owns its length (its array); at pattern bar b it plays
// groove[b % groove.length]. A pattern's loop length is DERIVED — the longest
// picked groove (see patternBars); shorter grooves cycle underneath.
import { laneAudible, drumVoiceAudible, transposeNote } from './song.js';
import { slotKey } from './instruments.js';

export const MAX_PATTERNS = 16;

// ── chord-relative grooves ────────────────────────────────────────────────────
// A groove is either a plain bars[] array (literal notes) or a chord-relative
// wrapper { relative: true, bars: [[[step, REF, dur], …], …] }. grooveBars(g)
// normalizes to the bars array so length/cycling logic stays shape-agnostic.
export function grooveBars(g) {
  return Array.isArray(g) ? g : (g ? g.bars : undefined);
}

// resolveRef(ref, chord) — resolve a chord-relative reference against a chord
// { root, voicing }. Grammar:
//   'R'        → chord.root
//   'V<i>'     → chord.voicing[i % voicing.length]   (degree, clamped)
//   'V*'       → the whole voicing array
//   any of the above may carry a '+N'/'-N' semitone suffix (e.g. 'R+12',
//   'V2-24', 'V*-12') applied via transposeNote.
// Returns a note string, an array of note strings (for 'V*'), or null
// (invalid ref / missing chord / empty voicing).
export function resolveRef(ref, chord) {
  if (typeof ref !== 'string' || !chord) return null;
  const m = ref.match(/^(R|V\*|V\d+)([+-]\d+)?$/);
  if (!m) return null;
  const base = m[1];
  const semi = m[2] ? parseInt(m[2], 10) : 0;
  const shift = n => (semi ? transposeNote(n, semi) : n);
  if (base === 'R') {
    if (!chord.root) return null;
    return shift(chord.root);
  }
  const voicing = chord.voicing;
  if (!Array.isArray(voicing) || !voicing.length) return null;
  if (base === 'V*') return voicing.map(shift);
  const i = parseInt(base.slice(1), 10);
  return shift(voicing[i % voicing.length]);
}

// patternBars(song, idx) → the pattern's derived duration: the longest groove
// among its picks AND the pattern's own chord count (chords are content — one per
// bar, cycling — so a 1-bar bass figure over 4 chords is a 4-bar pattern).
// Minimum 1.
export function patternBars(song, patternIdx) {
  const pat = song.patterns[patternIdx];
  if (!pat) return 1;
  let max = Math.max(1, pat.chords?.length ?? 0);
  for (const laneId of Object.keys(pat.lanes)) {
    const bars = grooveBars(song.grooves[laneId]?.[pat.lanes[laneId]]);
    if (Array.isArray(bars) && bars.length > max) max = bars.length;
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
// Resolve the raw groove for a lane at a pattern (literal array OR relative
// wrapper). Returns the groove value, or null (missing / empty → silent lane).
function grooveData(song, pat, laneId) {
  const g = song.grooves[laneId]?.[pat.lanes[laneId]];
  const bars = grooveBars(g);
  return (Array.isArray(bars) && bars.length) ? g : null;
}

// grooveFor(song, patternIdx, laneId) → { name, bars } | null
// `bars` is the groove's own per-bar data array — normalized so callers (the
// editors, viz) never see the relative wrapper.
export function grooveFor(song, patternIdx, laneId) {
  const pat = song.patterns[patternIdx];
  if (!pat) return null;
  const name = pat.lanes[laneId];
  const bars = grooveBars(song.grooves[laneId]?.[name]);
  return bars ? { name, bars } : null;
}

// ── event resolution ──────────────────────────────────────────────────────────
// Chord-relative grooves resolve against the pattern's OWN chords: chord =
// pattern.chords[barInPattern % chords.length]. Chords belong to the pattern
// (not a global song clock), so playback is deterministic and loop-stable. A
// pattern with no chords leaves relative-groove lanes silent.
export function eventsForStepV2(song, patternIdx, barInPattern, step, fillPat = null, transpose = 0) {
  const pat = song.patterns[patternIdx];
  const ev = [];
  const tr = transpose | 0;
  const T = n => (tr ? transposeNote(n, tr) : n);
  const chords = pat.chords;
  const chord = (Array.isArray(chords) && chords.length)
    ? chords[((barInPattern % chords.length) + chords.length) % chords.length]
    : null;
  for (const lane of song.lanes) {
    if (!laneAudible(song.lanes, lane)) continue;
    const g = grooveData(song, pat, lane.id);
    if (lane.type === 'drums') {
      const bars = grooveBars(g);
      const bar = fillPat || (bars ? bars[barInPattern % bars.length] : null) || {};
      // Slot-agnostic: keys are canonical GM numbers post-ingest (slotKey also
      // tolerates raw name keys). Steps are numbers, [step, semi] pairs, or
      // lock-carrying [step, lock] / [step, semi, lock] (type-discriminated:
      // number = semi, object = lock). for-in: no per-step allocations.
      for (const k in bar) {
        const steps = bar[k];
        if (!Array.isArray(steps)) continue;
        const note = slotKey(k);
        if (note === null) continue;
        for (let i = 0; i < steps.length; i++) {
          const s = steps[i];
          if (typeof s === 'number') {
            if (s === step && drumVoiceAudible(lane, note))
              ev.push({ laneId: lane.id, type: 'drums', voice: note });
          } else if (Array.isArray(s) && s[0] === step && drumVoiceAudible(lane, note)) {
            const a = s[1];
            // Position 1 is a semitone (number) or a lock (PLAIN object) — never
            // an array (matches the validator + contract). Garbage falls through
            // to no-semi/base, and the lock is read from s[2].
            const isLock = a !== null && typeof a === 'object' && !Array.isArray(a);
            const lock = isLock ? a : s[2];
            const e = isLock
              ? { laneId: lane.id, type: 'drums', voice: note }
              : { laneId: lane.id, type: 'drums', voice: note, semi: typeof a === 'number' ? a : 0 };
            if (lock && typeof lock.v === 'number') e.vel = lock.v;
            ev.push(e);
          }
        }
      }
      continue;
    }
    const bars = grooveBars(g);
    const notes = (bars ? bars[barInPattern % bars.length] : null) || [];
    if (g && g.relative) {
      // Chord-relative: resolve each REF against the pattern's chord for this bar.
      // No chords on the pattern → the lane is silent (resolveRef → null).
      for (const [s, ref, dur, lock] of notes) {
        if (s !== step) continue;
        const resolved = resolveRef(ref, chord);
        if (resolved == null) continue;
        let e;
        if (Array.isArray(resolved)) {
          e = { laneId: lane.id, type: 'chords', mode: 'pad', notes: resolved.map(T), dur };
        } else if (lane.type === 'chords') {
          e = { laneId: lane.id, type: 'chords', mode: 'arp', note: T(resolved), dur };
        } else {
          e = { laneId: lane.id, type: lane.type, note: T(resolved), dur };
        }
        if (lock && typeof lock.v === 'number') e.vel = lock.v;
        ev.push(e);
      }
      continue;
    }
    // Literal groove — untouched behaviour (plus the optional 4th-element lock).
    for (const [s, n, dur, lock] of notes) {
      if (s !== step) continue;
      let e;
      if (lane.type === 'chords') {
        if (Array.isArray(n)) e = { laneId: lane.id, type: 'chords', mode: 'pad', notes: n.map(T), dur };
        else e = { laneId: lane.id, type: 'chords', mode: 'arp', note: T(n), dur };
      } else {
        e = { laneId: lane.id, type: lane.type, note: T(n), dur };
      }
      if (lock && typeof lock.v === 'number') e.vel = lock.v;
      ev.push(e);
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
  song.patterns.push({ lanes: { ...src.lanes }, name: '' });
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

// addGroove(song, laneId, name, value) — register new named groove content for
// a lane (share-import path). value is a groove VALUE: bars[] or, for note
// lanes, { relative: true, bars }. Caller dedupes names; collision → false.
export function addGroove(song, laneId, name, value) {
  if (!song.lanes.some(l => l.id === laneId)) return false;
  const bars = grooveBars(value);
  if (!Array.isArray(bars) || bars.length < 1 || bars.length > 8) return false;
  if (!song.grooves[laneId]) song.grooves[laneId] = {};
  if (song.grooves[laneId][name]) return false;
  song.grooves[laneId][name] = value;
  return true;
}

// ── groove bar count ──────────────────────────────────────────────────────────
// Groove lengths are powers of two (1/2/4/8). This keeps every groove dividing
// the pattern's longest groove cleanly — no audible drift/wrapping.
const MAX_GROOVE_BARS = 8;

/** Set a groove's length to 1|2|4|8 bars. Growing fills by cycling deep copies
 *  of the existing bars (2→4 gives 1,2,1,2); shrinking keeps the front.
 *  Returns the new length, or null (missing groove / invalid n / no-op same length). */
export function setGrooveBars(song, laneId, grooveName, n) {
  const bars = song.grooves[laneId]?.[grooveName];
  // Relative grooves are read-only (no editor yet).
  if (!Array.isArray(bars) || !bars.length) return null;
  if (n !== 1 && n !== 2 && n !== 4 && n !== 8) return null;
  const len = bars.length;
  if (n === len) return null;
  if (n > len) {
    const orig = bars.slice(0, len);
    while (bars.length < n) bars.push(JSON.parse(JSON.stringify(orig[bars.length % len])));
  } else {
    bars.length = n;
  }
  return bars.length;
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
export function setDrumStep(song, laneId, grooveName, barIdx, voice, step, on, pitched) {
  const groove = song.grooves[laneId]?.[grooveName];
  if (!Array.isArray(groove)) return;        // missing or relative (read-only)
  const bar = groove[barIdx] || (groove[barIdx] = {});
  const k = slotKey(voice) ?? voice;         // canonical GM-number keys
  if (bar[k] !== undefined && !Array.isArray(bar[k])) bar[k] = [];   // heal bad data
  // Pitched slots store [step, semi] pairs. Callers pass the kit slot's flag;
  // default preserves the legacy tom behaviour (GM 45).
  if (pitched ?? k === 45) {
    bar[k] = bar[k] || [];
    const i = bar[k].findIndex(x => x[0] === step);
    if (on) { if (i < 0) bar[k].push([step, 3]); }
    else if (i >= 0) bar[k].splice(i, 1);
  } else {
    bar[k] = bar[k] || [];
    // A non-pitched step is a plain number, OR a lock tuple [step, lock] — match
    // both so a locked hit can still be toggled off / isn't duplicated.
    const i = bar[k].findIndex(x => x === step || (Array.isArray(x) && x[0] === step));
    if (on) { if (i < 0) bar[k].push(step); }
    else if (i >= 0) bar[k].splice(i, 1);
  }
}

export function toggleNote(song, laneId, grooveName, barIdx, step, note, dur = 2) {
  const groove = song.grooves[laneId]?.[grooveName];
  if (!Array.isArray(groove)) return;        // missing or relative (read-only)
  const arr = groove[barIdx] || (groove[barIdx] = []);
  const i = arr.findIndex(x => x[0] === step);
  // Deep compare — chords lanes store array notes (['A3','C4']); reference
  // equality would silently fail to toggle them.
  const same = i >= 0 && JSON.stringify(arr[i][1]) === JSON.stringify(note);
  if (same) { arr.splice(i, 1); return; }
  if (i >= 0) arr.splice(i, 1);                    // monophonic per step
  arr.push([step, note, dur]);
}
