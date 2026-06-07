import { describe, it, expect } from 'vitest';
import { yinPitch, transcribe, fitBars } from '../engine/hum.js';

const SR = 48000;

// ── synthesis helpers ──────────────────────────────────────────────────────
// Sine at `hz` for `dur` seconds with a short fade to avoid edge clicks.
function sine(hz, dur, sr = SR, amp = 0.6) {
  const n = Math.round(dur * sr), out = new Float32Array(n);
  const fade = Math.min(Math.round(0.005 * sr), n >> 1);
  for (let i = 0; i < n; i++) {
    let a = amp;
    if (i < fade) a *= i / fade;
    if (i >= n - fade) a *= (n - i) / fade;
    out[i] = a * Math.sin(2 * Math.PI * hz * i / sr);
  }
  return out;
}

function silence(dur, sr = SR) { return new Float32Array(Math.round(dur * sr)); }

// Sine with vibrato: depth in semitones, rate in Hz — models a wobbly hum or
// whistle riding a semitone boundary.
function vibSine(hz, dur, depthSemi, rateHz, sr = SR, amp = 0.6) {
  const n = Math.round(dur * sr), out = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const f = hz * Math.pow(2, depthSemi * Math.sin(2 * Math.PI * rateHz * i / sr) / 12);
    phase += 2 * Math.PI * f / sr;
    out[i] = amp * Math.sin(phase);
  }
  const fade = Math.min(Math.round(0.005 * sr), n >> 1);
  for (let i = 0; i < fade; i++) { out[i] *= i / fade; out[n - 1 - i] *= i / fade; }
  return out;
}

// Lay events [{t, dur, hz, amp?}] onto a buffer of `total` seconds.
function render(events, total, sr = SR) {
  const out = new Float32Array(Math.round(total * sr));
  for (const { t, dur, hz, amp = 0.6 } of events) {
    const s = sine(hz, dur, sr, amp), off = Math.round(t * sr);
    for (let i = 0; i < s.length && off + i < out.length; i++) out[off + i] = s[i];
  }
  return out;
}

const MIDI_HZ = (m) => 440 * Math.pow(2, (m - 69) / 12);

// 120bpm 4/4 sixteenths: step = 0.125s, bar = 2s.
const OPTS = { bpm: 120, meter: { beatsPerBar: 4, beatUnit: 4, stepsPerBeat: 4 }, bars: 1 };

// ── yinPitch ───────────────────────────────────────────────────────────────
describe('yinPitch', () => {
  it('detects a 220Hz sine (A3)', () => {
    const frame = sine(220, 2048 / SR, SR).subarray(0, 2048);
    const hz = yinPitch(frame, SR);
    expect(hz).not.toBeNull();
    expect(Math.abs(hz - 220)).toBeLessThan(2);
  });

  it('detects a low hum at 110Hz (A2)', () => {
    const frame = sine(110, 2048 / SR, SR).subarray(0, 2048);
    const hz = yinPitch(frame, SR);
    expect(hz).not.toBeNull();
    expect(Math.abs(hz - 110)).toBeLessThan(2);
  });

  it('returns null on silence', () => {
    expect(yinPitch(new Float32Array(2048), SR)).toBeNull();
  });

  it('returns null on white noise', () => {
    const frame = new Float32Array(2048);
    let seed = 1;
    for (let i = 0; i < frame.length; i++) {
      seed = (seed * 16807) % 2147483647;           // deterministic LCG noise
      frame[i] = (seed / 2147483647) * 2 - 1;
    }
    expect(yinPitch(frame, SR)).toBeNull();
  });
});

// ── transcribe ─────────────────────────────────────────────────────────────
describe('transcribe', () => {
  it('one held note on the downbeat', () => {
    // A3 for one beat (4 steps), rest of the bar silent.
    const pcm = render([{ t: 0, dur: 0.5, hz: 220 }], 2.0);
    const bars = transcribe(pcm, SR, OPTS);
    expect(bars).toEqual([[[0, 'A3', 4]]]);
  });

  it('two notes with a gap land on their steps', () => {
    // A3 on step 0 (2 steps), C4 on step 8 (4 steps).
    const pcm = render([
      { t: 0, dur: 0.25, hz: 220 },
      { t: 1.0, dur: 0.5, hz: MIDI_HZ(60) },
    ], 2.0);
    const bars = transcribe(pcm, SR, OPTS);
    expect(bars).toEqual([[[0, 'A3', 2], [8, 'C4', 4]]]);
  });

  it('slightly-late onset snaps back to the grid', () => {
    // 40ms late on step 4 — closer to step 4 (0.5s) than step 5 (0.625s).
    const pcm = render([{ t: 0.54, dur: 0.25, hz: 220 }], 2.0);
    const bars = transcribe(pcm, SR, OPTS);
    expect(bars).toEqual([[[4, 'A3', 2]]]);
  });

  it('off-key pitch snaps into the song key', () => {
    // Bb3 (233.08Hz) in C major → A3 (snapMidi resolves ties downward).
    const pcm = render([{ t: 0, dur: 0.5, hz: MIDI_HZ(58) }], 2.0);
    const bars = transcribe(pcm, SR, { ...OPTS, key: { root: 'C', mode: 'major' } });
    expect(bars).toEqual([[[0, 'A3', 4]]]);
  });

  it('without a key, chromatic pitches stay put', () => {
    const pcm = render([{ t: 0, dur: 0.5, hz: MIDI_HZ(58) }], 2.0);
    const bars = transcribe(pcm, SR, OPTS);
    expect(bars).toEqual([[[0, 'A#3', 4]]]);
  });

  it('a pitch change inside one breath splits into two notes', () => {
    // Continuous sound, jumps A3 → C4 at 0.5s.
    const pcm = render([
      { t: 0, dur: 0.5, hz: 220 },
      { t: 0.5, dur: 0.5, hz: MIDI_HZ(60) },
    ], 2.0);
    const bars = transcribe(pcm, SR, OPTS);
    expect(bars).toEqual([[[0, 'A3', 4], [4, 'C4', 4]]]);
  });

  it('a wobbly note riding a semitone boundary stays ONE note', () => {
    // A4 +40 cents with ±0.45-semitone vibrato crosses the A4/A#4 rounding
    // line constantly — rounded-equality grouping shatters it into confetti.
    const hz = 440 * Math.pow(2, 0.4 / 12);
    const pcm = new Float32Array(Math.round(2.0 * SR));
    pcm.set(vibSine(hz, 1.0, 0.45, 5), 0);
    const bars = transcribe(pcm, SR, OPTS);
    expect(bars[0].length).toBe(1);
    expect(bars[0][0][2]).toBe(8);                 // full second = 8 steps
  });

  it('frame-level octave flips fold to the dominant register', () => {
    // Band-limited mics (AirPods in call mode) erase the fundamental and YIN
    // grabs a harmonic for part of a note: 0.7s at A3 with a 0.3s excursion
    // detected an octave up must come back as ONE A3 note, not a leap.
    const pcm = render([{ t: 0, dur: 0.7, hz: 220 }, { t: 0.7, dur: 0.3, hz: 440 }], 2.0);
    const bars = transcribe(pcm, SR, OPTS);
    expect(bars).toEqual([[[0, 'A3', 8]]]);
  });

  it('bridges sub-100ms pitch dropouts inside a steady note', () => {
    // YIN losing the pitch mid-note (a breathy frame) while the LEVEL stays
    // up: bridge it into one note. A genuinely QUIET gap is a re-articulation
    // and splits — that case is covered by the loudness-dip test above.
    const pcm = render([{ t: 0, dur: 0.30, hz: 220 }, { t: 0.38, dur: 0.30, hz: 220 }], 2.0);
    let seed = 7;                                   // unpitched noise, sustained level
    for (let i = Math.round(0.30 * SR); i < Math.round(0.38 * SR); i++) {
      seed = (seed * 16807) % 2147483647;
      pcm[i] = ((seed / 2147483647) * 2 - 1) * 0.45;
    }
    const bars = transcribe(pcm, SR, OPTS);
    expect(bars.flat().length).toBe(1);
    expect(bars[0][0].slice(0, 2)).toEqual([0, 'A3']);
  });

  it('re-articulation at the same pitch splits on the loudness dip', () => {
    // "camp-town" hummed on one pitch: voicing never stops, but each syllable
    // re-attacks. Pitch-only segmentation merges them; the RMS dip→rise must
    // split them.
    const pcm = render([
      { t: 0.0, dur: 0.30, hz: 220, amp: 0.6 },
      { t: 0.30, dur: 0.08, hz: 220, amp: 0.1 },   // trough between syllables
      { t: 0.38, dur: 0.30, hz: 220, amp: 0.6 },
    ], 2.0);
    const bars = transcribe(pcm, SR, OPTS);
    expect(bars[0].length).toBe(2);
  });

  it('real articulation gaps still split notes', () => {
    const pcm = render([{ t: 0, dur: 0.25, hz: 220 }, { t: 0.5, dur: 0.25, hz: 220 }], 2.0);
    const bars = transcribe(pcm, SR, OPTS);
    expect(bars[0].length).toBe(2);
    expect(bars[0].map(n => n[0])).toEqual([0, 4]);
  });

  it('sub-60ms blips are dropped', () => {
    const pcm = render([{ t: 0, dur: 0.04, hz: 220 }], 2.0);
    expect(transcribe(pcm, SR, OPTS)).toEqual([[]]);
  });

  it('transpose is subtracted so playback re-applies it', () => {
    // Song transposed +2: you hum D4 against the shifted backing; the groove
    // must store C4 so the engine's +2 at schedule time lands you back on D4.
    const pcm = render([{ t: 0, dur: 0.5, hz: MIDI_HZ(62) }], 2.0);
    const bars = transcribe(pcm, SR, { ...OPTS, transpose: 2 });
    expect(bars).toEqual([[[0, 'C4', 4]]]);
  });

  it('silence transcribes to empty bars', () => {
    expect(transcribe(silence(2.0), SR, OPTS)).toEqual([[]]);
  });

  it('spreads notes across multiple bars', () => {
    // Bar 1 step 0: A3; bar 2 step 0 (t=2.0): E4.
    const pcm = render([
      { t: 0, dur: 0.5, hz: 220 },
      { t: 2.0, dur: 0.5, hz: MIDI_HZ(64) },
    ], 4.0);
    const bars = transcribe(pcm, SR, { ...OPTS, bars: 2 });
    expect(bars).toEqual([[[0, 'A3', 4]], [[0, 'E4', 4]]]);
  });

  it('a note is clamped to its bar count', () => {
    // Held across the recording end — duration can't spill past the last step.
    const pcm = render([{ t: 1.5, dur: 0.6, hz: 220 }], 2.1);
    const bars = transcribe(pcm, SR, OPTS);
    expect(bars).toEqual([[[12, 'A3', 4]]]);
  });
});

describe('transcribe tuning correction', () => {
  it('detached repeats of one off-grid pitch all round to the SAME note', () => {
    // Three staccato "doo"s of the same sung pitch, hovering on the G4/G#4
    // crack with take-to-take jitter. Independent rounding splits them
    // G/G#/G (and key-snap then amplifies); tuning correction centres the
    // whole take first.
    const pcm = render([
      { t: 0.0, dur: 0.3, hz: MIDI_HZ(67.4) },
      { t: 0.5, dur: 0.3, hz: MIDI_HZ(67.6) },
      { t: 1.0, dur: 0.3, hz: MIDI_HZ(67.45) },
    ], 2.0);
    const names = transcribe(pcm, SR, OPTS)[0].map(n => n[1]);
    expect(names.length).toBe(3);
    expect(new Set(names).size).toBe(1);
  });
});

describe('transcribe register lift', () => {
  it('lifts a low hum into melody register by whole octaves', () => {
    // A male hum at C#3 (138.6Hz) lands two octaves up at C#5? No — one
    // octave per lift until the median clears A3 (midi 57): C#3(49) → C#4(61).
    const pcm = render([{ t: 0, dur: 0.5, hz: 138.59 }], 2.0);
    const bars = transcribe(pcm, SR, { ...OPTS, lift: 57 });
    expect(bars).toEqual([[[0, 'C#4', 4]]]);
  });

  it('an in-register take is not lifted', () => {
    const pcm = render([{ t: 0, dur: 0.5, hz: 440 }], 2.0);
    const bars = transcribe(pcm, SR, { ...OPTS, lift: 57 });
    expect(bars).toEqual([[[0, 'A4', 4]]]);
  });
});

// ── fitBars ────────────────────────────────────────────────────────────────
describe('fitBars', () => {
  it('rounds completed bars up to the allowed 1/2/4/8', () => {
    expect(fitBars(0)).toBe(1);
    expect(fitBars(1)).toBe(1);
    expect(fitBars(2)).toBe(2);
    expect(fitBars(3)).toBe(4);
    expect(fitBars(4)).toBe(4);
    expect(fitBars(5)).toBe(8);
    expect(fitBars(8)).toBe(8);
    expect(fitBars(9)).toBe(8);
  });
});
