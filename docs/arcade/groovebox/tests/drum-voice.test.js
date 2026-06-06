import { test, expect } from 'vitest';
import { drumVoiceAudible, DRUM_VOICES } from '../engine/song.js';
import { toggleDrumMute, toggleDrumSolo } from '../engine/lanes.js';

// ─── DRUM_VOICES ─────────────────────────────────────────────────────────────

test('DRUM_VOICES contains all five voices', () => {
  expect(DRUM_VOICES).toEqual(['kick','snare','hat','tom','crash']);
});

// ─── drumVoiceAudible ─────────────────────────────────────────────────────────

function makeDrumsLane(voiceMute = {}, voiceSolo = {}) {
  return { id: 'drums', type: 'drums', muted: false, soloed: false, voiceMute, voiceSolo };
}

test('drumVoiceAudible: no state → all voices audible', () => {
  const lane = makeDrumsLane();
  for (const v of DRUM_VOICES) expect(drumVoiceAudible(lane, v)).toBe(true);
});

test('drumVoiceAudible: missing voiceMute/voiceSolo props → all audible', () => {
  const lane = { id: 'drums', type: 'drums', muted: false, soloed: false };
  for (const v of DRUM_VOICES) expect(drumVoiceAudible(lane, v)).toBe(true);
});

test('drumVoiceAudible: mute hat → hat inaudible, others audible', () => {
  const lane = makeDrumsLane({ hat: true });
  expect(drumVoiceAudible(lane, 'hat')).toBe(false);
  expect(drumVoiceAudible(lane, 'kick')).toBe(true);
  expect(drumVoiceAudible(lane, 'snare')).toBe(true);
  expect(drumVoiceAudible(lane, 'tom')).toBe(true);
  expect(drumVoiceAudible(lane, 'crash')).toBe(true);
});

test('drumVoiceAudible: solo kick → only kick audible', () => {
  const lane = makeDrumsLane({}, { kick: true });
  expect(drumVoiceAudible(lane, 'kick')).toBe(true);
  expect(drumVoiceAudible(lane, 'snare')).toBe(false);
  expect(drumVoiceAudible(lane, 'hat')).toBe(false);
  expect(drumVoiceAudible(lane, 'tom')).toBe(false);
  expect(drumVoiceAudible(lane, 'crash')).toBe(false);
});

test('drumVoiceAudible: multiple soloed voices → all soloed audible, others not', () => {
  const lane = makeDrumsLane({}, { kick: true, snare: true });
  expect(drumVoiceAudible(lane, 'kick')).toBe(true);
  expect(drumVoiceAudible(lane, 'snare')).toBe(true);
  expect(drumVoiceAudible(lane, 'hat')).toBe(false);
  expect(drumVoiceAudible(lane, 'tom')).toBe(false);
  expect(drumVoiceAudible(lane, 'crash')).toBe(false);
});

// ─── toggleDrumMute / toggleDrumSolo ──────────────────────────────────────────

function makeDrumsLaneForToggle() {
  return { id: 'drums', type: 'drums', muted: false, soloed: false };
}

test('toggleDrumMute: flips muted state and returns new value', () => {
  const lane = makeDrumsLaneForToggle();
  expect(toggleDrumMute(lane, 'hat')).toBe(true);
  expect(lane.voiceMute.hat).toBe(true);
  expect(toggleDrumMute(lane, 'hat')).toBe(false);
  expect(lane.voiceMute.hat).toBe(false);
});

test('toggleDrumMute: lazily initialises voiceMute', () => {
  const lane = makeDrumsLaneForToggle();
  expect(lane.voiceMute).toBeUndefined();
  toggleDrumMute(lane, 'kick');
  expect(lane.voiceMute).toBeDefined();
  expect(lane.voiceMute.kick).toBe(true);
});

test('toggleDrumSolo: flips solo state and returns new value', () => {
  const lane = makeDrumsLaneForToggle();
  expect(toggleDrumSolo(lane, 'kick')).toBe(true);
  expect(lane.voiceSolo.kick).toBe(true);
  expect(toggleDrumSolo(lane, 'kick')).toBe(false);
  expect(lane.voiceSolo.kick).toBe(false);
});

test('toggleDrumSolo: exclusive — soloing snare clears kick (one at a time)', () => {
  const lane = makeDrumsLaneForToggle();
  toggleDrumSolo(lane, 'kick');
  toggleDrumSolo(lane, 'snare');
  expect(lane.voiceSolo.kick).toBe(false);
  expect(lane.voiceSolo.snare).toBe(true);
});
