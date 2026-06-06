import { describe, it, expect } from 'vitest';
import { createEngine } from '../engine/index.js';
import { kids } from '../songs/kids.js';
import { dedupeName, pickHostLanes, metersEqual, buildGrooveBundle, decideShareMode, importGroove }
  from '../ui/share.js';
import { validateGroovePayload } from '../registry/validate.js';

function engineWithSong() { const eng = createEngine(); eng.load(kids); return eng; }
const drumLaneId = (eng) => eng.getLanes().find((l) => l.type === 'drums').id;

describe('eng.addGroove(laneId, name, value)', () => {
  const BARS = [{ kick: [0, 8], snare: [4, 12], hat: [], crash: [], tom: [] }];

  it('adds a named groove to an existing lane', () => {
    const eng = engineWithSong();
    const laneId = drumLaneId(eng);
    expect(eng.addGroove(laneId, 'imported', BARS)).toBe(true);
    expect(eng.getGrooves()[laneId].imported).toEqual(BARS);
  });

  it('refuses name collisions and unknown lanes', () => {
    const eng = engineWithSong();
    const laneId = drumLaneId(eng);
    eng.addGroove(laneId, 'imported', BARS);
    expect(eng.addGroove(laneId, 'imported', BARS)).toBe(false);
    expect(eng.addGroove('ghost-lane', 'x', BARS)).toBe(false);
  });

  it('refuses bars outside 1..8', () => {
    const eng = engineWithSong();
    const laneId = drumLaneId(eng);
    expect(eng.addGroove(laneId, 'x', [])).toBe(false);
    expect(eng.addGroove(laneId, 'x', Array.from({ length: 9 }, () => ({})))).toBe(false);
  });

  it('accepts a chord-relative groove value on a note lane', () => {
    const eng = engineWithSong();
    const laneId = eng.getLanes().find((l) => l.type === 'bass').id;
    expect(eng.addGroove(laneId, 'imported-rel', { relative: true, bars: [[[0, 'R', 2]]] })).toBe(true);
    expect(eng.setLaneGroove(laneId, 'imported-rel')).toBe(true);
  });

  it('added groove is selectable via setLaneGroove', () => {
    const eng = engineWithSong();
    const laneId = drumLaneId(eng);
    eng.addGroove(laneId, 'imported', BARS);
    expect(eng.setLaneGroove(laneId, 'imported')).toBe(true);
  });

  it('works on a freshly added lane (grooves slot exists)', () => {
    const eng = engineWithSong();
    const lane = eng.addLane('bass');
    expect(eng.addGroove(lane.id, 'imported', [[[0, 'C2', 2]]])).toBe(true);
  });
});

describe('share.js pure helpers', () => {
  it('dedupeName: name, name-2, name-3…', () => {
    expect(dedupeName([], 'amen')).toBe('amen');
    expect(dedupeName(['amen'], 'amen')).toBe('amen-2');
    expect(dedupeName(['amen', 'amen-2'], 'amen')).toBe('amen-3');
  });

  it('pickHostLanes filters by type', () => {
    const lanes = [{ id: 'drums', type: 'drums' }, { id: 'bass', type: 'bass' }, { id: 'drums-2', type: 'drums' }];
    expect(pickHostLanes(lanes, 'drums').map((l) => l.id)).toEqual(['drums', 'drums-2']);
    expect(pickHostLanes(lanes, 'melody')).toEqual([]);
  });

  it('metersEqual compares the three rhythm fields (group is cosmetic)', () => {
    expect(metersEqual({ beatsPerBar: 4, beatUnit: 4, stepsPerBeat: 4 }, { beatsPerBar: 4, beatUnit: 4, stepsPerBeat: 4 })).toBe(true);
    expect(metersEqual({ beatsPerBar: 6, beatUnit: 8, stepsPerBeat: 2 }, { beatsPerBar: 4, beatUnit: 4, stepsPerBeat: 4 })).toBe(false);
    expect(metersEqual({ beatsPerBar: 6, beatUnit: 8, stepsPerBeat: 2, group: 3 }, { beatsPerBar: 6, beatUnit: 8, stepsPerBeat: 2 })).toBe(true);
  });

  it('buildGrooveBundle: literal drums groove → valid payload', () => {
    const eng = engineWithSong();
    const laneId = drumLaneId(eng);
    const grooveName = Object.keys(eng.getGrooves()[laneId])[0];
    const bundle = buildGrooveBundle(eng, laneId, grooveName);
    expect(bundle.laneType).toBe('drums');
    expect(bundle.meter).toEqual(JSON.parse(JSON.stringify(eng.getSong().meter)));
    expect(bundle.relative).toBeUndefined();
    expect(typeof bundle.bpm).toBe('number');
    expect(validateGroovePayload(bundle).ok).toBe(true);   // bundle ↔ validator contract
  });

  it('buildGrooveBundle: chord-relative groove → relative flag + valid payload', () => {
    const eng = engineWithSong();
    const laneId = eng.getLanes().find((l) => l.type === 'bass').id;
    const grooves = eng.getGrooves()[laneId];
    const relName = Object.keys(grooves).find((n) => !Array.isArray(grooves[n]));
    expect(relName).toBeTruthy();                          // kids has relative bass grooves
    const bundle = buildGrooveBundle(eng, laneId, relName);
    expect(bundle.relative).toBe(true);
    expect(Array.isArray(bundle.bars)).toBe(true);
    expect(validateGroovePayload(bundle).ok).toBe(true);
  });

  it('decideShareMode: owner-choice / remix / new', () => {
    expect(decideShareMode({ loadedFrom: { id: 'a', kind: 'song' }, hasEditKey: true, kind: 'song' })).toBe('owner-choice');
    expect(decideShareMode({ loadedFrom: { id: 'a', kind: 'song' }, hasEditKey: false, kind: 'song' })).toBe('remix');
    expect(decideShareMode({ loadedFrom: { id: 'a', kind: 'song' }, hasEditKey: false, kind: 'groove' })).toBe('new'); // cross-kind = new in v1
    expect(decideShareMode({ loadedFrom: null, hasEditKey: false, kind: 'song' })).toBe('new');
  });
});

describe('importGroove (engine-level, no DOM)', () => {
  const RECORD = (over = {}) => ({
    id: 'abcd1234', kind: 'groove', name: 'imported-beat',
    payload: {
      laneType: 'drums',
      meter: { beatsPerBar: 4, beatUnit: 4, stepsPerBeat: 4 },
      bars: [{ kick: [0, 8], snare: [4, 12], hat: [], crash: [], tom: [] }],
    }, ...over,
  });

  it('meter match: adds groove AND selects it on the lane', () => {
    const eng = engineWithSong();                       // kids is 4/4
    const laneId = drumLaneId(eng);
    const result = importGroove(eng, RECORD(), laneId);
    expect(result.placed).toBe(true);
    expect(eng.getGrooves()[laneId]['imported-beat']).toBeTruthy();
    const editIdx = eng.getEditPatternIndex();
    expect(eng.getPatterns()[editIdx].lanes[laneId]).toBe('imported-beat');
  });

  it('meter mismatch: adds as data only, NOT selected', () => {
    const eng = engineWithSong();
    const laneId = drumLaneId(eng);
    const before = eng.getPatterns()[eng.getEditPatternIndex()].lanes[laneId];
    const rec = RECORD();
    rec.payload = { ...rec.payload, meter: { beatsPerBar: 6, beatUnit: 8, stepsPerBeat: 2 } };
    const result = importGroove(eng, rec, laneId);
    expect(result.placed).toBe(false);
    expect(eng.getGrooves()[laneId]['imported-beat']).toBeTruthy();           // data preserved
    expect(eng.getPatterns()[eng.getEditPatternIndex()].lanes[laneId]).toBe(before);
  });

  it('name collision dedupes with -2 suffix', () => {
    const eng = engineWithSong();
    const laneId = drumLaneId(eng);
    importGroove(eng, RECORD(), laneId);
    const result = importGroove(eng, RECORD(), laneId);
    expect(result.name).toBe('imported-beat-2');
    expect(eng.getGrooves()[laneId]['imported-beat-2']).toBeTruthy();
  });

  it('relative groove bundle imports as a relative groove value', () => {
    const eng = engineWithSong();
    const laneId = eng.getLanes().find((l) => l.type === 'bass').id;
    const rec = RECORD({
      name: 'rel-bass',
      payload: { laneType: 'bass', meter: { beatsPerBar: 4, beatUnit: 4, stepsPerBeat: 4 }, relative: true, bars: [[[0, 'R', 2]]] },
    });
    const result = importGroove(eng, rec, laneId);
    expect(result.placed).toBe(true);
    const v = eng.getGrooves()[laneId]['rel-bass'];
    expect(v.relative).toBe(true);
    expect(v.bars).toEqual([[[0, 'R', 2]]]);
  });
});
