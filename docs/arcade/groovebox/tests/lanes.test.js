import { test, expect } from 'vitest';
import { normalizeLanes, laneByType, captureScene } from '../engine/lanes.js';
import { laneAudible } from '../engine/song.js';
import { eventsForStep } from '../engine/scheduler.js';

// ─── normalizeLanes ───────────────────────────────────────────────────────────

test('normalizeLanes: object → list of 4 lanes in canonical order', () => {
  const authored = {
    drums:  { selection:'beat', muted:false, cycleLen:4, pool:{} },
    bass:   { selection:'roots', muted:false, pool:{} },
    chords: { selection:'pad', muted:false },
    melody: { selection:'hook', muted:false, pool:{} },
  };
  const lanes = normalizeLanes(authored);
  expect(Array.isArray(lanes)).toBe(true);
  expect(lanes).toHaveLength(4);
  expect(lanes[0].id).toBe('drums');
  expect(lanes[1].id).toBe('bass');
  expect(lanes[2].id).toBe('chords');
  expect(lanes[3].id).toBe('melody');
});

test('normalizeLanes: id equals type for the 4 defaults', () => {
  const lanes = normalizeLanes({ drums:{}, bass:{}, chords:{}, melody:{} });
  for (const lane of lanes) expect(lane.id).toBe(lane.type);
});

test('normalizeLanes: hoists all authored fields onto the lane', () => {
  const authored = {
    drums:  { selection:'house', muted:true, cycleLen:2, pool:{ house:{} }, voiceMute:{ hat:true } },
    bass:   { selection:'roots', muted:false, pool:{} },
    chords: { selection:'stab', muted:false },
    melody: { selection:'hook',  muted:false, pool:{} },
  };
  const lanes = normalizeLanes(authored);
  const dl = lanes.find(l => l.id === 'drums');
  expect(dl.selection).toBe('house');
  expect(dl.muted).toBe(true);
  expect(dl.cycleLen).toBe(2);
  expect(dl.voiceMute).toEqual({ hat: true });
});

test('normalizeLanes: melody lane gets tone:pulse by default', () => {
  const lanes = normalizeLanes({ drums:{}, bass:{}, chords:{}, melody:{} });
  const ml = lanes.find(l => l.id === 'melody');
  expect(ml.tone).toBe('pulse');
});

test('normalizeLanes: melody lane preserves an authored tone', () => {
  const lanes = normalizeLanes({ drums:{}, bass:{}, chords:{}, melody:{ tone:'sawtooth' } });
  const ml = lanes.find(l => l.id === 'melody');
  expect(ml.tone).toBe('sawtooth');
});

test('normalizeLanes: idempotent — passing a list returns the same list', () => {
  const authored = { drums:{}, bass:{}, chords:{}, melody:{} };
  const list = normalizeLanes(authored);
  const again = normalizeLanes(list);
  expect(again).toBe(list); // same reference
});

// ─── laneByType ──────────────────────────────────────────────────────────────

test('laneByType: returns the first lane of that type', () => {
  const lanes = normalizeLanes({ drums:{}, bass:{}, chords:{}, melody:{} });
  expect(laneByType(lanes, 'drums')).toBe(lanes[0]);
  expect(laneByType(lanes, 'melody')).toBe(lanes[3]);
});

test('laneByType: returns null for an unknown type', () => {
  const lanes = normalizeLanes({ drums:{}, bass:{}, chords:{}, melody:{} });
  expect(laneByType(lanes, 'synth')).toBeNull();
});

test('laneByType: returns the first of two melody-type lanes', () => {
  const lanes = normalizeLanes({ drums:{}, bass:{}, chords:{}, melody:{} });
  const dup = { ...lanes[3], id: 'melody-2', name: 'melody 2' };
  const withDup = [...lanes, dup];
  expect(laneByType(withDup, 'melody')).toBe(lanes[3]); // first melody
});

// ─── laneAudible across the list (solo semantics) ────────────────────────────

test('laneAudible: solo across list — one soloed mutes all others', () => {
  const lanes = [
    { id:'drums',  type:'drums',  muted:false, soloed:true  },
    { id:'bass',   type:'bass',   muted:false, soloed:false },
    { id:'chords', type:'chords', muted:false, soloed:false },
    { id:'melody', type:'melody', muted:false, soloed:false },
  ];
  expect(laneAudible(lanes, lanes[0])).toBe(true);
  expect(laneAudible(lanes, lanes[1])).toBe(false);
  expect(laneAudible(lanes, lanes[2])).toBe(false);
  expect(laneAudible(lanes, lanes[3])).toBe(false);
});

test('laneAudible: two lanes soloed — both audible, others not', () => {
  const lanes = [
    { id:'drums',  type:'drums',  muted:false, soloed:true  },
    { id:'bass',   type:'bass',   muted:false, soloed:true  },
    { id:'chords', type:'chords', muted:false, soloed:false },
    { id:'melody', type:'melody', muted:false, soloed:false },
  ];
  expect(laneAudible(lanes, lanes[0])).toBe(true);
  expect(laneAudible(lanes, lanes[1])).toBe(true);
  expect(laneAudible(lanes, lanes[2])).toBe(false);
  expect(laneAudible(lanes, lanes[3])).toBe(false);
});

// ─── captureScene: id-keyed selections ───────────────────────────────────────

test('captureScene: returns id-keyed selections for every lane', () => {
  const lanes = [
    { id:'drums',  type:'drums',  selection:'house',  muted:false, soloed:false },
    { id:'bass',   type:'bass',   selection:'roots',  muted:false, soloed:false },
    { id:'chords', type:'chords', selection:'stab',   muted:false, soloed:false },
    { id:'melody', type:'melody', selection:'hook',   muted:false, soloed:false },
    { id:'melody-2', type:'melody', selection:'chopped', muted:false, soloed:false },
  ];
  const scene = captureScene(lanes);
  expect(scene.lanes['drums']).toBe('house');
  expect(scene.lanes['bass']).toBe('roots');
  expect(scene.lanes['chords']).toBe('stab');
  expect(scene.lanes['melody']).toBe('hook');
  expect(scene.lanes['melody-2']).toBe('chopped');
  expect(scene.bars).toBe(4);
  expect(scene.fill).toBeNull();
});

// ─── eventsForStep: duplicated melody lane ────────────────────────────────────

const baseHarmony = { progression: [
  { name:'Am', root:'A2', voicing:['A3','C4','E4'] },
]};
const baseMeter = { beatsPerBar:4, beatUnit:4, stepsPerBeat:4 };

test('eventsForStep: two melody lanes with different selections both emit notes', () => {
  const lanes = [
    { id:'drums',    type:'drums',  muted:false, soloed:false, selection:'b', cycleLen:1,
      pool:{ b:{ kick:[0] } } },
    { id:'bass',     type:'bass',   muted:true,  soloed:false, selection:'r', pool:{ r:[] } },
    { id:'chords',   type:'chords', muted:true,  soloed:false, selection:'pad' },
    { id:'melody',   type:'melody', muted:false, soloed:false, selection:'hook',
      pool:{ hook:[ [[0,'A4',2]] ], chopped:[ [[0,'E5',1]] ] } },
    { id:'melody-2', type:'melody', muted:false, soloed:false, selection:'chopped',
      pool:{ hook:[ [[0,'A4',2]] ], chopped:[ [[0,'E5',1]] ] } },
  ];
  const song = { meter: baseMeter, harmony: baseHarmony };
  const ev = eventsForStep(song, lanes, 0);
  expect(ev.some(e => e.laneId === 'melody'   && e.note === 'A4')).toBe(true);
  expect(ev.some(e => e.laneId === 'melody-2' && e.note === 'E5')).toBe(true);
});

test('eventsForStep: muting one melody lane silences only that lane', () => {
  const lanes = [
    { id:'drums',    type:'drums',  muted:true,  soloed:false, selection:'b', pool:{ b:{} } },
    { id:'bass',     type:'bass',   muted:true,  soloed:false, selection:'r', pool:{ r:[] } },
    { id:'chords',   type:'chords', muted:true,  soloed:false, selection:'pad' },
    { id:'melody',   type:'melody', muted:false, soloed:false, selection:'hook',
      pool:{ hook:[ [[0,'A4',2]] ] } },
    { id:'melody-2', type:'melody', muted:true,  soloed:false, selection:'hook',
      pool:{ hook:[ [[0,'A4',2]] ] } },
  ];
  const song = { meter: baseMeter, harmony: baseHarmony };
  const ev = eventsForStep(song, lanes, 0);
  expect(ev.some(e => e.laneId === 'melody'   && e.note === 'A4')).toBe(true);
  expect(ev.some(e => e.laneId === 'melody-2')).toBe(false);
});

test('eventsForStep: each event carries laneId and type', () => {
  const lanes = normalizeLanes({
    drums:  { selection:'b', muted:false, cycleLen:1, pool:{ b:{ kick:[0] } } },
    bass:   { selection:'r', muted:false, pool:{ r:(bar,ch)=>[[0,ch.root,2]] } },
    chords: { selection:'pad', muted:false },
    melody: { selection:'h', muted:false, pool:{ h:[ [[0,'A4',2]] ] } },
  });
  const song = { meter: baseMeter, harmony: baseHarmony };
  const ev = eventsForStep(song, lanes, 0);
  for (const e of ev) {
    expect(typeof e.laneId).toBe('string');
    expect(typeof e.type).toBe('string');
  }
});
