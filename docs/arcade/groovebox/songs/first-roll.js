// "First Roll" — the first song authored directly in the v2 schema (no rich
// format, no flattener): an AI-written smoke test of DATA-MODEL.md as an
// authoring format. E minor, i–VI–III–VII (Em C G D) — the classic minor loop.
// Composed by Claude, 2026-06-06. Melody included as a starter — overwrite it.

const Em = { name: 'Em', root: 'E2', voicing: ['E3', 'G3', 'B3'] };
const C  = { name: 'C',  root: 'C2', voicing: ['C3', 'E3', 'G3'] };
const G  = { name: 'G',  root: 'G2', voicing: ['G3', 'B3', 'D4'] };
const D  = { name: 'D',  root: 'D2', voicing: ['D3', 'F#3', 'A3'] };

export const firstRoll = {
  version: 2,
  title: 'First Roll',
  artist: 'Claude × Oyster',
  meter: { beatsPerBar: 4, beatUnit: 4, stepsPerBeat: 4 },
  bpm: 112,
  key: { root: 'E', mode: 'minor' },

  lanes: [
    { id: 'drums',  type: 'drums',  name: 'drums',  muted: false, soloed: false },
    { id: 'bass',   type: 'bass',   name: 'bass',   muted: false, soloed: false },
    { id: 'chords', type: 'chords', name: 'chords', muted: false, soloed: false },
    { id: 'melody', type: 'melody', name: 'melody', muted: false, soloed: false, instrument: 'gb-lead' },
  ],

  grooves: {
    drums: {
      // steady verse kit
      four:        [{ kick: [0, 4, 8, 12], snare: [4, 12], hat: [0, 2, 4, 6, 8, 10, 12, 14] }],
      // sparse intro/bridge kit
      'half-time': [{ kick: [0], snare: [8], hat: [0, 2, 4, 6, 8, 10, 12, 14] }],
      // busy chorus kit
      breaks:      [{ kick: [0, 6, 10], snare: [4, 12], hat: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] }],
    },
    bass: {
      // root/octave bounce — rides whatever chords the pattern carries
      octave:  { relative: true, bars: [[[0, 'R', 2], [2, 'R+12', 2], [4, 'R', 2], [6, 'R+12', 2], [8, 'R', 2], [10, 'R+12', 2], [12, 'R', 2], [14, 'R+12', 2]]] },
      // driving straight 8ths on the root
      drive:   { relative: true, bars: [[[0, 'R', 2], [2, 'R', 2], [4, 'R', 2], [6, 'R', 2], [8, 'R', 2], [10, 'R', 2], [12, 'R', 2], [14, 'R', 2]]] },
    },
    chords: {
      pad:  { relative: true, bars: [[[0, 'V*', 'bar']]] },
      stab: { relative: true, bars: [[[0, 'V*', 2], [8, 'V*', 2]]] },
    },
    melody: {
      // 4-bar hook in E minor — every note in key, chord tones on the downbeats.
      hook: [
        [[0, 'E4', 4], [4, 'G4', 2], [6, 'F#4', 2], [8, 'E4', 4], [12, 'B3', 4]],
        [[0, 'C4', 4], [4, 'E4', 2], [6, 'D4', 2], [8, 'B3', 8]],
        [[0, 'G4', 4], [4, 'A4', 2], [6, 'B4', 2], [8, 'A4', 2], [10, 'G4', 2], [12, 'F#4', 4]],
        [[0, 'F#4', 8], [8, 'D4', 4], [12, 'E4', 4]],
      ],
      // blank slate for a human (Henry) — snap-to-scale has your back
      empty: [[]],
    },
  },

  patterns: [
    // 1: verse — steady, padded
    { lanes: { drums: 'four', bass: 'octave', chords: 'pad', melody: 'hook' },  chords: [Em, C, G, D] },
    // 2: chorus — busier kit, driving bass, stabbed chords, melody yours
    { lanes: { drums: 'breaks', bass: 'drive', chords: 'stab', melody: 'empty' }, chords: [Em, C, G, D] },
    // 3: breakdown — half-time, pads, space to breathe
    { lanes: { drums: 'half-time', bass: 'octave', chords: 'pad', melody: 'empty' }, chords: [Em, C, G, D] },
  ],

  chain: [0, 0, 1, 0, 0, 1, 2, 0],

  fills: {
    'snare roll': { kick: [0], snare: [8, 9, 10, 11, 12, 13, 14, 15] },
    'tom run':    { kick: [0], tom: [[6, 7], [8, 5], [10, 3], [12, 0], [14, -3]], crash: [0] },
  },
};
