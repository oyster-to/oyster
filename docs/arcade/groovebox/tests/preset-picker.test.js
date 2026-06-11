// tests/preset-picker.test.js — instrument/kit banks, per-lane selection,
// fork-to-Custom, the tone→instrument migration, and registry validation.
import { describe, it, test, expect } from 'vitest';
import {
  SYNTH_PRESETS, DRUM_PRESETS, ALL_INSTRUMENTS, ALL_KITS, DRUM_KITS,
  LEGACY_TONE_PRESET, DEFAULT_KIT, validateInstrument, validateKit,
} from '../engine/instruments.js';
import { addLane, DEFAULT_LANE_INSTRUMENT } from '../engine/lanes.js';
import { createEngine } from '../engine/index.js';
import { kids } from '../songs/kids.js';
import { validateSongPayload } from '../registry/validate.js';
import { SONG_PAYLOAD } from './helpers/registry-fixtures.js';

const VALID_BASS = {
  name: 'My Bass', type: 'bass', engine: 'synth',
  patch: { archetype: 'mono', volume: -8, oscillator: { shape: 'sawtooth' },
    envelope: { attack: 0.01, decay: 0.2, sustain: 0.4, release: 0.2 }, trigger: { velocity: 0.8 } },
};

describe('preset banks', () => {
  it('every synth + drum preset validates', () => {
    for (const [id, inst] of Object.entries(SYNTH_PRESETS)) expect(validateInstrument(inst), id).toBe(true);
    for (const [id, inst] of Object.entries(DRUM_PRESETS)) expect(validateInstrument(inst), id).toBe(true);
  });
  it('ALL_INSTRUMENTS contains the defaults + every preset', () => {
    for (const id of Object.keys(SYNTH_PRESETS)) expect(ALL_INSTRUMENTS[id]).toBeDefined();
    for (const id of Object.keys(DRUM_PRESETS)) expect(ALL_INSTRUMENTS[id]).toBeDefined();
    expect(ALL_INSTRUMENTS['gb-bass']).toBeDefined();
  });
  it('every kit fills the canonical 8 slots and resolves', () => {
    const notes = DEFAULT_KIT.slots.map(s => s.note);
    expect(notes).toEqual([36, 38, 39, 42, 46, 45, 49, 51]);
    for (const [id, k] of Object.entries(ALL_KITS)) {
      expect(validateKit(k, ALL_INSTRUMENTS), id).toBe(true);
      expect(k.slots.map(s => s.note), id).toEqual(notes);
      for (const s of k.slots) expect(ALL_INSTRUMENTS[s.instrument], `${id}/${s.label}`).toBeDefined();
    }
  });
  it('LEGACY_TONE_PRESET maps every old tone to a real melody preset', () => {
    for (const presetId of Object.values(LEGACY_TONE_PRESET)) {
      expect(ALL_INSTRUMENTS[presetId]).toBeDefined();
      expect(ALL_INSTRUMENTS[presetId].type).toBe('melody');
    }
  });
  it('the Kids song plays its own lead preset (not the stock default)', () => {
    const eng = createEngine(); eng.load(kids);
    const melody = eng.getSong().lanes.find(l => l.type === 'melody');
    expect(melody.instrument).toBe('preset-reso-saw');
  });
});

describe('addLane seeds the default preset', () => {
  it('seeds instrument per pitched type; drums use the kit', () => {
    const eng = createEngine(); eng.load(kids);
    const song = eng.getSong();   // v2: lanes array + grooves + patterns
    expect(addLane(song, 'bass').instrument).toBe('gb-bass');
    expect(addLane(song, 'melody').instrument).toBe('gb-lead');
    expect(addLane(song, 'drums').instrument).toBeUndefined();
    expect(DEFAULT_LANE_INSTRUMENT.chords).toBe('gb-chords');
  });
});

function loaded() { const eng = createEngine(); eng.load(kids); return eng; }
const bassLane = eng => eng.getLanes().find(l => l.type === 'bass').id;

describe('per-lane instrument selection + fork-to-Custom', () => {
  test('setLaneInstrument picks a stock preset; unknown id is a no-op', () => {
    const eng = loaded(); const id = bassLane(eng);
    eng.setLaneInstrument(id, 'preset-reese');
    expect(eng.getSong().lanes.find(l => l.id === id).instrument).toBe('preset-reese');
    eng.setLaneInstrument(id, 'does-not-exist');
    expect(eng.getSong().lanes.find(l => l.id === id).instrument).toBe('preset-reese');
  });

  test('setLaneCustom forks to a SONG-LOCAL custom; stock is untouched', () => {
    const eng = loaded(); const id = bassLane(eng);
    eng.setLaneCustom(id, VALID_BASS);
    const song = eng.getSong();
    expect(song.lanes.find(l => l.id === id).instrument).toBe('custom-' + id);
    expect(song.instruments['custom-' + id].name).toBe('My Bass');
    expect(eng.resolveLaneInstrument(id).name).toBe('My Bass');
    // the stock preset object is never mutated
    expect(ALL_INSTRUMENTS['gb-bass'].name).toBe('Oyster Bass');
  });

  test('setLaneCustom rejects a bad patch / unknown lane (no-op)', () => {
    const eng = loaded(); const id = bassLane(eng);
    eng.setLaneCustom(id, VALID_BASS);
    eng.setLaneCustom(id, { not: 'a patch' });
    eng.setLaneCustom('nope', VALID_BASS);
    expect(eng.getSong().instruments['custom-' + id].name).toBe('My Bass');
  });

  test('type mismatch is rejected (a lane only takes its own type)', () => {
    const eng = loaded(); const id = bassLane(eng);
    const before = eng.getSong().lanes.find(l => l.id === id).instrument;
    eng.setLaneInstrument(id, 'preset-square-lead');      // a melody preset on a bass lane
    expect(eng.getSong().lanes.find(l => l.id === id).instrument).toBe(before);
    const melodyPatch = { ...VALID_BASS, type: 'melody' };
    eng.setLaneCustom(id, melodyPatch);                   // a melody patch on a bass lane
    expect(eng.getSong().instruments?.['custom-' + id]).toBeUndefined();
  });
});

describe('tone → instrument migration (load boundary)', () => {
  test('an old song with lane.tone upgrades to lane.instrument', () => {
    const eng = createEngine(); eng.load(kids);
    const v2 = JSON.parse(JSON.stringify(eng.getSong()));
    const mel = v2.lanes.find(l => l.type === 'melody');
    delete mel.instrument; mel.tone = 'square';
    eng.load(v2);
    const after = eng.getSong().lanes.find(l => l.type === 'melody');
    expect(after.tone).toBeUndefined();
    expect(after.instrument).toBe('preset-square-lead');
  });
});

describe('registry validation of song-local instruments', () => {
  it('accepts a song carrying a valid instruments map', () => {
    const payload = { ...SONG_PAYLOAD, instruments: { 'custom-bass': VALID_BASS } };
    expect(validateSongPayload(payload).ok).toBe(true);
  });
  it('rejects an out-of-range custom patch', () => {
    const bad = JSON.parse(JSON.stringify({ ...SONG_PAYLOAD, instruments: { 'custom-bass': VALID_BASS } }));
    bad.instruments['custom-bass'].patch.volume = 999;
    expect(validateSongPayload(bad).ok).not.toBe(true);
  });
  it('rejects a non-object instruments field', () => {
    expect(validateSongPayload({ ...SONG_PAYLOAD, instruments: [] }).ok).not.toBe(true);
  });
  it('rejects ids without the custom- prefix (stock shadowing / proto pollution)', () => {
    expect(validateSongPayload({ ...SONG_PAYLOAD, instruments: { 'gb-bass': VALID_BASS } }).ok).not.toBe(true);
    // __proto__ as an OWN key — how it arrives via JSON.parse on a real payload.
    const proto = JSON.parse(`{"__proto__": ${JSON.stringify(VALID_BASS)}}`);
    expect(validateSongPayload({ ...SONG_PAYLOAD, instruments: proto }).ok).not.toBe(true);
  });
});
