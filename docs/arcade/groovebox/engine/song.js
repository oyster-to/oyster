const DRUM_KEYS = ['kick', 'snare', 'hat', 'crash'];
export const DRUM_VOICES = ['kick', 'snare', 'hat', 'tom', 'crash'];

/**
 * laneAudible(lanes, lane)
 * lanes — the lane list (array)
 * lane  — the lane object to test
 */
export function laneAudible(lanes, lane) {
  const anySolo = lanes.some(l => l.soloed);
  return !lane.muted && (!anySolo || !!lane.soloed);
}

/**
 * drumVoiceAudible(drumsLane, voice)
 * drumsLane — the drums-type lane object
 */
export function drumVoiceAudible(drumsLane, voice) {
  const anySolo = Object.values(drumsLane.voiceSolo || {}).some(Boolean);
  return !(drumsLane.voiceMute || {})[voice] && (!anySolo || !!(drumsLane.voiceSolo || {})[voice]);
}

export { DRUM_KEYS };

export function transposeNote(note, semis) {
  const m = note.match(/^([A-G]#?)(-?\d+)$/); if (!m) return note;
  const N = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
  const i = N.indexOf(m[1]); if (i < 0) return note;
  const t = i + (parseInt(m[2]) + 1) * 12 + semis;
  return N[((t % 12) + 12) % 12] + (Math.floor(t / 12) - 1);
}

// chordAt(progression, bar) — the chord sounding at an absolute bar. The
// progression cycles (one chord per bar); negative bars wrap. Empty/missing
// progression → undefined (caller treats the lane as silent).
export function chordAt(progression, bar) {
  const n = progression?.length || 0;
  if (!n) return undefined;
  return progression[((bar % n) + n) % n];
}

// ── key / scale machinery ──────────────────────────────────────────────────
const PC_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// Pitch-class (0–11) of a note name ('F#3', 'A', 'Bb2', …) or null.
function noteToPc(note) {
  const m = String(note).match(/^([A-G])(#|b)?/);
  if (!m) return null;
  let pc = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[m[1]];
  if (m[2] === '#') pc += 1; else if (m[2] === 'b') pc -= 1;
  return ((pc % 12) + 12) % 12;
}

// Major scale: W-W-H-W-W-W-H. Natural minor: W-H-W-W-H-W-W.
const MAJOR_STEPS = [0, 2, 4, 5, 7, 9, 11];
const MINOR_STEPS = [0, 2, 3, 5, 7, 8, 10];

// scalePitchClasses(key) → Set of the 7 pitch classes for { root, mode }.
// major/natural-minor only; unknown/missing key → empty Set.
export function scalePitchClasses(key) {
  const rootPc = key && key.root != null ? noteToPc(key.root) : null;
  if (rootPc == null) return new Set();
  const steps = key.mode === 'minor' ? MINOR_STEPS : MAJOR_STEPS;
  return new Set(steps.map(s => (rootPc + s) % 12));
}

// inScale(midi, key) — is this midi pitch in the key's scale?
export function inScale(midi, key) {
  return scalePitchClasses(key).has(((midi % 12) + 12) % 12);
}

// snapMidi(midi, key) — nearest in-scale midi. Ties resolve DOWNWARD.
// No usable key → midi unchanged.
export function snapMidi(midi, key) {
  const pcs = scalePitchClasses(key);
  if (!pcs.size) return midi;
  for (let d = 0; d <= 6; d++) {
    if (pcs.has((((midi - d) % 12) + 12) % 12)) return midi - d;   // down wins ties
    if (pcs.has((((midi + d) % 12) + 12) % 12)) return midi + d;
  }
  return midi;
}

// deriveKey(progression) → { root, mode } | null.
// Collects every chord root + voicing pitch-class, scores against all 24
// major/natural-minor scales (overlap count). Highest wins; ties broken toward
// the first chord's root, preferring minor when the first chord name is minor.
export function deriveKey(progression) {
  if (!Array.isArray(progression) || !progression.length) return null;
  const pcs = [];
  for (const c of progression) {
    if (!c) continue;
    const rp = noteToPc(c.root);
    if (rp != null) pcs.push(rp);
    for (const v of (c.voicing || [])) {
      const vp = noteToPc(v);
      if (vp != null) pcs.push(vp);
    }
  }
  if (!pcs.length) return null;
  const firstRootPc = noteToPc(progression[0].root);
  const firstIsMinor = /m(?![a-z])/.test(String(progression[0].name || ''));
  // Score each candidate by [scale overlap, root == first chord, quality match],
  // compared lexicographically — overlap dominates, ties favour the tonic then
  // its quality.
  let best = null, bestKey = [-1, 0, 0];
  for (let root = 0; root < 12; root++) {
    for (const mode of ['major', 'minor']) {
      const set = scalePitchClasses({ root: PC_NAMES[root], mode });
      const overlap = pcs.reduce((n, pc) => n + (set.has(pc) ? 1 : 0), 0);
      const key = [overlap, root === firstRootPc ? 1 : 0, (mode === 'minor') === firstIsMinor ? 1 : 0];
      if (key[0] > bestKey[0] || (key[0] === bestKey[0] && key[1] > bestKey[1])
          || (key[0] === bestKey[0] && key[1] === bestKey[1] && key[2] > bestKey[2])) {
        best = { root: PC_NAMES[root], mode }; bestKey = key;
      }
    }
  }
  return best;
}
