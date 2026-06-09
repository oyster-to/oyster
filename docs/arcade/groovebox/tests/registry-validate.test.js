import { describe, it, expect } from 'vitest';
import { validateCreate, validateUpdate, validateSongPayload, validateGroovePayload, KIND_VERSIONS }
  from '../registry/validate.js';
import { createEngine } from '../engine/index.js';
import { kids } from '../songs/kids.js';
import { risingSun } from '../songs/rising-sun.js';
import { electricFeel } from '../songs/electric-feel.js';
import { heartbeats } from '../songs/heartbeats.js';
import { digitalLove } from '../songs/digital-love.js';
import { memoryReboot } from '../songs/memory-reboot.js';
import { takeOnMe } from '../songs/take-on-me.js';

import { GROOVE_PAYLOAD, SONG_PAYLOAD } from './helpers/registry-fixtures.js';
const CREATE = (over = {}) => ({
  kind: 'groove', schema_version: 1, name: 'amen-ish', author: 'Henry',
  payload: GROOVE_PAYLOAD, ...over,
});

describe('validateCreate — record fields', () => {
  it('accepts a valid groove create', () => expect(validateCreate(CREATE()).ok).toBe(true));
  it('accepts a valid song create', () =>
    expect(validateCreate(CREATE({ kind: 'song', schema_version: 2, payload: SONG_PAYLOAD })).ok).toBe(true));
  it('rejects unknown kind', () => expect(validateCreate(CREATE({ kind: 'sample' })).ok).toBe(false));
  it('rejects wrong per-kind schema_version', () => {
    expect(validateCreate(CREATE({ schema_version: 2 })).ok).toBe(false);          // groove must be 1
    expect(validateCreate(CREATE({ kind: 'song', schema_version: 1, payload: SONG_PAYLOAD })).ok).toBe(false); // song must be 2
    expect(KIND_VERSIONS).toEqual({ song: 2, groove: 1 });
  });
  it('rejects missing schema_version', () => {
    const b = CREATE(); delete b.schema_version;
    expect(validateCreate(b).ok).toBe(false);
  });
  it('caps name at 80 and author at 40', () => {
    expect(validateCreate(CREATE({ name: 'x'.repeat(80) })).ok).toBe(true);
    expect(validateCreate(CREATE({ name: 'x'.repeat(81) })).ok).toBe(false);
    expect(validateCreate(CREATE({ author: 'x'.repeat(40) })).ok).toBe(true);
    expect(validateCreate(CREATE({ author: 'x'.repeat(41) })).ok).toBe(false);
  });
  it('requires non-empty name; author optional', () => {
    expect(validateCreate(CREATE({ name: '' })).ok).toBe(false);
    const b = CREATE(); delete b.author;
    expect(validateCreate(b).ok).toBe(true);
  });
  it('rejects unknown top-level body keys', () =>
    expect(validateCreate(CREATE({ likes: 9000 })).ok).toBe(false));
  it('validates remix_of shape when present', () => {
    expect(validateCreate(CREATE({ remix_of: 'abcd1234' })).ok).toBe(true);
    expect(validateCreate(CREATE({ remix_of: 'NOPE' })).ok).toBe(false);
  });
  it('rejects oversized payload (>64KB)', () => {
    const big = { ...GROOVE_PAYLOAD, extensions: { pad: Array.from({ length: 70 }, () => 'y'.repeat(1000)) } };
    expect(validateCreate(CREATE({ payload: big })).ok).toBe(false);
  });
  it('rejects any single string >1KB anywhere in payload (audio smuggling)', () => {
    const sneaky = { ...GROOVE_PAYLOAD, extensions: { blob: 'A'.repeat(2000) } };
    expect(validateCreate(CREATE({ payload: sneaky })).ok).toBe(false);
  });
});

describe('validateUpdate', () => {
  const UPDATE = (over = {}) => ({ editKey: 'k'.repeat(43), name: 'n', author: '', payload: GROOVE_PAYLOAD, ...over });
  it('accepts a valid update', () => expect(validateUpdate(UPDATE(), 'groove', 1).ok).toBe(true));
  it('requires editKey', () => {
    const b = UPDATE(); delete b.editKey;
    expect(validateUpdate(b, 'groove', 1).ok).toBe(false);
  });
  it('rejects identity fields in body (id, kind, remix_of, schema_version, timestamps)', () => {
    for (const k of ['id', 'kind', 'remix_of', 'schema_version', 'created_at', 'updated_at', 'edit_key_hash'])
      expect(validateUpdate(UPDATE({ [k]: 'x' }), 'groove', 1).ok).toBe(false);
  });
  it('payload re-validated against the ROW kind, not anything client-sent', () =>
    expect(validateUpdate(UPDATE({ payload: SONG_PAYLOAD }), 'groove', 1).ok).toBe(false));
});

describe('validateSongPayload — invariants', () => {
  const song = () => JSON.parse(JSON.stringify(SONG_PAYLOAD));
  it('accepts the minimal song', () => expect(validateSongPayload(song()).ok).toBe(true));
  it('rejects unknown top-level song keys (extensions is the only hatch)', () => {
    expect(validateSongPayload({ ...song(), extensions: {} }).ok).toBe(true);
    expect(validateSongPayload({ ...song(), swing: 0.2 }).ok).toBe(false);
  });
  it('accepts optional key {root, mode}, rejects malformed key', () => {
    expect(validateSongPayload({ ...song(), key: { root: 'A', mode: 'major' } }).ok).toBe(true);
    expect(validateSongPayload({ ...song(), key: 'A major' }).ok).toBe(false);
  });
  it('accepts optional pattern.name, rejects non-string or oversized', () => {
    const s = song(); s.patterns[0].name = 'Verse';
    expect(validateSongPayload(s).ok).toBe(true);
    const s2 = song(); s2.patterns[0].name = 123;
    expect(validateSongPayload(s2).ok).toBe(false);
    const s3 = song(); s3.patterns[0].name = 'x'.repeat(81);   // > NAME_MAX (80)
    expect(validateSongPayload(s3).ok).toBe(false);
  });
  it('rejects empty chain and out-of-range chain entries', () => {
    expect(validateSongPayload({ ...song(), chain: [] }).ok).toBe(false);
    expect(validateSongPayload({ ...song(), chain: [1] }).ok).toBe(false);   // only pattern 0 exists
  });
  it('rejects pattern picks that do not resolve', () => {
    const s = song(); s.patterns[0].lanes.drums = 'ghost';
    expect(validateSongPayload(s).ok).toBe(false);
  });
  it('rejects >16 patterns and groove bars >8', () => {
    const s = song(); s.patterns = Array.from({ length: 17 }, () => ({ lanes: { drums: 'main' } }));
    expect(validateSongPayload(s).ok).toBe(false);
    const s2 = song(); s2.grooves.drums.main = Array.from({ length: 9 }, () => ({ kick: [0] }));
    expect(validateSongPayload(s2).ok).toBe(false);
  });
  it('rejects duplicate lane ids and grooves for unknown lanes', () => {
    const s = song(); s.lanes.push({ ...s.lanes[0] });
    expect(validateSongPayload(s).ok).toBe(false);
    const s2 = song(); s2.grooves.ghost = { main: [{ kick: [0] }] };
    expect(validateSongPayload(s2).ok).toBe(false);
  });
});

describe('validateGroovePayload — edge cases', () => {
  it('rejects bad laneType / meter / bars', () => {
    expect(validateGroovePayload({ ...GROOVE_PAYLOAD, laneType: 'vocals' }).ok).toBe(false);
    expect(validateGroovePayload({ ...GROOVE_PAYLOAD, meter: { beatsPerBar: 4 } }).ok).toBe(false);
    expect(validateGroovePayload({ ...GROOVE_PAYLOAD, bars: [] }).ok).toBe(false);
  });
  it('note-lane bars must be arrays of arrays', () => {
    const noteBundle = { laneType: 'bass', meter: GROOVE_PAYLOAD.meter, bars: [[[0, 'C2', 2], [8, 'G2', 2]]] };
    expect(validateGroovePayload(noteBundle).ok).toBe(true);
    expect(validateGroovePayload({ ...noteBundle, bars: [{ kick: [0] }] }).ok).toBe(false);
  });
  it('accepts the extensions hatch, rejects other unknown keys', () => {
    expect(validateGroovePayload({ ...GROOVE_PAYLOAD, extensions: { future: true } }).ok).toBe(true);
    expect(validateGroovePayload({ ...GROOVE_PAYLOAD, color: 'red' }).ok).toBe(false);
  });
});

describe('chord-relative grooves + pattern chords (harmony slice shapes)', () => {
  const song = () => JSON.parse(JSON.stringify(SONG_PAYLOAD));
  it('accepts { relative: true, bars } on note lanes, rejects on drums', () => {
    const s = song();
    s.lanes.push({ id: 'bass', type: 'bass', name: 'Bass', muted: false, soloed: false });
    s.grooves.bass = { octave: { relative: true, bars: [[[0, 'R', 2], [2, 'R+12', 2]]] } };
    expect(validateSongPayload(s).ok).toBe(true);
    const s2 = song();
    s2.grooves.drums.rel = { relative: true, bars: [{ kick: [0] }] };
    expect(validateSongPayload(s2).ok).toBe(false);
  });
  it('accepts pattern.chords (per-bar {name,root,voicing}|null), rejects malformed', () => {
    const s = song();
    s.patterns[0].chords = [{ name: 'F#m', root: 'F#2', voicing: ['F#3', 'A3', 'C#4'] }, null];
    expect(validateSongPayload(s).ok).toBe(true);
    const s2 = song();
    s2.patterns[0].chords = ['F#m'];
    expect(validateSongPayload(s2).ok).toBe(false);
  });
  it('groove bundle: relative flag allowed on note lanes only', () => {
    const rel = { laneType: 'bass', meter: GROOVE_PAYLOAD.meter, relative: true, bars: [[[0, 'R', 2]]] };
    expect(validateGroovePayload(rel).ok).toBe(true);
    expect(validateGroovePayload({ ...rel, laneType: 'drums', bars: [{ kick: [0] }] }).ok).toBe(false);
  });
});

// The contract between validator and engine: getSong() is the exact object the
// share dialog POSTs. If one of these fails, the VALIDATOR is wrong, not the song.
describe('all 7 real flattened presets validate as song payloads', () => {
  const PRESETS = { kids, risingSun, electricFeel, heartbeats, digitalLove, memoryReboot, takeOnMe };
  for (const [name, rich] of Object.entries(PRESETS)) {
    it(`${name} (flattened) passes validateSongPayload`, () => {
      const eng = createEngine();
      eng.load(rich);                     // flattens old rich format → v2
      const payload = JSON.parse(JSON.stringify(eng.getSong()));
      const res = validateSongPayload(payload);
      expect(res.error).toBeUndefined();  // surfaces WHICH rule failed
      expect(res.ok).toBe(true);
    });
  }
});
