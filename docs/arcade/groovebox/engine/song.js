// Resolve a drum pattern (one-bar object OR array of bars) for a given absolute bar.
// cycleLen lets a custom pattern loop over fewer bars than it stores (e.g. 2 of 4).
export function resolveDrumPattern(pattern, bar, cycleLen) {
  if (!Array.isArray(pattern)) return pattern;
  const len = cycleLen ? Math.min(cycleLen, pattern.length) : pattern.length;
  return pattern[((bar % len) + len) % len];
}

const DRUM_KEYS = ['kick', 'snare', 'hat', 'crash'];
export const DRUM_VOICES = ['kick', 'snare', 'hat', 'tom', 'crash'];

export function hasDrumHit(pat, k, step) {
  if (k === 'tom') return !!(pat.tom && pat.tom.some(([s]) => s === step));
  return !!(pat[k] && pat[k].includes(step));            // !! so callers never get undefined
}

export function chordAt(progression, bar) {
  const n = progression.length || 1;
  return progression[((bar % n) + n) % n];
}

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
