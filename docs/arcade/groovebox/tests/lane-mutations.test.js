import { test, expect } from 'vitest';
import {
  normalizeLanes,
  cachePoolsByType,
  uniqueLaneId,
  addLane,
  duplicateLane,
  removeLane,
  renameLane,
} from '../engine/lanes.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeSong(overrides = {}) {
  const authored = {
    drums:  { selection:'four', muted:false, cycleLen:4,
              pool:{ four:{ kick:[0,4,8,12], snare:[4,12] } } },
    bass:   { selection:'octave', muted:false,
              pool:{ octave:(bar,chord)=>[[0,chord.root,4]], roots:(bar,chord)=>[[0,chord.root,16]] } },
    chords: { selection:'pad', muted:false },
    melody: { selection:'hook', muted:false, tone:'pulse',
              pool:{ hook:[ [[0,'A4',2]] ], chopped:[ [[0,'E5',1]] ] } },
    ...overrides,
  };
  const song = { bpm:120 };
  song.lanes = normalizeLanes(authored, song);
  return song;
}

// ─── uniqueLaneId ─────────────────────────────────────────────────────────────

test('uniqueLaneId: returns type when no collision', () => {
  const song = makeSong();
  // 'synth' isn't used yet
  expect(uniqueLaneId(song.lanes, 'synth')).toBe('synth');
});

test('uniqueLaneId: returns type-2 when type is already used', () => {
  const song = makeSong();
  // 'drums' exists, so next should be 'drums-2'
  expect(uniqueLaneId(song.lanes, 'drums')).toBe('drums-2');
});

test('uniqueLaneId: skips collisions — finds the next free slot', () => {
  const song = makeSong();
  // manually add drums-2
  song.lanes.push({ id:'drums-2', type:'drums', name:'drums 2', muted:false, soloed:false });
  expect(uniqueLaneId(song.lanes, 'drums')).toBe('drums-3');
});

test('uniqueLaneId: handles multiple existing duplicates', () => {
  const song = makeSong();
  song.lanes.push({ id:'melody-2', type:'melody', name:'melody 2', muted:false, soloed:false });
  song.lanes.push({ id:'melody-3', type:'melody', name:'melody 3', muted:false, soloed:false });
  expect(uniqueLaneId(song.lanes, 'melody')).toBe('melody-4');
});

// ─── addLane ─────────────────────────────────────────────────────────────────

test('addLane: pushes a new lane onto song.lanes', () => {
  const song = makeSong();
  const before = song.lanes.length;
  addLane(song, 'bass');
  expect(song.lanes.length).toBe(before + 1);
});

test('addLane: new lane has a unique id', () => {
  const song = makeSong();
  const lane = addLane(song, 'bass');
  expect(lane.id).toBe('bass-2');
  const ids = song.lanes.map(l => l.id);
  expect(new Set(ids).size).toBe(ids.length); // all unique
});

test('addLane: new lane starts with muted:false, soloed:false', () => {
  const song = makeSong();
  const lane = addLane(song, 'drums');
  expect(lane.muted).toBe(false);
  expect(lane.soloed).toBe(false);
});

test('addLane: pool is sourced from existing lane of that type', () => {
  const song = makeSong();
  const orig = song.lanes.find(l => l.type === 'bass');
  const lane = addLane(song, 'bass');
  expect(lane.pool).toBe(orig.pool); // same reference
});

test('addLane: default selection is the first pool key for drums', () => {
  const song = makeSong();
  const lane = addLane(song, 'drums');
  const origPool = song.lanes.find(l => l.type === 'drums' && l.id === 'drums').pool;
  expect(lane.selection).toBe(Object.keys(origPool)[0]);
});

test('addLane: chords lane gets selection "pad" and no pool', () => {
  const song = makeSong();
  const lane = addLane(song, 'chords');
  expect(lane.selection).toBe('pad');
  expect(lane.pool).toBeUndefined();
});

test('addLane: melody lane gets tone:pulse', () => {
  const song = makeSong();
  const lane = addLane(song, 'melody');
  expect(lane.tone).toBe('pulse');
});

test('addLane: name is unique when duplicating type name', () => {
  const song = makeSong();
  const lane = addLane(song, 'bass');
  expect(lane.name).toBe('bass 2'); // 'bass' already exists
});

test('addLane: can source pool from _poolsByType when no lane of that type exists', () => {
  const song = makeSong();
  // Remove all melody lanes
  song.lanes = song.lanes.filter(l => l.type !== 'melody');
  // _poolsByType should still have melody
  expect(song._poolsByType?.melody).toBeDefined();
  const lane = addLane(song, 'melody');
  expect(lane.pool).toBe(song._poolsByType.melody);
});

// ─── duplicateLane ────────────────────────────────────────────────────────────

test('duplicateLane: returns null for unknown id', () => {
  const song = makeSong();
  expect(duplicateLane(song, 'nonexistent')).toBeNull();
});

test('duplicateLane: inserts the new lane immediately after the source', () => {
  const song = makeSong();
  const srcIdx = song.lanes.findIndex(l => l.id === 'melody');
  duplicateLane(song, 'melody');
  const newIdx = song.lanes.findIndex(l => l.id === 'melody-2');
  expect(newIdx).toBe(srcIdx + 1);
});

test('duplicateLane: new lane has a unique id', () => {
  const song = makeSong();
  const lane = duplicateLane(song, 'melody');
  expect(lane.id).toBe('melody-2');
});

test('duplicateLane: new lane name is based on source name', () => {
  const song = makeSong();
  const lane = duplicateLane(song, 'melody');
  expect(lane.name).toBe('melody 2');
});

test('duplicateLane: pool is shared by reference with source', () => {
  const song = makeSong();
  const src = song.lanes.find(l => l.id === 'melody');
  const lane = duplicateLane(song, 'melody');
  expect(lane.pool).toBe(src.pool); // same reference — pool is shared
});

test('duplicateLane: copies selection and tone from source', () => {
  const song = makeSong();
  const src = song.lanes.find(l => l.id === 'melody');
  src.selection = 'chopped';
  src.tone = 'sawtooth';
  const lane = duplicateLane(song, 'melody');
  expect(lane.selection).toBe('chopped');
  expect(lane.tone).toBe('sawtooth');
});

test('duplicateLane: fresh muted:false, soloed:false regardless of source', () => {
  const song = makeSong();
  const src = song.lanes.find(l => l.id === 'melody');
  src.muted  = true;
  src.soloed = true;
  const lane = duplicateLane(song, 'melody');
  expect(lane.muted).toBe(false);
  expect(lane.soloed).toBe(false);
});

test('duplicateLane: two dupes of the same lane get different ids', () => {
  const song = makeSong();
  const a = duplicateLane(song, 'melody');
  const b = duplicateLane(song, 'melody');
  expect(a.id).not.toBe(b.id);
  const ids = song.lanes.map(l => l.id);
  expect(new Set(ids).size).toBe(ids.length);
});

// ─── removeLane ──────────────────────────────────────────────────────────────

test('removeLane: removes the lane with the given id', () => {
  const song = makeSong();
  const before = song.lanes.length;
  removeLane(song, 'bass');
  expect(song.lanes.length).toBe(before - 1);
  expect(song.lanes.find(l => l.id === 'bass')).toBeUndefined();
});

test('removeLane: returns the removed id', () => {
  const song = makeSong();
  const result = removeLane(song, 'chords');
  expect(result).toBe('chords');
});

test('removeLane: returns null for unknown id', () => {
  const song = makeSong();
  expect(removeLane(song, 'ghost')).toBeNull();
});

test('removeLane: guard — cannot remove the last lane', () => {
  const song = makeSong();
  // Remove all but one lane
  song.lanes.splice(1);
  expect(song.lanes).toHaveLength(1);
  const result = removeLane(song, song.lanes[0].id);
  expect(result).toBeNull();
  expect(song.lanes).toHaveLength(1);
});

test('removeLane: returns null when length is exactly 1, even if id matches', () => {
  const song = makeSong();
  song.lanes = [song.lanes[0]];
  const id = song.lanes[0].id;
  expect(removeLane(song, id)).toBeNull();
});

// ─── renameLane ──────────────────────────────────────────────────────────────

test('renameLane: updates the lane name', () => {
  const song = makeSong();
  renameLane(song, 'bass', 'deep bass');
  expect(song.lanes.find(l => l.id === 'bass').name).toBe('deep bass');
});

test('renameLane: trims whitespace', () => {
  const song = makeSong();
  renameLane(song, 'bass', '  funky  ');
  expect(song.lanes.find(l => l.id === 'bass').name).toBe('funky');
});

test('renameLane: ignores empty string', () => {
  const song = makeSong();
  renameLane(song, 'bass', '');
  expect(song.lanes.find(l => l.id === 'bass').name).toBe('bass'); // unchanged
});

test('renameLane: ignores whitespace-only string', () => {
  const song = makeSong();
  renameLane(song, 'bass', '   ');
  expect(song.lanes.find(l => l.id === 'bass').name).toBe('bass'); // unchanged
});

test('renameLane: no-op for unknown id', () => {
  const song = makeSong();
  // should not throw
  renameLane(song, 'ghost', 'ghost');
  expect(song.lanes.find(l => l.id === 'ghost')).toBeUndefined();
});

// ─── cachePoolsByType ────────────────────────────────────────────────────────

test('cachePoolsByType: populates _poolsByType from existing lanes', () => {
  const song = makeSong();
  // pools were cached by normalizeLanes — verify
  expect(song._poolsByType.drums).toBeDefined();
  expect(song._poolsByType.bass).toBeDefined();
  expect(song._poolsByType.melody).toBeDefined();
  // chords has no pool
  expect(song._poolsByType.chords).toBeUndefined();
});

test('cachePoolsByType: pools match the authored pools by reference', () => {
  const song = makeSong();
  const drumsLane = song.lanes.find(l => l.id === 'drums');
  expect(song._poolsByType.drums).toBe(drumsLane.pool);
});

// ─── Two-melody-lane coexistence (headline use case) ─────────────────────────

test('two melody lanes (hook + chopped, different tones) can coexist as independent data', () => {
  const song = makeSong();
  // Duplicate melody lane
  const orig = song.lanes.find(l => l.id === 'melody');
  orig.selection = 'hook';
  orig.tone      = 'pulse';
  const dup = duplicateLane(song, 'melody');
  dup.selection  = 'chopped';
  dup.tone       = 'sawtooth';

  // Both exist in lane list
  expect(song.lanes.filter(l => l.type === 'melody')).toHaveLength(2);

  // They share the pool reference
  expect(dup.pool).toBe(orig.pool);

  // But have independent selections + tones
  expect(orig.selection).toBe('hook');
  expect(dup.selection).toBe('chopped');
  expect(orig.tone).toBe('pulse');
  expect(dup.tone).toBe('sawtooth');

  // And independent mute/solo state
  orig.muted = true;
  expect(dup.muted).toBe(false);
});
