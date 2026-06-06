// engine/flatten.js — the READ-ONLY bridge from the legacy rich song format
// (pools / generators / harmony / arrangement) to the explicit patterns+chain
// schema. Nothing else in the app reads the rich format; nothing ever writes it.
// The rich-resolution copies below live here ON PURPOSE — when the presets are
// eventually re-authored as explicit JSON, this whole file is deleted.
import { stepsPerBar } from './meter.js';

const DRUM_SET_KEYS = ['kick', 'snare', 'hat', 'crash'];

function resolveDrumPattern(pattern, bar, cycleLen) {
  if (!Array.isArray(pattern)) return pattern;
  const len = cycleLen ? Math.min(cycleLen, pattern.length) : pattern.length;
  return pattern[((bar % len) + len) % len];
}

function chordAt(progression, bar) {
  const n = progression.length || 1;
  return progression[((bar % n) + n) % n];
}

function sectionAt(arrangement, songBar) {
  const total = arrangement.reduce((n, s) => n + s.bars, 0) || 1;
  let b = ((songBar % total) + total) % total;
  for (let i = 0; i < arrangement.length; i++) {
    const s = arrangement[i];
    if (b < s.bars) return { index: i, section: s, barInSection: b, isLastBar: b === s.bars - 1 };
    b -= s.bars;
  }
  const last = arrangement.length - 1;
  return { index: last, section: arrangement[last], barInSection: 0, isLastBar: true };
}

function laneList(rich) {
  if (Array.isArray(rich.lanes)) return rich.lanes.map(l => ({ ...l }));
  return ['drums', 'bass', 'chords', 'melody'].map(type => ({ id: type, type, name: type, ...(rich.lanes[type] || {}) }));
}

// Bake one drums bar to explicit {kick,snare,hat,crash,tom} (sorted, deduped).
function bakeDrumBar(pat, addCrash0) {
  const out = {};
  for (const k of DRUM_SET_KEYS) {
    const steps = new Set(pat[k] || []);
    if (k === 'crash' && addCrash0) steps.add(0);
    if (steps.size) out[k] = [...steps].sort((a, b) => a - b);
  }
  if (pat.tom && pat.tom.length) out.tom = pat.tom.map(([s, semi]) => [s, semi ?? 0]).sort((a, b) => a[0] - b[0]);
  return out;
}

// Bake one bar of one lane to explicit per-bar data.
function bakeBar(rich, lane, bar, spb, fillPat, crashFlourish) {
  if (lane.type === 'drums') {
    const pat = fillPat || resolveDrumPattern(lane.pool[lane.selection], bar, lane.cycleLen) || {};
    return bakeDrumBar(pat, crashFlourish);
  }
  const chord = chordAt(rich.harmony.progression, bar);
  if (lane.type === 'bass') {
    const gen = lane.pool?.[lane.selection];
    if (!gen) return [];
    const notes = typeof gen === 'function'
      ? (gen(bar, chord) || [])
      : (Array.isArray(gen) && gen.length ? (gen[bar % gen.length] || []) : []);
    return notes.map(([s, n, d]) => [s, n, d]);
  }
  if (lane.type === 'chords') {
    if (!chord || !Array.isArray(chord.voicing) || !chord.voicing.length) return [];
    const mode = lane.selection;
    if (mode === 'pad')  return [[0, [...chord.voicing], 'bar']];
    if (mode === 'stab') return [[0, [...chord.voicing], 2], [spb / 2, [...chord.voicing], 2]];
    if (mode === 'arp')  return Array.from({ length: spb }, (_, s) => [s, chord.voicing[s % chord.voicing.length], 1]);
    return [];
  }
  if (lane.type === 'melody') {
    const bars = lane.pool?.[lane.selection];
    const phrase = (Array.isArray(bars) && bars.length ? bars[bar % bars.length] : null) || [];
    return phrase.map(([s, n, d]) => [s, n, d]);
  }
  return [];
}

// Greedy chunk sizes for a section that has no 1/2/4 period: [4,4,2,1...]
function chunkSizes(n) {
  const out = [];
  while (n > 0) {
    if (n >= 4) { out.push(4); n -= 4; }
    else if (n >= 2) { out.push(2); n -= 2; }
    else { out.push(1); n -= 1; }
  }
  return out;
}

/** flattenSong(rich) → v2 song. Pure; does not mutate `rich`. */
export function flattenSong(rich) {
  const working = laneList(rich);                                   // selections get driven per bar
  const spb = stepsPerBar(rich.meter);
  const arrangement = rich.arrangement?.length
    ? rich.arrangement
    : [{ bars: 4, lanes: Object.fromEntries(working.map(l => [l.type, l.selection])) }];
  const total = arrangement.reduce((n, s) => n + s.bars, 0);

  // 1. Bake every bar of one full arrangement cycle (steady state: the
  //    post-fill crash flourish is baked wherever it fires from cycle 2 onward,
  //    including the wrap onto bar 0).
  const lastSection = arrangement[arrangement.length - 1];
  const baked = [];                                                 // [bar] = { [laneId]: barData }
  const bakedMeta = [];                                             // [bar] = { [laneId]: { selection, fill } }
  let activeFill = null;
  for (let bar = 0; bar < total; bar++) {
    const prevFill = bar === 0 ? (lastSection.fill || null) : activeFill;   // wrap-aware
    const at = sectionAt(arrangement, bar);
    for (const [typeName, selection] of Object.entries(at.section.lanes)) {
      const lane = working.find(l => l.type === typeName);
      if (lane) lane.selection = selection;
    }
    activeFill = at.isLastBar ? (at.section.fill || null) : null;
    const fillPat = activeFill ? (rich.fills?.[activeFill] ?? null) : null;
    const crashFlourish = !!(prevFill && !activeFill);
    const barData = {};
    const barMeta = {};
    for (const lane of working) {
      const laneFill = lane.type === 'drums' ? fillPat : null;
      barData[lane.id] = bakeBar(rich, lane, bar, spb, laneFill, crashFlourish);
      // Record the source selection and any fill that landed in this lane's bar
      // (drums lanes are the only ones the fill rewrites — name those variants).
      barMeta[lane.id] = { selection: lane.selection, fill: laneFill ? activeFill : null };
    }
    baked.push(barData);
    bakedMeta.push(barMeta);
  }

  // 2. Section → pattern(s): detect a 1/2/4-bar period, else chunk into ≤4-bar runs.
  //    Per pattern × lane, the lane's baked bars are interned as a named GROOVE,
  //    deduped by content across the whole song; patterns store groove names.
  const patterns = [];
  const chain = [];
  const seen = new Map();                                           // JSON(pattern combo) → index

  // Per-lane groove intern table: JSON(barData[]) → { name, data }.
  const grooveByLane = {};   // laneId → Map(jsonContent → grooveName)
  const grooves = {};        // laneId → { grooveName → barData[] }
  const usedNames = {};      // laneId → Set(name)  (collision tracking)
  for (const lane of working) { grooveByLane[lane.id] = new Map(); grooves[lane.id] = {}; usedNames[lane.id] = new Set(); }

  // Base groove name from the recorded source selection (+fill where one landed).
  function baseName(laneId, barRange) {
    const sel = bakedMeta[barRange[0]][laneId]?.selection;
    const base = sel != null ? String(sel) : 'groove';
    // A fill rewrites the last bar of a section; name the variant when present.
    const fill = barRange.map(b => bakedMeta[b][laneId]?.fill).find(Boolean);
    return fill ? `${base} +${fill}` : base;
  }

  // Intern a lane's bars as a groove; return its (deduped) name.
  function internGroove(laneId, barRange) {
    const data = barRange.map(b => baked[b][laneId]);
    const key = JSON.stringify(data);
    const table = grooveByLane[laneId];
    if (table.has(key)) return table.get(key);
    // New content → assign a name, disambiguating collisions with ·2, ·3…
    let name = baseName(laneId, barRange);
    if (usedNames[laneId].has(name)) {
      let n = 2;
      while (usedNames[laneId].has(`${name} ·${n}`)) n++;
      name = `${name} ·${n}`;
    }
    usedNames[laneId].add(name);
    table.set(key, name);
    grooves[laneId][name] = data;
    return name;
  }

  function pushPattern(barRange) {
    const lanes = {};
    for (const lane of working) lanes[lane.id] = internGroove(lane.id, barRange);
    const pat = { lanes };
    const key = JSON.stringify(pat);
    if (seen.has(key)) return seen.get(key);
    patterns.push(pat);
    seen.set(key, patterns.length - 1);
    return patterns.length - 1;
  }
  let offset = 0;
  for (const section of arrangement) {
    const n = section.bars;
    const range = Array.from({ length: n }, (_, i) => offset + i);
    const period = [1, 2, 4].find(P =>
      P <= n && n % P === 0 &&
      range.every(b => JSON.stringify(baked[b]) === JSON.stringify(baked[offset + ((b - offset) % P)])));
    if (period) {
      const idx = pushPattern(range.slice(0, period));
      for (let r = 0; r < n / period; r++) chain.push(idx);
    } else {
      let at = 0;
      for (const size of chunkSizes(n)) {
        chain.push(pushPattern(range.slice(at, at + size)));
        at += size;
      }
    }
    offset += n;
  }

  // 3. Mixer-only lanes.
  const lanes = working.map(l => ({
    id: l.id, type: l.type, name: l.name || l.id,
    muted: !!l.muted, soloed: !!l.soloed,
    ...(l.type === 'melody' ? { tone: l.tone || 'pulse' } : {}),
  }));

  return {
    version: 2,                                   // schema version — see DATA-MODEL.md
    title: rich.title, artist: rich.artist, meter: rich.meter, bpm: rich.bpm,
    lanes, grooves, patterns, chain, fills: rich.fills || {},
  };
}
