// engine/groove-presets.js — the curated starter groove library, keyed by meter.
//
// Pure v2 data: 1-bar building blocks with human names, stocked into a New
// song so its dropdowns aren't a one-trick pony. Curated by hand from the
// bundled songs' pools (flatten-harvest loses unused pool entries, so these
// are authored directly, not generated). Bass/chords are RELATIVE (R/V refs,
// see DATA-MODEL.md) so they fit any key or progression; drums are pitchless
// and portable by nature. This set doubles as registry seed content later.
//
// 4/4 → 16 steps/bar, beats at 0/4/8/12.  3/4 → 12 steps/bar, beats at 0/4/8.

export function meterKey(meter) { return `${meter.beatsPerBar}/${meter.beatUnit}`; }

// Curated chord progressions — famous SHAPES, not fixed chords. Stored as
// roman-numeral degrees (case = quality: I major, i minor; optional 'b'
// prefix flattens) and resolved against a key at apply time — the schema
// keeps storing the compiled concrete chords. Meter-agnostic. This list
// doubles as the roll-a-progression pool for the future Generate feature.
export const PROGRESSION_PRESETS = [
  { name: 'axis of awesome', degrees: ['I', 'V', 'vi', 'IV'],  vibe: 'the 4-chord pop anthem' },
  { name: 'doo-wop',         degrees: ['I', 'vi', 'IV', 'V'],  vibe: "'50s heartthrob" },
  { name: "don't stop",      degrees: ['vi', 'IV', 'I', 'V'],  vibe: 'minor-leaning pop drive (Zombie, Kids)' },
  { name: 'andalusian',      degrees: ['vi', 'V', 'IV', 'III'], vibe: 'flamenco descent' },
  { name: 'jazz turnaround', degrees: ['ii', 'V', 'I', 'vi'],  vibe: 'smooth cycle' },
  { name: 'creep',           degrees: ['I', 'III', 'IV', 'iv'], vibe: 'bittersweet lift and fall' },
  { name: 'simple blues',    degrees: ['I', 'IV', 'I', 'V'],   vibe: 'porch blues' },
  { name: 'canon',           degrees: ['I', 'V', 'vi', 'iii', 'IV', 'I', 'IV', 'V'], vibe: "Pachelbel's 8-bar classic" },
];

// resolveProgression(degrees, keyRoot) → chord-symbol string for the chord
// line parser (sharps-only spellings). 'vi' in A → 'F#m'. Pure + tested.
const DEGREE_OFFSETS = { i: 0, ii: 2, iii: 4, iv: 5, v: 7, vi: 9, vii: 11 };
const PC_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const LETTER_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
export function resolveProgression(degrees, keyRoot) {
  const m = /^([A-G])(#|b)?$/.exec(keyRoot);
  if (!m) return null;
  const base = (LETTER_PC[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + 12) % 12;
  const out = [];
  for (let d of degrees) {
    let flat = 0;
    while (d.startsWith('b')) { flat -= 1; d = d.slice(1); }   // ♭VII-style borrowings
    const off = DEGREE_OFFSETS[d.toLowerCase()];
    if (off === undefined) return null;
    const minor = d === d.toLowerCase();
    out.push(PC_NAMES[(base + off + flat + 12) % 12] + (minor ? 'm' : ''));
  }
  return out.join(' ');
}

export const GROOVE_PRESETS = {
  '4/4': {
    drums: {
      'four on the floor': [{ kick: [0, 4, 8, 12], snare: [4, 12], hat: [0, 2, 4, 6, 8, 10, 12, 14] }],
      'backbeat':          [{ kick: [0, 8], snare: [4, 12], hat: [2, 6, 10, 14] }],
      'boom-cha':          [{ kick: [0, 4, 8, 12], snare: [2, 6, 10, 14] }],
      'boom-bap':          [{ kick: [0, 7, 10], snare: [4, 12], hat: [0, 2, 4, 6, 8, 10, 12, 14] }],
      // boom · cha · boom-boom · cha (lazy double — 8th apart)
      'half-time':         [{ kick: [0, 8, 10], snare: [4, 12], hat: [0, 2, 4, 6, 8, 10, 12, 14] }],
      // quick 16th double ON beat 3: boom · cha · b-boom · cha
      'half-time double':  [{ kick: [0, 8, 9], snare: [4, 12], hat: [0, 2, 4, 6, 8, 10, 12, 14] }],
      // quick 16th double driving INTO the back cha: boom · cha · …b-boom-CHA
      'half-time drive':   [{ kick: [0, 10, 11], snare: [4, 12], hat: [0, 2, 4, 6, 8, 10, 12, 14] }],
      'house':             [{ kick: [0, 4, 8, 12], snare: [4, 12], hat: [2, 6, 10, 14] }],
      'breaks':            [{ kick: [0, 6, 10], snare: [4, 12], hat: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] }],
      'sprint':            [{ kick: [0, 4, 8, 12], snare: [4, 12], hat: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], clap: [4, 12] }],
      'tribal toms':       [{ kick: [0, 8], snare: [8], tom: [[2, 7], [4, 5], [6, 3], [10, 7], [12, 5], [14, 0]] }],
      'fanfare':           [{ kick: [0, 8], snare: [12], hat: [0, 2, 4, 6, 8, 10, 12, 14], crash: [0], openhat: [14] }],
    },
    bass: {
      'root quarters': { relative: true, bars: [[[0, 'R', 4], [4, 'R', 4], [8, 'R', 4], [12, 'R', 4]]] },
      'eighths':       { relative: true, bars: [[[0, 'R', 2], [2, 'R', 2], [4, 'R', 2], [6, 'R', 2], [8, 'R', 2], [10, 'R', 2], [12, 'R', 2], [14, 'R', 2]]] },
      '16ths':         { relative: true, bars: [[[0, 'R', 1], [1, 'R', 1], [2, 'R', 1], [3, 'R', 1], [4, 'R', 1], [5, 'R', 1], [6, 'R', 1], [7, 'R', 1], [8, 'R', 1], [9, 'R', 1], [10, 'R', 1], [11, 'R', 1], [12, 'R', 1], [13, 'R', 1], [14, 'R', 1], [15, 'R', 1]]] },
      'octave bounce': { relative: true, bars: [[[0, 'R', 2], [2, 'R+12', 2], [4, 'R', 2], [6, 'R+12', 2], [8, 'R', 2], [10, 'R+12', 2], [12, 'R', 2], [14, 'R+12', 2]]] },
      'oom-pah':       { relative: true, bars: [[[0, 'R', 2], [2, 'V2-12', 2], [4, 'R', 2], [6, 'V2-12', 2], [8, 'R', 2], [10, 'V2-12', 2], [12, 'R', 2], [14, 'V2-12', 2]]] },
      'walking':       { relative: true, bars: [[[0, 'R', 4], [4, 'V1-12', 4], [8, 'V2-12', 4], [12, 'V1-12', 4]]] },
      'offbeat':       { relative: true, bars: [[[2, 'R', 2], [6, 'R', 2], [10, 'R', 2], [14, 'R', 2]]] },
      'whole note':    { relative: true, bars: [[[0, 'R', 16]]] },
    },
    chords: {
      'pad':          { relative: true, bars: [[[0, 'V*', 'bar']]] },
      'half pads':    { relative: true, bars: [[[0, 'V*', 8], [8, 'V*', 8]]] },
      'stab':         { relative: true, bars: [[[0, 'V*', 2], [4, 'V*', 2], [8, 'V*', 2], [12, 'V*', 2]]] },
      'offbeat stab': { relative: true, bars: [[[2, 'V*', 2], [6, 'V*', 2], [10, 'V*', 2], [14, 'V*', 2]]] },
      'arp':          { relative: true, bars: [[[0, 'V0', 2], [2, 'V1', 2], [4, 'V2', 2], [6, 'V1', 2], [8, 'V0', 2], [10, 'V1', 2], [12, 'V2', 2], [14, 'V1', 2]]] },
      'arp up':       { relative: true, bars: [[[0, 'V0', 2], [2, 'V1', 2], [4, 'V2', 2], [6, 'V0+12', 2], [8, 'V0', 2], [10, 'V1', 2], [12, 'V2', 2], [14, 'V0+12', 2]]] },
    },
  },

  '3/4': {
    drums: {
      // oom-cha-cha — the waltz
      'waltz':     [{ kick: [0], snare: [4, 8], hat: [0, 2, 4, 6, 8, 10] }],
      'ballroom':  [{ kick: [0], hat: [4, 8], ride: [4, 8] }],
      'footsteps': [{ kick: [0], hat: [4, 8], snare: [6], openhat: [10] }],
      'lurch':     [{ kick: [0, 8], hat: [2, 6, 10], tom: [[4, 0], [10, -4]], ride: [0, 8] }],
    },
    bass: {
      // root on 1, fifth above on 2 and 3
      'oom-cha-cha':   { relative: true, bars: [[[0, 'R', 4], [4, 'V2-12', 4], [8, 'V2-12', 4]]] },
      'root quarters': { relative: true, bars: [[[0, 'R', 4], [4, 'R', 4], [8, 'R', 4]]] },
      'octave waltz':  { relative: true, bars: [[[0, 'R', 4], [4, 'R+12', 4], [8, 'R+12', 4]]] },
      'whole note':    { relative: true, bars: [[[0, 'R', 12]]] },
    },
    chords: {
      'pad':          { relative: true, bars: [[[0, 'V*', 'bar']]] },
      // waltz comps on 2 and 3
      'comp (2 & 3)': { relative: true, bars: [[[4, 'V*', 2], [8, 'V*', 2]]] },
      'stab':         { relative: true, bars: [[[0, 'V*', 2], [4, 'V*', 2], [8, 'V*', 2]]] },
      'arp':          { relative: true, bars: [[[0, 'V0', 4], [4, 'V1', 4], [8, 'V2', 4]]] },
    },
  },
};
