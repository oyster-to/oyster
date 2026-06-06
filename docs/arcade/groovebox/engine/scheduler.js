import { stepsPerBar } from './meter.js';
import { resolveDrumPattern, hasDrumHit, chordAt, DRUM_KEYS, laneAudible, drumVoiceAudible, transposeNote } from './song.js';

// Given the song, lane list, and an absolute grid step, return all events to fire on that step.
// fillPat: optional drum pattern object to use instead of the song's selected drum pattern.
export function eventsForStep(song, lanes, absStep, fillPat = null) {
  const spb = stepsPerBar(song.meter);
  const bar = Math.floor(absStep / spb);
  const step = absStep % spb;
  const chord = chordAt(song.harmony.progression, bar);
  const tr = song.transpose || 0;
  const ev = [];

  for (const lane of lanes) {
    if (!laneAudible(lanes, lane)) continue;

    if (lane.type === 'drums') {
      const pat = fillPat || (resolveDrumPattern(lane.pool[lane.selection], bar, lane.cycleLen) || {});
      for (const k of DRUM_KEYS) {
        if (hasDrumHit(pat, k, step) && drumVoiceAudible(lane, k))
          ev.push({ laneId: lane.id, type: 'drums', voice: k });
      }
      if (pat.tom) {
        for (const [s, semi] of pat.tom) {
          if (s === step && drumVoiceAudible(lane, 'tom'))
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
        if (s === step) ev.push({ laneId: lane.id, type: 'bass', note: tr ? transposeNote(note, tr) : note, dur });
      }
    } else if (lane.type === 'chords') {
      if (!chord || !Array.isArray(chord.voicing) || !chord.voicing.length) continue;
      const mode = lane.selection;
      if (mode === 'pad' && step === 0) ev.push({ laneId: lane.id, type: 'chords', mode, notes: tr ? chord.voicing.map(n => transposeNote(n, tr)) : chord.voicing, dur: 'bar' });
      if (mode === 'stab' && (step === 0 || step === spb / 2)) ev.push({ laneId: lane.id, type: 'chords', mode, notes: tr ? chord.voicing.map(n => transposeNote(n, tr)) : chord.voicing, dur: 2 });
      if (mode === 'arp') ev.push({ laneId: lane.id, type: 'chords', mode, note: tr ? transposeNote(chord.voicing[step % chord.voicing.length], tr) : chord.voicing[step % chord.voicing.length], dur: 1 });
    } else if (lane.type === 'melody') {
      if (!lane.pool || !lane.pool[lane.selection]) continue;
      const bars = lane.pool[lane.selection];
      const phrase = (Array.isArray(bars) && bars.length ? bars[bar % bars.length] : null) || [];
      for (const [s, note, dur] of phrase) {
        if (s === step) ev.push({ laneId: lane.id, type: 'melody', note: tr ? transposeNote(note, tr) : note, dur });
      }
    }
  }
  return ev;
}
