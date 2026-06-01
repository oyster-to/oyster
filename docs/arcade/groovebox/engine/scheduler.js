import { stepsPerBar } from './meter.js';
import { resolveDrumPattern, hasDrumHit, chordAt, DRUM_KEYS, laneAudible } from './song.js';

// Given the song and an absolute grid step, return all events to fire on that step.
export function eventsForStep(song, absStep) {
  const spb = stepsPerBar(song.meter);
  const bar = Math.floor(absStep / spb);
  const step = absStep % spb;
  const chord = chordAt(song.harmony.progression, bar);
  const L = song.lanes, ev = [];

  if (laneAudible(song, 'drums')) {
    const pat = resolveDrumPattern(L.drums.pool[L.drums.selection], bar, L.drums.cycleLen) || {};
    for (const k of DRUM_KEYS) if (hasDrumHit(pat, k, step)) ev.push({ lane:'drums', voice:k });
    if (pat.tom) for (const [s, semi] of pat.tom) if (s === step) ev.push({ lane:'drums', voice:'tom', semi: semi ?? 0 });
  }
  if (laneAudible(song, 'bass')) {
    const gen = L.bass.pool[L.bass.selection];
    const notes = typeof gen === 'function' ? gen(bar, chord) : (gen[bar % gen.length] || []);
    for (const [s, note, dur] of notes) if (s === step) ev.push({ lane:'bass', note, dur });
  }
  if (laneAudible(song, 'chords')) {
    const mode = L.chords.selection;
    if (mode === 'pad' && step === 0) ev.push({ lane:'chords', mode, notes:chord.voicing, dur:'bar' });
    if (mode === 'stab' && (step === 0 || step === spb/2)) ev.push({ lane:'chords', mode, notes:chord.voicing, dur:2 });
    if (mode === 'arp') ev.push({ lane:'chords', mode, note:chord.voicing[step % chord.voicing.length], dur:1 });
  }
  if (laneAudible(song, 'melody')) {
    const bars = L.melody.pool[L.melody.selection];
    const phrase = bars[bar % bars.length] || [];
    for (const [s, note, dur] of phrase) if (s === step) ev.push({ lane:'melody', note, dur });
  }
  return ev;
}
