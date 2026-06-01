import { test, expect } from 'vitest';
import { drumVoiceAudible, DRUM_VOICES } from '../engine/song.js';
import { toggleDrumMute, toggleDrumSolo, normalizeLanes } from '../engine/lanes.js';
import { eventsForStep } from '../engine/scheduler.js';

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

// ─── scheduler gating ─────────────────────────────────────────────────────────

function makeSchedulerSong(voiceMute = {}, voiceSolo = {}) {
  const song = {
    meter: { beatsPerBar: 4, beatUnit: 4, stepsPerBeat: 4 },
    harmony: { progression: [{ name:'Am', root:'A2', voicing:['A3','C4','E4'] }] },
  };
  song.lanes = normalizeLanes({
    drums: {
      selection: 'beat', muted: false, soloed: false, cycleLen: 1,
      voiceMute, voiceSolo,
      pool: { beat: { kick:[0], snare:[4], hat:[0,2,4,6,8,10,12,14], crash:[], tom:[[8,3]] } },
    },
    bass:   { selection:'r', muted:false, pool:{ r:[] } },
    chords: { selection:'pad', muted:true },
    melody: { selection:'h', muted:false, pool:{ h:[[]] } },
  });
  return song;
}

test('scheduler: hat muted → hat events omitted, kick/snare still fire', () => {
  const song = makeSchedulerSong({ hat: true });
  const ev0 = eventsForStep(song, song.lanes, 0);
  expect(ev0.some(e => e.voice === 'kick')).toBe(true);
  expect(ev0.some(e => e.voice === 'hat')).toBe(false);
  const ev4 = eventsForStep(song, song.lanes, 4);
  expect(ev4.some(e => e.voice === 'snare')).toBe(true);
  expect(ev4.some(e => e.voice === 'hat')).toBe(false);
});

test('scheduler: kick soloed → only kick events fire (hat/snare/tom/crash silenced)', () => {
  const song = makeSchedulerSong({}, { kick: true });
  const ev0 = eventsForStep(song, song.lanes, 0);
  expect(ev0.some(e => e.voice === 'kick')).toBe(true);
  expect(ev0.some(e => e.voice === 'hat')).toBe(false);
  const ev4 = eventsForStep(song, song.lanes, 4);
  expect(ev4.some(e => e.voice === 'snare')).toBe(false);
  // tom at step 8
  const ev8 = eventsForStep(song, song.lanes, 8);
  expect(ev8.some(e => e.voice === 'tom')).toBe(false);
});

test('scheduler: fill — muted hat stays muted during fill', () => {
  const song = makeSchedulerSong({ hat: true });
  const fillPat = { hat: [0,2,4,6,8,10,12,14], kick: [0] };
  const ev = eventsForStep(song, song.lanes, 0, fillPat);
  expect(ev.some(e => e.voice === 'hat')).toBe(false);
  expect(ev.some(e => e.voice === 'kick')).toBe(true);
});

test('scheduler: fill — tom gating respected (kick soloed, fill has tom)', () => {
  const song = makeSchedulerSong({}, { kick: true });
  const fillPat = { kick: [0], tom: [[0, 5]] };
  const ev = eventsForStep(song, song.lanes, 0, fillPat);
  expect(ev.some(e => e.voice === 'kick')).toBe(true);
  expect(ev.some(e => e.voice === 'tom')).toBe(false);
});
