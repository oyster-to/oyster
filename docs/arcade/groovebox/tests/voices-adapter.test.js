import { describe, it, expect } from 'vitest';
import { compileSynthPatch } from '../engine/voices.js';
import { DEFAULT_INSTRUMENTS } from '../engine/instruments.js';

// PARITY GATE: the adapter must reproduce the legacy hardcoded voices EXACTLY.
// Expected values below are copied verbatim from the pre-instruments voices.js
// (createVoiceForType literals). If a default instrument drifts from the
// original sound, this is the test that says so.

const plan = id => compileSynthPatch(DEFAULT_INSTRUMENTS[id]);

describe('compileSynthPatch parity vs legacy hardcoded voices', () => {
  it('kick — MembraneSynth({ volume: -5 }), C1 8n, no velocity', () => {
    expect(plan('gb-kick')).toEqual({
      ctor: 'MembraneSynth', options: { volume: -5 }, postVolume: undefined, filter: null,
      trig: { sig: 'note', note: 'C1', dur: '8n', velocity: undefined },
    });
  });
  it('snare — NoiseSynth({ volume: -11, envelope }), 16n, no velocity', () => {
    expect(plan('gb-snare')).toEqual({
      ctor: 'NoiseSynth',
      options: { volume: -11, envelope: { attack: 0.001, decay: 0.16, sustain: 0 } },
      postVolume: undefined, filter: null,
      trig: { sig: 'noise', note: undefined, dur: '16n', velocity: undefined },
    });
  });
  it('hat — NoiseSynth({ volume: -20, envelope }) → highpass 7000, 32n @ 0.6', () => {
    expect(plan('gb-hat')).toEqual({
      ctor: 'NoiseSynth',
      options: { volume: -20, envelope: { attack: 0.001, decay: 0.03, sustain: 0 } },
      postVolume: undefined,
      filter: { type: 'highpass', freq: 7000 },
      trig: { sig: 'noise', note: undefined, dur: '32n', velocity: 0.6 },
    });
  });
  it('tom — MembraneSynth({ volume: -6, pitchDecay: 0.06, octaves: 2 }), A2 8n', () => {
    expect(plan('gb-tom')).toEqual({
      ctor: 'MembraneSynth',
      options: { volume: -6, pitchDecay: 0.06, octaves: 2 },
      postVolume: undefined, filter: null,
      trig: { sig: 'note', note: 'A2', dur: '8n', velocity: undefined },
    });
  });
  it('crash — NoiseSynth({ volume: -12, envelope incl release }) → highpass 3500, 8n @ 0.8', () => {
    expect(plan('gb-crash')).toEqual({
      ctor: 'NoiseSynth',
      options: { volume: -12, envelope: { attack: 0.001, decay: 1.1, sustain: 0, release: 0.3 } },
      postVolume: undefined,
      filter: { type: 'highpass', freq: 3500 },
      trig: { sig: 'noise', note: undefined, dur: '8n', velocity: 0.8 },
    });
  });
  it('bass — MonoSynth(osc/env/filterEnv), volume -7 assigned after, vel 0.85', () => {
    expect(plan('gb-bass')).toEqual({
      ctor: 'MonoSynth',
      options: {
        oscillator: { type: 'triangle' },
        envelope: { attack: 0.005, decay: 0.18, sustain: 0.35, release: 0.18 },
        filterEnvelope: { attack: 0.005, decay: 0.12, sustain: 0.4, baseFrequency: 120, octaves: 3 },
      },
      postVolume: -7, filter: null,
      trig: { sig: 'note', note: undefined, dur: undefined, velocity: 0.85 },
    });
  });
  it('chords — PolySynth set(triangle/env) → lowpass 4200, volume -17 after, vel 0.3', () => {
    expect(plan('gb-chords')).toEqual({
      ctor: 'PolySynth',
      options: {
        oscillator: { type: 'triangle' },
        envelope: { attack: 0.05, decay: 0.3, sustain: 0.6, release: 0.5 },
      },
      postVolume: -17,
      filter: { type: 'lowpass', freq: 4200 },
      trig: { sig: 'note', note: undefined, dur: undefined, velocity: 0.3 },
    });
  });
  it('lead — PolySynth set(pulse w0.3/env), volume -11 after, vel 0.82', () => {
    expect(plan('gb-lead')).toEqual({
      ctor: 'PolySynth',
      options: {
        oscillator: { type: 'pulse', width: 0.3 },
        envelope: { attack: 0.004, decay: 0.18, sustain: 0.2, release: 0.2 },
      },
      postVolume: -11, filter: null,
      trig: { sig: 'note', note: undefined, dur: undefined, velocity: 0.82 },
    });
  });
});
