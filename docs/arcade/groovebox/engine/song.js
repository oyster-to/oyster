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
