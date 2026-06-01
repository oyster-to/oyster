import { test, expect } from 'vitest';
import { eventsForStep } from '../engine/scheduler.js';

const song = {
  meter: { beatsPerBar: 4, beatUnit: 4, stepsPerBeat: 4 },
  harmony: { progression: [
    { name:'F#m', root:'F#2', voicing:['F#3','A3','C#4'] },
    { name:'D',   root:'D2',  voicing:['D3','E3','A3'] },
  ]},
  lanes: {
    drums:  { selection:'beat', muted:false, cycleLen:4,
              pool:{ beat:{ kick:[0,8], snare:[4,12] } } },
    bass:   { selection:'roots', muted:false,
              pool:{ roots:(bar,chord)=>[[0,chord.root,2],[8,chord.root,2]] } },
    chords: { selection:'pad', muted:false },
    melody: { selection:'hook', muted:false,
              pool:{ hook:[ [[0,'A4',2]], [[0,'C5',2]] ] } },
  },
};

test('absolute step 0 fires kick + bass + chord-pad + melody on the F#m bar', () => {
  const ev = eventsForStep(song, 0);
  expect(ev).toContainEqual({ lane:'drums', voice:'kick' });
  expect(ev).toContainEqual({ lane:'bass', note:'F#2', dur:2 });
  expect(ev).toContainEqual({ lane:'chords', mode:'pad', notes:['F#3','A3','C#4'], dur:'bar' });
  expect(ev).toContainEqual({ lane:'melody', note:'A4', dur:2 });
});
test('step 4 fires snare, no kick', () => {
  const ev = eventsForStep(song, 4);
  expect(ev.some(e => e.voice === 'snare')).toBe(true);
  expect(ev.some(e => e.voice === 'kick')).toBe(false);
});
test('bar 1 uses the D chord + second melody bar', () => {
  const ev = eventsForStep(song, 16);
  expect(ev).toContainEqual({ lane:'bass', note:'D2', dur:2 });
  expect(ev).toContainEqual({ lane:'melody', note:'C5', dur:2 });
});
test('muted lane fires nothing', () => {
  const s2 = { ...song, lanes: { ...song.lanes, drums: { ...song.lanes.drums, muted: true } } };
  const ev = eventsForStep(s2, 0);
  expect(ev.some(e => e.lane === 'drums')).toBe(false);
});
test('drum lane with missing pool selection does not throw and returns no drum events', () => {
  const s2 = { ...song, lanes: { ...song.lanes, drums: { ...song.lanes.drums, selection: 'nonexistent', muted: false } } };
  let ev;
  expect(() => { ev = eventsForStep(s2, 0); }).not.toThrow();
  expect(ev.some(e => e.lane === 'drums')).toBe(false);
});
test('fillPat overrides selected drum pattern — snare roll fill fires snare at step 0', () => {
  // The selected pattern has kick at 0, not snare; the fill has snare at 0.
  const fillPat = { snare: [0, 8, 9, 10, 11, 12, 13, 14, 15] };
  const ev = eventsForStep(song, 0, fillPat);
  expect(ev.some(e => e.lane === 'drums' && e.voice === 'snare')).toBe(true);
  // The normal kick at step 0 must NOT fire (fill replaces the pattern entirely)
  expect(ev.some(e => e.lane === 'drums' && e.voice === 'kick')).toBe(false);
});
test('fillPat with tom entries fires tom events with semitones', () => {
  const fillPat = { kick: [0], tom: [[8, 7], [9, 5]] };
  const ev8 = eventsForStep(song, 8, fillPat);   // absStep 8 → stepInBar 8
  expect(ev8.some(e => e.lane === 'drums' && e.voice === 'tom' && e.semi === 7)).toBe(true);
  const ev9 = eventsForStep(song, 9, fillPat);
  expect(ev9.some(e => e.lane === 'drums' && e.voice === 'tom' && e.semi === 5)).toBe(true);
});
