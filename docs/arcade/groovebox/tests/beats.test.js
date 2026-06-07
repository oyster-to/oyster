import { describe, it, expect } from 'vitest';
import { detectOnsets, classifyHit, transcribeBeats } from '../engine/beats.js';

const SR = 48000;

// ── synthesis: caricatures of beatboxed drum hits ──────────────────────────
// Kick: low decaying sine thump.
function kick(dur = 0.12, hz = 75, amp = 0.8, sr = SR) {
  const n = Math.round(dur * sr), out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = amp * Math.exp(-6 * i / n) * Math.sin(2 * Math.PI * hz * i / sr);
  }
  return out;
}

// Hat: short high-emphasis noise tick (first difference of white noise).
function hat(dur = 0.05, amp = 0.5, sr = SR, seed = 99) {
  const n = Math.round(dur * sr), out = new Float32Array(n);
  let s = seed, prev = 0;
  for (let i = 0; i < n; i++) {
    s = (s * 16807) % 2147483647;
    const w = (s / 2147483647) * 2 - 1;
    out[i] = amp * Math.exp(-8 * i / n) * (w - prev);
    prev = w;
  }
  return out;
}

// Snare: broadband noise burst plus a mid tone.
function snare(dur = 0.1, amp = 0.6, sr = SR, seed = 7) {
  const n = Math.round(dur * sr), out = new Float32Array(n);
  let s = seed;
  for (let i = 0; i < n; i++) {
    s = (s * 16807) % 2147483647;
    const w = (s / 2147483647) * 2 - 1;
    const env = Math.exp(-5 * i / n);
    out[i] = amp * env * (0.6 * w + 0.4 * Math.sin(2 * Math.PI * 190 * i / sr));
  }
  return out;
}

// Lay hits [{t, gen}] onto a buffer of `total` seconds.
function render(hits, total, sr = SR) {
  const out = new Float32Array(Math.round(total * sr));
  for (const { t, gen } of hits) {
    const s = gen, off = Math.round(t * sr);
    for (let i = 0; i < s.length && off + i < out.length; i++) out[off + i] += s[i];
  }
  return out;
}

// 120bpm 4/4: step = 0.125s, bar = 2s.
const OPTS = { bpm: 120, meter: { beatsPerBar: 4, beatUnit: 4, stepsPerBeat: 4 }, bars: 1 };

// ── detectOnsets ───────────────────────────────────────────────────────────
describe('detectOnsets', () => {
  it('finds isolated hits at their times', () => {
    const pcm = render([{ t: 0.1, gen: kick() }, { t: 0.7, gen: snare() }, { t: 1.3, gen: hat() }], 2.0);
    const on = detectOnsets(pcm, SR);
    expect(on.length).toBe(3);
    expect(Math.abs(on[0] - 0.1)).toBeLessThan(0.03);
    expect(Math.abs(on[1] - 0.7)).toBeLessThan(0.03);
    expect(Math.abs(on[2] - 1.3)).toBeLessThan(0.03);
  });

  it('does not double-trigger on one hit', () => {
    const pcm = render([{ t: 0.2, gen: snare() }], 1.0);
    expect(detectOnsets(pcm, SR).length).toBe(1);
  });

  it('silence has no onsets', () => {
    expect(detectOnsets(new Float32Array(SR), SR).length).toBe(0);
  });

  it('resolves hits 100ms apart as two onsets', () => {
    const pcm = render([{ t: 0.3, gen: hat() }, { t: 0.4, gen: hat(0.05, 0.5, SR, 1234) }], 1.0);
    expect(detectOnsets(pcm, SR).length).toBe(2);
  });
});

// A "boom": kick burst plus a voiced wobbling tail — one mouth sound that
// must NOT become an onset cluster.
function boom(sr = SR) {
  const burst = kick(0.08, 75, 0.8, sr);
  const tailN = Math.round(0.35 * sr), tail = new Float32Array(tailN);
  for (let i = 0; i < tailN; i++) {
    const am = 0.5 + 0.5 * Math.sin(2 * Math.PI * 7 * i / sr);   // 7Hz wobble
    tail[i] = 0.35 * am * Math.exp(-2 * i / tailN) * Math.sin(2 * Math.PI * 110 * i / sr);
  }
  const out = new Float32Array(burst.length + tailN);
  out.set(burst, 0); out.set(tail, burst.length);
  return out;
}

describe('detectOnsets valley rule', () => {
  it('a boom with a wobbling voiced tail is ONE onset', () => {
    const pcm = render([{ t: 0.2, gen: boom() }], 1.5);
    expect(detectOnsets(pcm, SR).length).toBe(1);
  });

  it('a real hit riding the previous tail still gets through', () => {
    const pcm = render([{ t: 0.2, gen: boom() }, { t: 0.45, gen: snare() }], 1.5);
    expect(detectOnsets(pcm, SR).length).toBe(2);
  });
});

// ── classifyHit ────────────────────────────────────────────────────────────
describe('classifyHit', () => {
  it('low thump → kick', () => {
    const pcm = render([{ t: 0.1, gen: kick() }], 0.5);
    expect(classifyHit(pcm, SR, 0.1)).toBe('kick');
  });

  it('high tick → hat', () => {
    const pcm = render([{ t: 0.1, gen: hat() }], 0.5);
    expect(classifyHit(pcm, SR, 0.1)).toBe('hat');
  });

  it('broadband burst → snare', () => {
    const pcm = render([{ t: 0.1, gen: snare() }], 0.5);
    expect(classifyHit(pcm, SR, 0.1)).toBe('snare');
  });
});

// ── transcribeBeats ────────────────────────────────────────────────────────
describe('transcribeBeats', () => {
  it('boots and cats lands on the grid', () => {
    // kick 0, hat 2, snare 4, hat 6 — the eternal groove, eighth notes.
    const pcm = render([
      { t: 0.00, gen: kick() },
      { t: 0.25, gen: hat() },
      { t: 0.50, gen: snare() },
      { t: 0.75, gen: hat(0.05, 0.5, SR, 555) },
    ], 2.0);
    const bars = transcribeBeats(pcm, SR, OPTS);
    expect(bars).toEqual([{ kick: [0], snare: [4], hat: [2, 6] }]);
  });

  it('slightly-late hits snap back to their step', () => {
    const pcm = render([{ t: 0.27, gen: kick() }], 2.0);   // 20ms late for step 2
    const bars = transcribeBeats(pcm, SR, OPTS);
    expect(bars[0].kick).toEqual([2]);
  });

  it('spreads across bars', () => {
    const pcm = render([{ t: 0.0, gen: kick() }, { t: 2.0, gen: snare() }], 4.0);
    const bars = transcribeBeats(pcm, SR, { ...OPTS, bars: 2 });
    expect(bars[0].kick).toEqual([0]);
    expect(bars[1].snare).toEqual([0]);
  });

  it('a constant capture delay is auto-aligned away', () => {
    // Bluetooth mics deliver audio ~150-300ms late, shifting every hit by the
    // same amount. The whole take displaced +270ms must still land on the
    // grid it was performed against.
    const d = 0.27;
    const pcm = render([
      { t: 0.00 + d, gen: kick() },
      { t: 0.25 + d, gen: hat() },
      { t: 0.50 + d, gen: snare() },
      { t: 0.75 + d, gen: hat(0.05, 0.5, SR, 555) },
      { t: 1.00 + d, gen: kick(0.12, 75, 0.8, SR) },
    ], 2.5);
    const bars = transcribeBeats(pcm, SR, OPTS);
    expect(bars[0]).toEqual({ kick: [0, 8], snare: [4], hat: [2, 6] });
  });

  it('silence is an empty bar', () => {
    expect(transcribeBeats(new Float32Array(2 * SR), SR, OPTS))
      .toEqual([{ kick: [], snare: [], hat: [] }]);
  });
});

// ── foldRepeats ────────────────────────────────────────────────────────────
import { foldRepeats } from '../engine/beats.js';

describe('foldRepeats', () => {
  it('keeps hits that recur across bars, drops one-offs, absorbs ±1 jitter', () => {
    const bars = [
      { kick: [0], snare: [8], hat: [4, 12] },
      { kick: [1], snare: [8], hat: [4] },          // kick jittered +1, hat 12 missed
      { kick: [0], snare: [8], hat: [4, 12, 7] },   // stray hat at 7
    ];
    expect(foldRepeats(bars)).toEqual([{ kick: [0], snare: [8], hat: [4, 12] }]);
  });

  it('ignores empty bars when counting consensus', () => {
    const bars = [
      { kick: [], snare: [], hat: [] },             // the count-in bar he skipped
      { kick: [0], snare: [8], hat: [] },
      { kick: [0], snare: [8], hat: [] },
    ];
    expect(foldRepeats(bars)).toEqual([{ kick: [0], snare: [8], hat: [] }]);
  });

  it('a single bar passes through unchanged', () => {
    const bars = [{ kick: [0], snare: [8], hat: [4] }];
    expect(foldRepeats(bars)).toEqual(bars);
  });
});
