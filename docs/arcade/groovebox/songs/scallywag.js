// "Scallywag" — Monkey Island-esque pirate theme, authored in v2 by an AI.
// A minor, 6/8 lilt (12 steps/bar, pulses at 0 and 6) — the actual meter of the
// great pirate themes. E MAJOR as the V chord = harmonic-minor flavour (that
// G# is the whole pirate sound). Triangle lead ≈ marimba. Composed by Claude.

const Am = { name: 'Am', root: 'A2', voicing: ['A3', 'C4', 'E4'] };
const G  = { name: 'G',  root: 'G2', voicing: ['G3', 'B3', 'D4'] };
const F  = { name: 'F',  root: 'F2', voicing: ['F3', 'A3', 'C4'] };
const C  = { name: 'C',  root: 'C2', voicing: ['C3', 'E3', 'G3'] };
const E  = { name: 'E',  root: 'E2', voicing: ['E3', 'G#3', 'B3'] };

export const scallywag = {
  version: 2,
  title: 'Scallywag',
  artist: 'Claude × Oyster',
  meter: { beatsPerBar: 6, beatUnit: 8, stepsPerBeat: 2, group: 3 },
  bpm: 100,
  key: { root: 'A', mode: 'minor' },

  lanes: [
    { id: 'drums',  type: 'drums',  name: 'drums',  muted: false, soloed: false },
    { id: 'bass',   type: 'bass',   name: 'bass',   muted: false, soloed: false },
    { id: 'chords', type: 'chords', name: 'chords', muted: false, soloed: false },
    { id: 'melody', type: 'melody', name: 'melody', muted: false, soloed: false, instrument: 'preset-triangle-lead' },
  ],

  grooves: {
    drums: {
      // gentle ship-sway: pulses on the two dotted quarters
      sway:  [{ kick: [0, 6], hat: [0, 2, 4, 6, 8, 10] }],
      // tavern stomp: snare answers on the second pulse
      stomp: [{ kick: [0, 6], snare: [6], hat: [0, 2, 4, 6, 8, 10] }],
      // full sail: busier kick, crash to open
      'full sail': [{ kick: [0, 3, 6, 9], snare: [6], hat: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], crash: [0] }],
    },
    bass: {
      // lilting root → octave → fifth, the 6/8 sea-legs walk
      'sea legs': { relative: true, bars: [[[0, 'R', 4], [4, 'R+12', 2], [6, 'V2-12', 4], [10, 'R+12', 2]]] },
      // long pulls on the two big beats
      anchor:     { relative: true, bars: [[[0, 'R', 6], [6, 'V2-12', 6]]] },
    },
    chords: {
      // light skank between the pulses
      lilt: { relative: true, bars: [[[2, 'V*', 2], [8, 'V*', 2]]] },
      pad:  { relative: true, bars: [[[0, 'V*', 'bar']]] },
    },
    melody: {
      // A theme — the rolling shanty tune; G# over E = pure pirate
      shanty: [
        [[0, 'A4', 2], [2, 'B4', 2], [4, 'C5', 2], [6, 'E5', 4], [10, 'C5', 2]],
        [[0, 'B4', 2], [2, 'A4', 2], [4, 'G4', 2], [6, 'B4', 4], [10, 'D5', 2]],
        [[0, 'C5', 2], [2, 'B4', 2], [4, 'A4', 2], [6, 'E4', 4], [10, 'A4', 2]],
        [[0, 'G#4', 4], [4, 'B4', 2], [6, 'E5', 6]],
      ],
      // B theme — the chorus lift, sails full
      'horizon': [
        [[0, 'A4', 4], [4, 'C5', 2], [6, 'F5', 4], [10, 'E5', 2]],
        [[0, 'E5', 2], [2, 'D5', 2], [4, 'C5', 2], [6, 'G4', 6]],
        [[0, 'B4', 2], [2, 'C5', 2], [4, 'D5', 2], [6, 'B4', 4], [10, 'G4', 2]],
        [[0, 'G#4', 2], [2, 'A4', 2], [4, 'B4', 2], [6, 'E5', 6]],
      ],
      empty: [[]],
    },
  },

  patterns: [
    // 0: dockside — sway, pads, the tune alone
    { lanes: { drums: 'sway', bass: 'anchor', chords: 'pad', melody: 'shanty' }, chords: [Am, G, Am, E] },
    // 1: underway — stomp + skank
    { lanes: { drums: 'stomp', bass: 'sea legs', chords: 'lilt', melody: 'shanty' }, chords: [Am, G, Am, E] },
    // 2: full sail — the lift
    { lanes: { drums: 'full sail', bass: 'sea legs', chords: 'lilt', melody: 'horizon' }, chords: [F, C, G, E] },
  ],

  chain: [0, 1, 1, 2, 1],

  fills: {
    'broadside': { kick: [0, 6], tom: [[8, 5], [9, 3], [10, 0], [11, -3]], crash: [0] },
  },
};
