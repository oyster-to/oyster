import { test, expect } from 'vitest';
import { eventsForStep } from '../engine/scheduler.js';
import { normalizeLanes } from '../engine/lanes.js';

const baseSong = {
  meter: { beatsPerBar: 4, beatUnit: 4, stepsPerBeat: 4 },
  harmony: { progression: [
    { name:'F#m', root:'F#2', voicing:['F#3','A3','C#4'] },
    { name:'D',   root:'D2',  voicing:['D3','E3','A3'] },
  ]},
};

function makeSong(lanesObj) {
  return { ...baseSong, lanes: normalizeLanes(lanesObj) };
}

const song = makeSong({
  drums:  { selection:'beat', muted:false, cycleLen:4,
            pool:{ beat:{ kick:[0,8], snare:[4,12] } } },
  bass:   { selection:'roots', muted:false,
            pool:{ roots:(bar,chord)=>[[0,chord.root,2],[8,chord.root,2]] } },
  chords: { selection:'pad', muted:false },
  melody: { selection:'hook', muted:false,
            pool:{ hook:[ [[0,'A4',2]], [[0,'C5',2]] ] } },
});

test('absolute step 0 fires kick + bass + chord-pad + melody on the F#m bar', () => {
  const ev = eventsForStep(song, song.lanes, 0);
  expect(ev).toContainEqual({ laneId:'drums',  type:'drums',  voice:'kick' });
  expect(ev).toContainEqual({ laneId:'bass',   type:'bass',   note:'F#2', dur:2 });
  expect(ev).toContainEqual({ laneId:'chords', type:'chords', mode:'pad', notes:['F#3','A3','C#4'], dur:'bar' });
  expect(ev).toContainEqual({ laneId:'melody', type:'melody', note:'A4', dur:2 });
});

test('step 4 fires snare, no kick', () => {
  const ev = eventsForStep(song, song.lanes, 4);
  expect(ev.some(e => e.voice === 'snare')).toBe(true);
  expect(ev.some(e => e.voice === 'kick')).toBe(false);
});

test('bar 1 uses the D chord + second melody bar', () => {
  const ev = eventsForStep(song, song.lanes, 16);
  expect(ev).toContainEqual({ laneId:'bass',   type:'bass',   note:'D2', dur:2 });
  expect(ev).toContainEqual({ laneId:'melody', type:'melody', note:'C5', dur:2 });
});

test('muted lane fires nothing', () => {
  const s2 = makeSong({ ...song.lanes.reduce((a, l) => ({ ...a, [l.type]: l }), {}), drums: { ...song.lanes.find(l=>l.id==='drums'), muted: true } });
  // Rebuild cleanly
  const s3 = { ...baseSong, lanes: song.lanes.map(l => l.id === 'drums' ? { ...l, muted: true } : l) };
  const ev = eventsForStep(s3, s3.lanes, 0);
  expect(ev.some(e => e.laneId === 'drums')).toBe(false);
});

test('drum lane with missing pool selection does not throw and returns no drum events', () => {
  const s2 = { ...baseSong, lanes: song.lanes.map(l => l.id === 'drums' ? { ...l, selection: 'nonexistent', muted: false } : l) };
  let ev;
  expect(() => { ev = eventsForStep(s2, s2.lanes, 0); }).not.toThrow();
  expect(ev.some(e => e.laneId === 'drums')).toBe(false);
});

test('fillPat overrides selected drum pattern — snare roll fill fires snare at step 0', () => {
  // The selected pattern has kick at 0, not snare; the fill has snare at 0.
  const fillPat = { snare: [0, 8, 9, 10, 11, 12, 13, 14, 15] };
  const ev = eventsForStep(song, song.lanes, 0, fillPat);
  expect(ev.some(e => e.laneId === 'drums' && e.voice === 'snare')).toBe(true);
  // The normal kick at step 0 must NOT fire (fill replaces the pattern entirely)
  expect(ev.some(e => e.laneId === 'drums' && e.voice === 'kick')).toBe(false);
});

test('fillPat with tom entries fires tom events with semitones', () => {
  const fillPat = { kick: [0], tom: [[8, 7], [9, 5]] };
  const ev8 = eventsForStep(song, song.lanes, 8, fillPat);   // absStep 8 → stepInBar 8
  expect(ev8.some(e => e.laneId === 'drums' && e.voice === 'tom' && e.semi === 7)).toBe(true);
  const ev9 = eventsForStep(song, song.lanes, 9, fillPat);
  expect(ev9.some(e => e.laneId === 'drums' && e.voice === 'tom' && e.semi === 5)).toBe(true);
});
