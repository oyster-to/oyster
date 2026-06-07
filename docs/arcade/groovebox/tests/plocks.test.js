import { test, expect } from 'vitest';
import { eventsForStepV2, setDrumStep, toggleNote } from '../engine/patterns.js';
import { trigger } from '../engine/voices.js';
import { validateSongPayload, validateGroovePayload } from '../registry/validate.js';

const meter44 = { beatsPerBar: 4, beatUnit: 4, stepsPerBeat: 4 };

// Velocity p-locks: a step's optional lock object ({ v }) rides the tuple —
// pitched [s, n, dur, lock], drums [s, lock] | [s, semi, lock] (type-discriminated:
// number = semi, object = lock). Events carry vel; absent lock → no vel.
function makeSong() {
  return {
    meter: meter44,
    lanes: [
      { id: 'drums', type: 'drums', name: 'drums', muted: false, soloed: false },
      { id: 'melody', type: 'melody', name: 'melody', muted: false, soloed: false },
      { id: 'chords', type: 'chords', name: 'chords', muted: false, soloed: false },
      { id: 'bass', type: 'bass', name: 'bass', muted: false, soloed: false },
    ],
    grooves: {
      drums: {
        beat: [{ 42: [0, [4, { v: 0.4 }], 8], 45: [[2, -3], [6, -3, { v: 0.6 }]] }],
      },
      melody: {
        riff: [[[0, 'C4', 2, { v: 0.5 }], [4, 'D4', 2]]],
      },
      chords: {
        pad: [[[0, ['E4', 'G4'], 'bar', { v: 0.7 }]]],
      },
      bass: {
        pump: { relative: true, bars: [[[0, 'R', 2, { v: 0.3 }]]] },
      },
    },
    patterns: [{
      lanes: { drums: 'beat', melody: 'riff', chords: 'pad', bass: 'pump' },
      chords: [{ name: 'Cm', root: 'C2', voicing: ['C3', 'D#3', 'G3'] }],
    }],
    chain: [0],
    fills: {},
  };
}

const at = (song, step) => eventsForStepV2(song, 0, 0, step);
const lane = (evs, id) => evs.find(e => e.laneId === id);

// ── lock parsing → event.vel ──
test('pitched literal step with lock carries vel', () => {
  expect(lane(at(makeSong(), 0), 'melody').vel).toBe(0.5);
});

test('pitched literal step without lock has no vel', () => {
  expect(lane(at(makeSong(), 4), 'melody').vel).toBeUndefined();
});

test('drum step [s, lock] carries vel; plain steps do not', () => {
  const hit = at(makeSong(), 4).find(e => e.type === 'drums' && e.voice === 42);
  expect(hit.vel).toBe(0.4);
  expect(hit.semi).toBeUndefined();
  const plain = at(makeSong(), 0).find(e => e.type === 'drums' && e.voice === 42);
  expect(plain.vel).toBeUndefined();
});

test('pitched drum step [s, semi, lock] carries both semi and vel', () => {
  const hit = at(makeSong(), 6).find(e => e.type === 'drums' && e.voice === 45);
  expect(hit.semi).toBe(-3);
  expect(hit.vel).toBe(0.6);
  const plain = at(makeSong(), 2).find(e => e.type === 'drums' && e.voice === 45);
  expect(plain.semi).toBe(-3);
  expect(plain.vel).toBeUndefined();
});

test('chord pad step with lock carries vel', () => {
  expect(lane(at(makeSong(), 0), 'chords').vel).toBe(0.7);
});

test('relative groove step with lock carries vel through REF resolution', () => {
  expect(lane(at(makeSong(), 0), 'bass').vel).toBe(0.3);
});

test('fill bar drum locks are honoured', () => {
  const fill = { 38: [[8, { v: 1.3 }]] };
  const evs = eventsForStepV2(makeSong(), 0, 0, 8, fill);
  expect(evs.find(e => e.voice === 38).vel).toBe(1.3);
});

// ── editor preservation: edits must not strip other steps' locks ──
test('setDrumStep toggling one step preserves locks on other steps', () => {
  const song = makeSong();
  setDrumStep(song, 'drums', 0, 42, 10, true);   // add step 10
  setDrumStep(song, 'drums', 0, 42, 0, false);   // remove step 0
  expect(at(song, 4).find(e => e.voice === 42).vel).toBe(0.4);
});

test('toggleNote on one step preserves locks on other steps', () => {
  const song = makeSong();
  toggleNote(song, 'melody', 0, 8, 'E4');        // add a note at step 8
  expect(lane(at(song, 0), 'melody').vel).toBe(0.5);
});

// ── trigger: vel multiplies the voice's base velocity, clamped to 0..1 ──
// Unlocked events must pass the base velocity through UNCHANGED (parity).
function fakeSynth() {
  const calls = [];
  return { calls, triggerAttackRelease: (...a) => { calls.push(a); } };
}
const lastVel = synth => synth.calls.at(-1).at(-1);

test('locked noise drum: vel multiplies trig.velocity', () => {
  const synth = fakeSynth();
  const voice = { byNote: { 42: { synth, trig: { sig: 'noise', dur: '16n', velocity: 0.6 } } } };
  trigger(voice, { type: 'drums', voice: 42, vel: 0.5 }, 0, 0.1, 1.6);
  expect(lastVel(synth)).toBeCloseTo(0.3);
});

test('unlocked noise drum passes base velocity through unchanged', () => {
  const synth = fakeSynth();
  const voice = { byNote: { 42: { synth, trig: { sig: 'noise', dur: '16n', velocity: 0.6 } } } };
  trigger(voice, { type: 'drums', voice: 42 }, 0, 0.1, 1.6);
  expect(lastVel(synth)).toBe(0.6);
});

test('locked drum with undefined base velocity treats base as 1', () => {
  const synth = fakeSynth();
  const voice = { byNote: { 36: { synth, trig: { sig: 'note', note: 'C1', dur: '8n', velocity: undefined } } } };
  trigger(voice, { type: 'drums', voice: 36, vel: 0.5 }, 0, 0.1, 1.6);
  expect(lastVel(synth)).toBe(0.5);
});

test('unlocked drum with undefined base velocity stays undefined (parity)', () => {
  const synth = fakeSynth();
  const voice = { byNote: { 36: { synth, trig: { sig: 'note', note: 'C1', dur: '8n', velocity: undefined } } } };
  trigger(voice, { type: 'drums', voice: 36 }, 0, 0.1, 1.6);
  expect(lastVel(synth)).toBeUndefined();
});

test('locked bass: vel multiplies the 0.85 base', () => {
  const synth = fakeSynth();
  trigger({ bass: synth, trig: { velocity: 0.85 } }, { type: 'bass', note: 'C2', dur: 2, vel: 0.4 }, 0, 0.1, 1.6);
  expect(lastVel(synth)).toBeCloseTo(0.34);
});

test('accent lock above 1 clamps the product at 1', () => {
  const synth = fakeSynth();
  trigger({ bass: synth, trig: { velocity: 0.85 } }, { type: 'bass', note: 'C2', dur: 2, vel: 1.5 }, 0, 0.1, 1.6);
  expect(lastVel(synth)).toBe(1);
});

test('locked chord arp: vel multiplies the 0.34 arp base', () => {
  const synth = fakeSynth();
  trigger({ chordSyn: synth, trig: { velocity: 0.3 } }, { type: 'chords', mode: 'arp', note: 'E4', dur: 1, vel: 0.5 }, 0, 0.1, 1.6);
  expect(lastVel(synth)).toBeCloseTo(0.17);
});

test('locked melody: vel multiplies the 0.82 base', () => {
  const synth = fakeSynth();
  trigger({ lead: synth, trig: { velocity: 0.82 } }, { type: 'melody', note: 'C5', dur: 2, vel: 0.5 }, 0, 0.1, 1.6);
  expect(lastVel(synth)).toBeCloseTo(0.41);
});

// ── velocity → brightness: a locked drum hit also moves its filter cutoff ──
// Accent (vel>1) pulls a HIGHPASS down (fuller); ghost (vel<1) pushes it up
// (thinner). Unfiltered slots are volume-only. Cutoff is set at audio time t.
function fakeFilter(type, base) {
  const calls = [];
  return { type, _base: base, frequency: { setValueAtTime: (v, t) => calls.push([v, t]) }, calls };
}
const lastFreq = f => f.calls.at(-1)[0];

test('accent on a highpass-filtered drum lowers the cutoff below base', () => {
  const synth = fakeSynth(), filter = fakeFilter('highpass', 7000);
  const voice = { byNote: { 42: { synth, trig: { sig: 'noise', dur: '32n', velocity: 0.6 }, filter, filterBase: 7000, filterType: 'highpass' } } };
  trigger(voice, { type: 'drums', voice: 42, vel: 1.9 }, 5, 0.1, 1.6);
  expect(lastFreq(filter)).toBeLessThan(7000);
});

test('ghost on a highpass-filtered drum raises the cutoff above base', () => {
  const synth = fakeSynth(), filter = fakeFilter('highpass', 7000);
  const voice = { byNote: { 42: { synth, trig: { sig: 'noise', dur: '32n', velocity: 0.6 }, filter, filterBase: 7000, filterType: 'highpass' } } };
  trigger(voice, { type: 'drums', voice: 42, vel: 0.3 }, 5, 0.1, 1.6);
  expect(lastFreq(filter)).toBeGreaterThan(7000);
});

test('an unlocked hit on a filtered slot resets the cutoff to base (no stuck filter)', () => {
  const synth = fakeSynth(), filter = fakeFilter('highpass', 7000);
  const voice = { byNote: { 42: { synth, trig: { sig: 'noise', dur: '32n', velocity: 0.6 }, filter, filterBase: 7000, filterType: 'highpass' } } };
  trigger(voice, { type: 'drums', voice: 42 }, 5, 0.1, 1.6);
  expect(lastFreq(filter)).toBe(7000);
});

test('brightness is scheduled at the hit time t', () => {
  const synth = fakeSynth(), filter = fakeFilter('highpass', 7000);
  const voice = { byNote: { 42: { synth, trig: { sig: 'noise', dur: '32n', velocity: 0.6 }, filter, filterBase: 7000, filterType: 'highpass' } } };
  trigger(voice, { type: 'drums', voice: 42, vel: 1.5 }, 9, 0.1, 1.6);
  expect(filter.calls.at(-1)[1]).toBe(9);
});

test('a locked hit on an unfiltered slot still fires (volume-only, no crash)', () => {
  const synth = fakeSynth();
  const voice = { byNote: { 36: { synth, trig: { sig: 'note', note: 'C1', dur: '8n', velocity: undefined }, filter: null, filterBase: 0, filterType: null } } };
  expect(() => trigger(voice, { type: 'drums', voice: 36, vel: 0.5 }, 0, 0.1, 1.6)).not.toThrow();
  expect(lastVel(synth)).toBe(0.5);
});

// ── pitched lanes get brightness too: chords modulate their own lowpass
//    (around its 4200 character), bass/melody an OPEN insert (transparent at
//    rest; ghosts darken, accents stay bright). dir: lowpass opens on accent. ──
test('chord accent raises the lowpass cutoff above its base', () => {
  const synth = fakeSynth(), filter = fakeFilter('lowpass', 4200);
  const voice = { chordSyn: synth, trig: { velocity: 0.3 }, toneFilter: filter, toneBase: 4200, toneType: 'lowpass' };
  trigger(voice, { type: 'chords', mode: 'arp', note: 'E4', dur: 1, vel: 1.8 }, 3, 0.1, 1.6);
  expect(lastFreq(filter)).toBeGreaterThan(4200);
});

test('melody ghost lowers the open insert cutoff below base; unlocked resets to base', () => {
  const synth = fakeSynth(), filter = fakeFilter('lowpass', 18000);
  const voice = { lead: synth, trig: { velocity: 0.82 }, toneFilter: filter, toneBase: 18000, toneType: 'lowpass' };
  trigger(voice, { type: 'melody', note: 'C5', dur: 2, vel: 0.3 }, 3, 0.1, 1.6);
  expect(lastFreq(filter)).toBeLessThan(18000);
  trigger(voice, { type: 'melody', note: 'C5', dur: 2 }, 4, 0.1, 1.6);
  expect(lastFreq(filter)).toBe(18000);
});

test('bass brightness is scheduled at the hit time t', () => {
  const synth = fakeSynth(), filter = fakeFilter('lowpass', 18000);
  const voice = { bass: synth, trig: { velocity: 0.85 }, toneFilter: filter, toneBase: 18000, toneType: 'lowpass' };
  trigger(voice, { type: 'bass', note: 'C2', dur: 2, vel: 0.4 }, 7, 0.1, 1.6);
  expect(filter.calls.at(-1)[1]).toBe(7);
});

test('pitched voices without a tone filter still fire (no crash)', () => {
  const synth = fakeSynth();
  const voice = { lead: synth, trig: { velocity: 0.82 } };
  expect(() => trigger(voice, { type: 'melody', note: 'C5', dur: 2, vel: 0.5 }, 0, 0.1, 1.6)).not.toThrow();
  expect(lastVel(synth)).toBeCloseTo(0.41);
});

// ── validator: the lock object is the strict contract surface ──
const groove = bars => ({ laneType: 'melody', meter: meter44, relative: true, bars });

test('groove payload accepts a valid velocity lock', () => {
  expect(validateGroovePayload(groove([[[0, 'R', 2, { v: 0.5 }]]])).ok).toBe(true);
});

test('groove payload rejects a lock with an unknown key', () => {
  expect(validateGroovePayload(groove([[[0, 'R', 2, { v: 0.5, x: 1 }]]])).ok).toBe(false);
});

test('groove payload rejects v out of (0,2]', () => {
  expect(validateGroovePayload(groove([[[0, 'R', 2, { v: 0 }]]])).ok).toBe(false);
  expect(validateGroovePayload(groove([[[0, 'R', 2, { v: 2.5 }]]])).ok).toBe(false);
  expect(validateGroovePayload(groove([[[0, 'R', 2, { v: -1 }]]])).ok).toBe(false);
});

test('groove payload rejects non-number v', () => {
  expect(validateGroovePayload(groove([[[0, 'R', 2, { v: 'loud' }]]])).ok).toBe(false);
});

test('song payload accepts pitched, drum, and tom locks', () => {
  const drumSong = {
    version: 2, title: 'T', artist: 'A', meter: meter44, bpm: 120,
    lanes: [{ id: 'd', type: 'drums', name: 'D', muted: false, soloed: false }],
    grooves: { d: { g: [{ 42: [0, [4, { v: 0.4 }]], 45: [[6, -3, { v: 0.6 }]] }] } },
    patterns: [{ lanes: { d: 'g' } }], chain: [0], fills: {},
  };
  expect(validateSongPayload(drumSong).ok).toBe(true);
});

test('song payload rejects a malformed drum lock', () => {
  const drumSong = {
    version: 2, title: 'T', artist: 'A', meter: meter44, bpm: 120,
    lanes: [{ id: 'd', type: 'drums', name: 'D', muted: false, soloed: false }],
    grooves: { d: { g: [{ 42: [0, [4, { v: 9 }]] }] } },
    patterns: [{ lanes: { d: 'g' } }], chain: [0], fills: {},
  };
  expect(validateSongPayload(drumSong).ok).toBe(false);
});

test('unlocked songs and grooves still validate (additive, no regression)', () => {
  expect(validateGroovePayload(groove([[[0, 'R', 2]]])).ok).toBe(true);
});
