import { test, expect } from 'vitest';
import { drumVoiceAudible, DRUM_VOICES } from '../engine/song.js';
import { toggleDrumMute, toggleDrumSolo } from '../engine/lanes.js';
import { eventsForStep } from '../engine/scheduler.js';

// ─── DRUM_VOICES ─────────────────────────────────────────────────────────────

test('DRUM_VOICES contains all five voices', () => {
  expect(DRUM_VOICES).toEqual(['kick','snare','hat','tom','crash']);
});

// ─── drumVoiceAudible ─────────────────────────────────────────────────────────

function makeDrumsSong(voiceMute = {}, voiceSolo = {}) {
  return { lanes: { drums: { muted: false, soloed: false, voiceMute, voiceSolo } } };
}

test('drumVoiceAudible: no state → all voices audible', () => {
  const song = makeDrumsSong();
  for (const v of DRUM_VOICES) expect(drumVoiceAudible(song, v)).toBe(true);
});

test('drumVoiceAudible: missing voiceMute/voiceSolo props → all audible', () => {
  const song = { lanes: { drums: { muted: false, soloed: false } } };
  for (const v of DRUM_VOICES) expect(drumVoiceAudible(song, v)).toBe(true);
});

test('drumVoiceAudible: mute hat → hat inaudible, others audible', () => {
  const song = makeDrumsSong({ hat: true });
  expect(drumVoiceAudible(song, 'hat')).toBe(false);
  expect(drumVoiceAudible(song, 'kick')).toBe(true);
  expect(drumVoiceAudible(song, 'snare')).toBe(true);
  expect(drumVoiceAudible(song, 'tom')).toBe(true);
  expect(drumVoiceAudible(song, 'crash')).toBe(true);
});

test('drumVoiceAudible: solo kick → only kick audible', () => {
  const song = makeDrumsSong({}, { kick: true });
  expect(drumVoiceAudible(song, 'kick')).toBe(true);
  expect(drumVoiceAudible(song, 'snare')).toBe(false);
  expect(drumVoiceAudible(song, 'hat')).toBe(false);
  expect(drumVoiceAudible(song, 'tom')).toBe(false);
  expect(drumVoiceAudible(song, 'crash')).toBe(false);
});

test('drumVoiceAudible: multiple soloed voices → all soloed audible, others not', () => {
  const song = makeDrumsSong({}, { kick: true, snare: true });
  expect(drumVoiceAudible(song, 'kick')).toBe(true);
  expect(drumVoiceAudible(song, 'snare')).toBe(true);
  expect(drumVoiceAudible(song, 'hat')).toBe(false);
  expect(drumVoiceAudible(song, 'tom')).toBe(false);
  expect(drumVoiceAudible(song, 'crash')).toBe(false);
});

// ─── toggleDrumMute / toggleDrumSolo ──────────────────────────────────────────

function makeSongForLanes() {
  return { lanes: { drums: { muted: false, soloed: false } } };
}

test('toggleDrumMute: flips muted state and returns new value', () => {
  const song = makeSongForLanes();
  expect(toggleDrumMute(song, 'hat')).toBe(true);
  expect(song.lanes.drums.voiceMute.hat).toBe(true);
  expect(toggleDrumMute(song, 'hat')).toBe(false);
  expect(song.lanes.drums.voiceMute.hat).toBe(false);
});

test('toggleDrumMute: lazily initialises voiceMute', () => {
  const song = makeSongForLanes();
  expect(song.lanes.drums.voiceMute).toBeUndefined();
  toggleDrumMute(song, 'kick');
  expect(song.lanes.drums.voiceMute).toBeDefined();
  expect(song.lanes.drums.voiceMute.kick).toBe(true);
});

test('toggleDrumSolo: flips solo state and returns new value', () => {
  const song = makeSongForLanes();
  expect(toggleDrumSolo(song, 'kick')).toBe(true);
  expect(song.lanes.drums.voiceSolo.kick).toBe(true);
  expect(toggleDrumSolo(song, 'kick')).toBe(false);
  expect(song.lanes.drums.voiceSolo.kick).toBe(false);
});

test('toggleDrumSolo: exclusive — soloing snare clears kick (one at a time)', () => {
  const song = makeSongForLanes();
  toggleDrumSolo(song, 'kick');
  toggleDrumSolo(song, 'snare');
  expect(song.lanes.drums.voiceSolo.kick).toBe(false);
  expect(song.lanes.drums.voiceSolo.snare).toBe(true);
});

// ─── scheduler gating ─────────────────────────────────────────────────────────

function makeSchedulerSong(voiceMute = {}, voiceSolo = {}) {
  return {
    meter: { beatsPerBar: 4, beatUnit: 4, stepsPerBeat: 4 },
    harmony: { progression: [{ name:'Am', root:'A2', voicing:['A3','C4','E4'] }] },
    lanes: {
      drums: {
        selection: 'beat', muted: false, soloed: false, cycleLen: 1,
        voiceMute, voiceSolo,
        pool: { beat: { kick:[0], snare:[4], hat:[0,2,4,6,8,10,12,14], crash:[], tom:[[8,3]] } },
      },
      bass:   { selection:'r', muted:false, pool:{ r:[] } },
      chords: { selection:'pad', muted:true },
      melody: { selection:'h', muted:false, pool:{ h:[[]] } },
    },
  };
}

test('scheduler: hat muted → hat events omitted, kick/snare still fire', () => {
  const song = makeSchedulerSong({ hat: true });
  const ev0 = eventsForStep(song, 0);
  expect(ev0.some(e => e.voice === 'kick')).toBe(true);
  expect(ev0.some(e => e.voice === 'hat')).toBe(false);
  const ev4 = eventsForStep(song, 4);
  expect(ev4.some(e => e.voice === 'snare')).toBe(true);
  expect(ev4.some(e => e.voice === 'hat')).toBe(false);
});

test('scheduler: kick soloed → only kick events fire (hat/snare/tom/crash silenced)', () => {
  const song = makeSchedulerSong({}, { kick: true });
  const ev0 = eventsForStep(song, 0);
  expect(ev0.some(e => e.voice === 'kick')).toBe(true);
  expect(ev0.some(e => e.voice === 'hat')).toBe(false);
  const ev4 = eventsForStep(song, 4);
  expect(ev4.some(e => e.voice === 'snare')).toBe(false);
  // tom at step 8
  const ev8 = eventsForStep(song, 8);
  expect(ev8.some(e => e.voice === 'tom')).toBe(false);
});

test('scheduler: fill — muted hat stays muted during fill', () => {
  const song = makeSchedulerSong({ hat: true });
  const fillPat = { hat: [0,2,4,6,8,10,12,14], kick: [0] };
  const ev = eventsForStep(song, 0, fillPat);
  expect(ev.some(e => e.voice === 'hat')).toBe(false);
  expect(ev.some(e => e.voice === 'kick')).toBe(true);
});

test('scheduler: fill — tom gating respected (kick soloed, fill has tom)', () => {
  const song = makeSchedulerSong({}, { kick: true });
  const fillPat = { kick: [0], tom: [[0, 5]] };
  const ev = eventsForStep(song, 0, fillPat);
  expect(ev.some(e => e.voice === 'kick')).toBe(true);
  expect(ev.some(e => e.voice === 'tom')).toBe(false);
});
