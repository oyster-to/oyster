// Hum-to-melody transcription: raw mic PCM in, melody-groove bars[] out.
// Pure functions, no audio objects — the UI records, this transcribes offline.
import { snapMidi } from './song.js';
import { stepsPerBar } from './meter.js';

const PC = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const midiToNote = (m) => PC[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);

// ── YIN pitch detection (de Cheveigné & Kawahara 2002) ─────────────────────
// frame → fundamental in Hz, or null when unvoiced/silent. Frame must be at
// least 2× the longest detectable period; 2048 samples @ 48k reaches ~94Hz
// via W=1024, comfortably under a low male hum.
// maxHz 700: wide enough for whistles and the 2nd harmonics that band-limited
// mics leave us (a tighter cap silently deletes every note whose surviving
// harmonic falls above it — a comb filter). Octave-fold normalizes register.
export function yinPitch(frame, sampleRate, { threshold = 0.15, minHz = 70, maxHz = 700 } = {}) {
  let rms = 0;
  for (let i = 0; i < frame.length; i++) rms += frame[i] * frame[i];
  if (Math.sqrt(rms / frame.length) < 0.01) return null;        // silence gate

  const W = frame.length >> 1;
  const tauMin = Math.max(2, Math.floor(sampleRate / maxHz));
  const tauMax = Math.min(W, Math.floor(sampleRate / minHz));

  // difference function + cumulative-mean normalization, in one pass
  const cmnd = new Float64Array(tauMax + 1);
  let running = 0;
  for (let tau = 1; tau <= tauMax; tau++) {
    let d = 0;
    for (let i = 0; i < W; i++) { const x = frame[i] - frame[i + tau]; d += x * x; }
    running += d;
    cmnd[tau] = running === 0 ? 1 : (d * tau) / running;
  }

  // first dip under threshold, descended to its local minimum
  let tau = -1;
  for (let t = tauMin; t <= tauMax; t++) {
    if (cmnd[t] < threshold) {
      while (t + 1 <= tauMax && cmnd[t + 1] < cmnd[t]) t++;
      tau = t;
      break;
    }
  }
  if (tau < 0) return null;

  // parabolic interpolation around the minimum for sub-sample precision
  let best = tau;
  if (tau > 1 && tau < tauMax) {
    const s0 = cmnd[tau - 1], s1 = cmnd[tau], s2 = cmnd[tau + 1];
    const denom = 2 * (2 * s1 - s2 - s0);
    if (denom !== 0) best = tau + (s2 - s0) / denom;
  }
  return sampleRate / best;
}

// 5-point median over the midi track — irons out octave blips and frame
// jitter without touching unvoiced (null) frames.
function medianFilter(vals, w = 7) {
  const half = w >> 1, out = vals.slice();
  for (let i = 0; i < vals.length; i++) {
    if (vals[i] == null) continue;
    const win = [];
    for (let j = Math.max(0, i - half); j <= Math.min(vals.length - 1, i + half); j++) {
      if (vals[j] != null) win.push(vals[j]);
    }
    win.sort((a, b) => a - b);
    out[i] = win[(win.length - 1) >> 1];
  }
  return out;
}

// ── transcribe ─────────────────────────────────────────────────────────────
// pcm: Float32Array of the take, sample 0 = the first bar line.
// opts: { bpm, meter, bars, key?, transpose? } — key snaps pitches into the
// song scale; transpose (the live KEY offset heard while humming) is
// subtracted so the engine's schedule-time re-transpose lands where you sang.
// Returns melody-groove bars[]: per bar, [ [stepInBar, 'C4', durSteps], … ].
// lift: midi floor (e.g. 57 = A3) — a take whose median sits below it is
// shifted up whole octaves until it clears. Hums live around C3; melody
// lanes live A3–A5, and notes below the piano roll's floor are invisible.
export function transcribe(pcm, sampleRate, { bpm, meter, key = null, transpose = 0, bars = 1, lift = 0 }) {
  const stepSec = 60 / bpm / 4;                    // engine grid: one sixteenth
  const spb = stepsPerBar(meter);
  const totalSteps = bars * spb;
  const frameSize = 2048, hop = 512;
  const hopSec = hop / sampleRate;

  // pitch track: one (possibly null) midi value per hop, plus frame RMS for
  // re-articulation detection
  const midis = [], rms = [];
  for (let off = 0; off + frameSize <= pcm.length; off += hop) {
    const frame = pcm.subarray(off, off + frameSize);
    const hz = yinPitch(frame, sampleRate);
    midis.push(hz == null ? null : 69 + 12 * Math.log2(hz / 440));
    let e = 0;
    for (let i = 0; i < frame.length; i++) e += frame[i] * frame[i];
    rms.push(Math.sqrt(e / frame.length));
  }
  const smooth = medianFilter(midis);

  // Octave-fold: band-limited capture makes YIN flip between harmonics, so
  // fold frames sitting an octave-scale distance (≥10 semitones) from the
  // take's median register. Genuine leaps up to a major 6th survive; humming
  // a true octave leap doesn't — acceptable v1 trade.
  const voiced = smooth.filter(v => v != null).sort((a, b) => a - b);
  if (voiced.length) {
    const median = voiced[voiced.length >> 1];
    for (let i = 0; i < smooth.length; i++) {
      if (smooth[i] == null) continue;
      while (smooth[i] - median >= 10) smooth[i] -= 12;
      while (median - smooth[i] >= 10) smooth[i] += 12;
    }
  }

  // Bridge short unvoiced gaps (YIN dropping a syllable mid-note): fill runs
  // of ≤100ms with the preceding pitch when the far side rejoins it.
  const bridge = Math.round(0.10 / hopSec);
  for (let i = 1; i < smooth.length; i++) {
    if (smooth[i] != null) continue;
    let j = i;
    while (j < smooth.length && smooth[j] == null) j++;
    if (smooth[i - 1] != null && j < smooth.length && j - i <= bridge
        && Math.abs(smooth[i - 1] - smooth[j]) <= 1.5) {
      for (let k = i; k < j; k++) smooth[k] = smooth[i - 1];
    }
    i = j;
  }

  // Global tuning correction: untrained singers are consistently sharp/flat
  // of the tempered grid. A note hummed on the crack between two semitones
  // rounds unstably (and key-snap then amplifies the flutter into whole-tone
  // flapping). Estimate the take's average deviation from the grid via a
  // circular mean of the fractional parts, and re-centre everything.
  {
    let sx = 0, sy = 0, nv = 0;
    for (const v of smooth) {
      if (v == null) continue;
      const a = 2 * Math.PI * (v - Math.floor(v));
      sx += Math.cos(a); sy += Math.sin(a); nv++;
    }
    if (nv) {
      const offset = Math.atan2(sy, sx) / (2 * Math.PI);   // (-0.5, 0.5] semitones
      for (let i = 0; i < smooth.length; i++) {
        if (smooth[i] != null) smooth[i] -= offset;
      }
    }
  }

  // Segment with hysteresis: a note continues while frames stay within ~1.3
  // semitones of the segment's running median (real whistles wobble a full
  // semitone inside one note; melodic moves are almost always >=2) — NOT rounded-equality, which
  // shatters a note wobbling across a semitone boundary into 1-step confetti.
  // Splitting requires the new pitch to persist 2 frames (transients absorb).
  const segs = [];
  let cur = null;
  const segMedian = (s) => { const v = [...s.vals].sort((a, b) => a - b); return v[v.length >> 1]; };
  const minFrames = Math.ceil(0.06 / hopSec);      // drop sub-60ms blips
  for (let i = 0; i <= smooth.length; i++) {
    const v = i < smooth.length ? smooth[i] : null;
    if (v != null && cur && Math.abs(v - segMedian(cur)) <= 1.3) {
      // Re-articulation at the same pitch ("camp-town" on one note): voicing
      // never breaks, but loudness dips then re-attacks. peak→trough→rise
      // (trough <40% of peak, rise >2.2× trough) starts a new note. The
      // maxR/minAfterMax bookkeeping ignores the initial attack ramp.
      const r = rms[i];
      if (r > cur.maxR) { cur.maxR = r; cur.minAfterMax = r; }
      else if (r < cur.minAfterMax) cur.minAfterMax = r;
      if (i - cur.start >= minFrames && cur.minAfterMax < 0.4 * cur.maxR && r > 2.2 * cur.minAfterMax) {
        segs.push({ note: Math.round(segMedian(cur)), start: cur.start, end: i });
        cur = { vals: [v], start: i, end: i + 1, maxR: r, minAfterMax: r };
        continue;
      }
      cur.vals.push(v); cur.end = i + 1;
      continue;
    }
    if (v != null && cur) {
      // candidate split — absorb lone-frame wobble, commit on persistence
      const next = smooth[i + 1];
      if (next == null || Math.abs(next - v) > 1.3) { cur.end = i + 1; continue; }
    }
    if (cur) { segs.push({ note: Math.round(segMedian(cur)), start: cur.start, end: cur.end }); cur = null; }
    if (v != null) cur = { vals: [v], start: i, end: i + 1, maxR: rms[i], minAfterMax: rms[i] };
  }

  // Register lift: shift the whole take up by octaves until its median note
  // clears the floor (melody register), preserving every interval.
  let liftSemis = 0;
  if (lift && segs.length) {
    const notes = segs.map(s => s.note).sort((a, b) => a - b);
    let median = notes[notes.length >> 1];
    while (median + liftSemis < lift) liftSemis += 12;
  }

  // snap to grid + key; same-onset collisions resolve to the later take
  const byStep = new Map();
  for (const s of segs) {
    if (s.end - s.start < minFrames) continue;
    const onset = Math.round((s.start * hopSec) / stepSec);
    if (onset >= totalSteps) continue;
    const endStep = Math.min(totalSteps, Math.round((s.end * hopSec) / stepSec));
    const nominal = s.note + liftSemis - transpose;
    const midi = key ? snapMidi(nominal, key) : nominal;
    byStep.set(onset, [onset, midiToNote(midi), Math.max(1, endStep - onset)]);
  }

  const out = Array.from({ length: bars }, () => []);
  for (const [onset, note, dur] of [...byStep.values()].sort((a, b) => a[0] - b[0])) {
    out[Math.floor(onset / spb)].push([onset % spb, note, dur]);
  }
  return out;
}

// 'hearing: A3' readout for the recording UI.
export function hzToNote(hz) {
  return midiToNote(Math.round(69 + 12 * Math.log2(hz / 440)));
}

// Completed bars → the UI's opinionated groove lengths (1/2/4/8), rounding up
// so a hummed phrase is never truncated.
export function fitBars(n) {
  for (const len of [1, 2, 4, 8]) if (n <= len) return len;
  return 8;
}
