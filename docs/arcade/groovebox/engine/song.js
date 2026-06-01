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

export function laneAudible(song, lane) {
  const anySolo = Object.values(song.lanes).some(l => l.soloed);
  const L = song.lanes[lane];
  return !L.muted && (!anySolo || !!L.soloed);
}

export function drumVoiceAudible(song, voice) {
  const dl = song.lanes.drums;
  const anySolo = Object.values(dl.voiceSolo || {}).some(Boolean);
  return !(dl.voiceMute || {})[voice] && (!anySolo || !!(dl.voiceSolo || {})[voice]);
}

export { DRUM_KEYS };
