// Beatbox-to-drums transcription: raw mic PCM in, drum hits out.
// Pure functions, no audio objects — same contract as engine/hum.js.
// Lab/POC stage: returns name-keyed bars ({kick,snare,hat}); the app landing
// (addGroove wiring) is written later against the instruments-layer contract.

// ── onset detection ────────────────────────────────────────────────────────
// Energy-envelope novelty: RMS per 256-sample hop, positive first difference,
// peak-picked with an adaptive floor and an 80ms refractory. Transients
// survive even telephone-grade capture, so this is deliberately simple.
export function detectOnsets(pcm, sampleRate, { hop = 256, refractory = 0.1 } = {}) {
  const env = [];
  for (let off = 0; off + hop <= pcm.length; off += hop) {
    let e = 0;
    for (let i = off; i < off + hop; i++) e += pcm[i] * pcm[i];
    env.push(Math.sqrt(e / hop));
  }
  const novelty = env.map((e, i) => Math.max(0, e - (env[i - 1] ?? 0)));
  const mean = novelty.reduce((a, b) => a + b, 0) / (novelty.length || 1);
  const floor = Math.max(0.015, 2.5 * mean);
  const refractoryHops = Math.ceil(refractory * sampleRate / hop);

  const onsets = [];
  let last = -Infinity, headNovelty = 0;
  const shadowHops = Math.ceil(0.5 * sampleRate / hop);
  for (let i = 0; i < novelty.length; i++) {
    if (novelty[i] < floor) continue;
    // local max only (edges compare against 0)
    if (novelty[i] < (novelty[i - 1] ?? 0) || novelty[i] < (novelty[i + 1] ?? 0)) continue;
    if (i - last < refractoryHops) continue;
    // Shadow rule: one mouth sound = one onset. A "boom" is a sharp burst
    // plus a wobbling voiced tail whose slow ripples also read as onsets —
    // for 500ms after a hit, an onset must carry at least a quarter of the
    // hit's attack to count. Tail ripples are ~10%; even a soft real hat
    // after a loud kick clears 25%.
    if (i - last <= shadowHops && novelty[i] < 0.25 * headNovelty) continue;
    last = i;
    headNovelty = novelty[i];
    onsets.push(i * hop / sampleRate);
  }
  return onsets;
}

// ── classification ─────────────────────────────────────────────────────────
// Spectral balance of the ~43ms after the onset, via a small radix-2 FFT:
// energy concentrated low → kick, high → hat, broadband middle → snare.
function fftMag(frame) {
  const n = frame.length;                          // power of two
  const re = Float64Array.from(frame), im = new Float64Array(n);
  // bit-reversal permutation
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let j2 = 0; j2 < len / 2; j2++) {
        const a = i + j2, b = i + j2 + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
  const mag = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) mag[i] = Math.hypot(re[i], im[i]);
  return mag;
}

// Spectral features of the ~170ms after an onset — the WHOLE mouth gesture,
// not just the burst: a "boom" and a "cha" have near-identical plosive
// attacks; it's the voiced tail (deep "oo" vs noisy "aa") that tells them
// apart. Exported so the lab can show WHY each hit classified as it did.
export function hitFeatures(pcm, sampleRate, t, { window = 8192 } = {}) {
  const off = Math.max(0, Math.round(t * sampleRate));
  const frame = new Float32Array(window);
  frame.set(pcm.subarray(off, Math.min(off + window, pcm.length)));
  const mag = fftMag(frame);
  const binHz = sampleRate / window;

  let total = 0, low = 0, mid = 0, centroidNum = 0;
  for (let i = 1; i < mag.length; i++) {
    const hz = i * binHz, m = mag[i] * mag[i];
    total += m;
    centroidNum += m * hz;
    if (hz < 250) low += m;
    if (hz >= 120 && hz < 1800) mid += m;
  }
  if (total === 0) return { centroid: 0, lowRatio: 0, midBody: 0 };
  return { centroid: centroidNum / total, lowRatio: low / total, midBody: mid / total };
}

export function classifyHit(pcm, sampleRate, t, opts = {}) {
  const { centroid, lowRatio, midBody } = hitFeatures(pcm, sampleRate, t, opts);
  // kick = bottom-heavy; then snare vs hat by MID-BAND BODY, not high energy:
  // broadband noise is mostly >3kHz by bin count, so "lots of highs" can't
  // separate them — but a snare ("ka"/"psh") keeps voice-body at 120–1800Hz
  // and a hat ("ts") has almost none.
  if (lowRatio > 0.45 || centroid < 600) return 'kick';
  return midBody > 0.25 ? 'snare' : 'hat';
}

// Auto-align: capture chains (Bluetooth especially) delay the whole take by a
// constant 0–300ms, and players lag the click a little. Find the single
// offset that puts the onsets closest to the grid and subtract it. Searches
// late-only (capture latency never makes hits early).
export function alignOffset(onsets, stepSec, { maxDelay = 0.35, stepsPerBeat = 4 } = {}) {
  if (!onsets.length) return 0;
  // Pass 1: grid-fit cost per candidate delay. NOTE the cost is periodic in
  // stepSec (shifting everything one whole step fits equally well), so a
  // minimum-cost search alone is ambiguous...
  const cands = [];
  let bestCost = Infinity;
  for (let d = 0; d <= maxDelay; d += 0.005) {
    let cost = 0;
    for (const t of onsets) {
      const s = (t - d) / stepSec;
      cost += Math.abs(s - Math.round(s));
    }
    cands.push([d, cost]);
    if (cost < bestCost) bestCost = cost;
  }
  // ...so pass 2 breaks the tie musically: among near-minimal candidates,
  // prefer the delay that puts the FIRST hit closest to a beat — beatboxers
  // come in on a beat, not an offbeat 16th.
  const beatSec = stepSec * stepsPerBeat;
  const eps = onsets.length * 0.04;
  let best = 0, bestBeat = Infinity;
  for (const [d, cost] of cands) {
    if (cost > bestCost + eps) continue;
    const b = (onsets[0] - d) / beatSec;
    const dist = Math.abs(b - Math.round(b));
    if (dist < bestBeat - 1e-9) { bestBeat = dist; best = d; }
  }
  return best;
}

// ── foldRepeats ────────────────────────────────────────────────────────────
// Consensus over repeated bars (Matthew's "look for similarities, not
// differences"): the player repeats one unit per bar; keep the hits that
// recur in at least half the non-empty bars (±1 step jitter clusters), drop
// the one-offs. Returns a single consensus bar.
export function foldRepeats(bars) {
  const active = bars.filter(b => b.kick.length + b.snare.length + b.hat.length > 0);
  if (active.length < 2) return bars.length === 1 ? bars : active.length ? [active[0]] : bars;
  const need = Math.ceil(active.length / 2);
  const out = { kick: [], snare: [], hat: [] };
  for (const v of ['kick', 'snare', 'hat']) {
    const steps = active.flatMap(b => b[v]).sort((a, b) => a - b);
    // cluster steps within ±1; keep clusters that recur enough
    let i = 0;
    while (i < steps.length) {
      let j = i;
      while (j + 1 < steps.length && steps[j + 1] - steps[j] <= 1) j++;
      const cluster = steps.slice(i, j + 1);
      if (cluster.length >= need) {
        out[v].push(cluster[0]);   // earliest = the attack edge; later members are tails/jitter
      }
      i = j + 1;
    }
    out[v] = [...new Set(out[v])].sort((a, b) => a - b);
  }
  return [out];
}

// ── transcribeBeats ────────────────────────────────────────────────────────
// pcm: Float32Array of the take, sample 0 = the first bar line.
// Returns per-bar { kick: [steps], snare: [steps], hat: [steps] }.
export function transcribeBeats(pcm, sampleRate, { bpm, meter, bars = 1 }) {
  const stepSec = 60 / bpm / 4;
  const spb = meter.beatsPerBar * meter.stepsPerBeat;
  const totalSteps = bars * spb;
  const out = Array.from({ length: bars }, () => ({ kick: [], snare: [], hat: [] }));
  const onsets = detectOnsets(pcm, sampleRate);
  // Sparse takes can't establish a confident delay — trust the raw timing.
  const delay = onsets.length >= 4
    ? alignOffset(onsets, stepSec, { stepsPerBeat: meter.stepsPerBeat })
    : 0;
  for (const t of onsets) {
    const step = Math.round((t - delay) / stepSec);
    if (step < 0 || step >= totalSteps) continue;
    const voice = classifyHit(pcm, sampleRate, t);
    const rows = out[Math.floor(step / spb)][voice];
    const s = step % spb;
    if (!rows.includes(s)) rows.push(s);
  }
  for (const bar of out) for (const k of Object.keys(bar)) bar[k].sort((a, b) => a - b);
  return out;
}
