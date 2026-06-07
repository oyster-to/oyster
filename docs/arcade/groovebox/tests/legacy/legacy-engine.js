import { slotKey } from '../../engine/instruments.js';
// tests/legacy/legacy-engine.js
// FROZEN copy of the pre-patterns-redesign engine resolution logic.
// Deliberately duplicated — this is the parity reference; it must stay
// independent of engine/ so refactors there cannot change it.
//
// Deliberate normalizations vs. the live engine:
//   1. `mode` excluded from eventKey: pad/stab chords events trigger identically
//      for identical notes+dur; arp stays distinguishable as the only single-`note`
//      chords shape.
//   2. Set-dedupe: the old engine can fire the flourish crash AND a pattern
//      crash:[0] at the same instant (kids NIN section) — two same-time triggers
//      on one NoiseSynth sound as one hit, so set semantics is the honest comparison.
//   3. mute/solo ignored: reference assumes everything audible.
//   4. transpose=0: no transposition applied; tr branch never taken.

// ─── Verbatim copies from engine/meter.js ────────────────────────────────────

export function stepsPerBar(m) { return m.beatsPerBar * m.stepsPerBeat; }

// ─── Verbatim copies from engine/song.js ─────────────────────────────────────

// Resolve a drum pattern (one-bar object OR array of bars) for a given absolute bar.
// cycleLen lets a custom pattern loop over fewer bars than it stores (e.g. 2 of 4).
function resolveDrumPattern(pattern, bar, cycleLen) {
  if (!Array.isArray(pattern)) return pattern;
  const len = cycleLen ? Math.min(cycleLen, pattern.length) : pattern.length;
  return pattern[((bar % len) + len) % len];
}

const DRUM_KEYS = ['kick', 'snare', 'hat', 'crash'];

function hasDrumHit(pat, k, step) {
  if (k === 'tom') return !!(pat.tom && pat.tom.some(([s]) => s === step));
  return !!(pat[k] && pat[k].includes(step));            // !! so callers never get undefined
}

function chordAt(progression, bar) {
  const n = progression.length || 1;
  return progression[((bar % n) + n) % n];
}

// ─── Verbatim copy from engine/arrangement.js ────────────────────────────────

function sectionAt(arrangement, songBar) {
  const total = arrangement.reduce((n, s) => n + s.bars, 0) || 1;
  let b = ((songBar % total) + total) % total;
  for (let i = 0; i < arrangement.length; i++) {
    const s = arrangement[i];
    if (b < s.bars) return { index: i, section: s, barInSection: b, isLastBar: b === s.bars - 1 };
    b -= s.bars;
  }
  const last = arrangement.length - 1;                       // fallback (shouldn't hit)
  return { index: last, section: arrangement[last], barInSection: 0, isLastBar: true };
}

// ─── Verbatim resolution logic from engine/scheduler.js eventsForStep ────────
// Minus mute/solo (reference assumes everything audible) and minus transpose
// (tr=0, so transposeNote branches never fire).

function eventsForStep(song, lanes, absStep, fillPat = null) {
  const spb = stepsPerBar(song.meter);
  const bar = Math.floor(absStep / spb);
  const step = absStep % spb;
  const chord = chordAt(song.harmony.progression, bar);
  const ev = [];

  for (const lane of lanes) {
    if (lane.type === 'drums') {
      const pat = fillPat || (resolveDrumPattern(lane.pool[lane.selection], bar, lane.cycleLen) || {});
      for (const k of DRUM_KEYS) {
        if (hasDrumHit(pat, k, step))
          ev.push({ laneId: lane.id, type: 'drums', voice: k });
      }
      if (pat.tom) {
        for (const [s, semi] of pat.tom) {
          if (s === step)
            ev.push({ laneId: lane.id, type: 'drums', voice: 'tom', semi: semi ?? 0 });
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
      if (mode === 'pad' && step === 0) ev.push({ laneId: lane.id, type: 'chords', mode, notes: chord.voicing, dur: 'bar' });
      if (mode === 'stab' && (step === 0 || step === spb / 2)) ev.push({ laneId: lane.id, type: 'chords', mode, notes: chord.voicing, dur: 2 });
      if (mode === 'arp') ev.push({ laneId: lane.id, type: 'chords', mode, note: chord.voicing[step % chord.voicing.length], dur: 1 });
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

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Object-shape lanes → list (copy of normalizeLanes essentials).
function laneList(song) {
  if (Array.isArray(song.lanes)) return song.lanes.map(l => ({ ...l }));
  return ['drums', 'bass', 'chords', 'melody'].map(type => ({ id: type, type, ...(song.lanes[type] || {}) }));
}

// Stable, deduped per-step event key. `mode` is intentionally excluded
// (pad vs stab produce identical trigger behaviour for the same notes/dur).
export function eventKey(bar, step, e) {
  // Drum voices compare by canonical GM number: the legacy reference emits
  // names ('kick'), the live engine emits numbers (36) — same identity.
  const voice = e.voice == null ? null : (slotKey(e.voice) ?? e.voice);
  return JSON.stringify([bar, step, e.laneId, e.type, voice, e.semi ?? null,
    e.note ?? null, e.notes ?? null, e.dur ?? null]);
}

// ─── Stream renderer ─────────────────────────────────────────────────────────

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
    // Update selections and activeFill BEFORE the emit guard, so warm-up
    // cycles still advance state correctly.
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
    // Post-fill crash flourish: mirrors engine/index.js scheduleRepeat logic —
    // when a fill bar ends and the next bar is not a fill bar, trigger a crash
    // at step 0 of the new bar. (engine fires it via drumsVoice.crash.triggerAttackRelease)
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
