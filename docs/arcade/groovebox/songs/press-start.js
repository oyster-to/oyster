// "Press Start" — an upbeat game opening theme in the Mario/Sonic idiom,
// authored directly in the v2 schema by an AI. C major, 144 BPM.
// Ingredients: oom-pah root-fifth bass (the classic game bass), offbeat chord
// stabs (the Sonic skank), staccato repeated-note hooks with arpeggio leaps,
// fanfare intro. Composed by Claude, 2026-06-06.

const C  = { name: 'C',  root: 'C2', voicing: ['C3', 'E3', 'G3'] };
const F  = { name: 'F',  root: 'F2', voicing: ['F3', 'A3', 'C4'] };
const G  = { name: 'G',  root: 'G2', voicing: ['G3', 'B3', 'D4'] };
const Am = { name: 'Am', root: 'A2', voicing: ['A3', 'C4', 'E4'] };

export const pressStart = {
  version: 2,
  title: 'Press Start',
  artist: 'Claude × Oyster',
  meter: { beatsPerBar: 4, beatUnit: 4, stepsPerBeat: 4 },
  bpm: 144,
  key: { root: 'C', mode: 'major' },

  lanes: [
    { id: 'drums',  type: 'drums',  name: 'drums',  muted: false, soloed: false },
    { id: 'bass',   type: 'bass',   name: 'bass',   muted: false, soloed: false },
    { id: 'chords', type: 'chords', name: 'chords', muted: false, soloed: false },
    { id: 'melody', type: 'melody', name: 'melody', muted: false, soloed: false, tone: 'square' },
  ],

  grooves: {
    drums: {
      // fanfare bed — sparse, big crash
      fanfare: [{ kick: [0, 8], snare: [12], hat: [0, 2, 4, 6, 8, 10, 12, 14], crash: [0] }],
      // main run — driving 16th hats, four on the floor
      sprint:  [{ kick: [0, 4, 8, 12], snare: [4, 12], hat: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] }],
      // B section — syncopated kick, lighter hats
      skip:    [{ kick: [0, 6, 8, 14], snare: [4, 12], hat: [0, 2, 4, 6, 8, 10, 12, 14] }],
    },
    bass: {
      // THE game bass: root/fifth oom-pah in 8ths
      'oom-pah': { relative: true, bars: [[[0, 'R', 2], [2, 'V2-12', 2], [4, 'R', 2], [6, 'V2-12', 2], [8, 'R', 2], [10, 'V2-12', 2], [12, 'R', 2], [14, 'V2-12', 2]]] },
      // octave bounce for the B section lift
      octave:    { relative: true, bars: [[[0, 'R', 2], [2, 'R+12', 2], [4, 'R', 2], [6, 'R+12', 2], [8, 'R', 2], [10, 'R+12', 2], [12, 'R', 2], [14, 'R+12', 2]]] },
    },
    chords: {
      // the Sonic skank: stabs on the offbeats only
      'offbeat-stab': { relative: true, bars: [[[2, 'V*', 2], [6, 'V*', 2], [10, 'V*', 2], [14, 'V*', 2]]] },
      pad:            { relative: true, bars: [[[0, 'V*', 'bar']]] },
    },
    melody: {
      // fanfare: rising arpeggio flourish, then a held high note
      fanfare: [
        [[0, 'C4', 2], [2, 'E4', 2], [4, 'G4', 2], [6, 'C5', 2], [8, 'E5', 4], [12, 'D5', 2], [14, 'B4', 2]],
        [[0, 'D5', 2], [2, 'B4', 2], [4, 'G4', 2], [6, 'B4', 2], [8, 'D5', 8]],
      ],
      // A hook: staccato repeated notes + leaps (the Mario rhythm DNA, original tune)
      'hook-a': [
        [[0, 'G4', 1], [2, 'G4', 1], [4, 'E4', 2], [8, 'G4', 1], [10, 'A4', 1], [12, 'C5', 2]],
        [[0, 'A4', 2], [4, 'G4', 1], [6, 'F4', 1], [8, 'A4', 2], [12, 'C5', 2], [14, 'A4', 2]],
        [[0, 'B4', 1], [2, 'B4', 1], [4, 'G4', 2], [8, 'D5', 2], [12, 'B4', 2], [14, 'A4', 2]],
        [[0, 'A4', 2], [4, 'C5', 2], [8, 'D5', 1], [10, 'C5', 1], [12, 'A4', 1], [14, 'G4', 1]],
      ],
      // B hook: longer notes, the emotional lift before returning to the run
      'hook-b': [
        [[0, 'E5', 4], [4, 'C5', 2], [6, 'B4', 2], [8, 'A4', 4], [12, 'B4', 2], [14, 'C5', 2]],
        [[0, 'D5', 4], [4, 'C5', 2], [6, 'A4', 2], [8, 'F4', 6]],
        [[0, 'E5', 4], [4, 'G5', 2], [6, 'E5', 2], [8, 'C5', 4], [12, 'D5', 2], [14, 'E5', 2]],
        [[0, 'D5', 4], [4, 'B4', 2], [6, 'A4', 2], [8, 'G4', 4], [12, 'B4', 2], [14, 'D5', 2]],
      ],
      // blank slate — yours
      empty: [[]],
    },
  },

  patterns: [
    // 0: fanfare intro — "press start"
    { lanes: { drums: 'fanfare', bass: 'oom-pah', chords: 'pad', melody: 'fanfare' }, chords: [C, G] },
    // 1: the run — main theme
    { lanes: { drums: 'sprint', bass: 'oom-pah', chords: 'offbeat-stab', melody: 'hook-a' }, chords: [C, F, G, F] },
    // 2: the lift — B section
    { lanes: { drums: 'skip', bass: 'octave', chords: 'offbeat-stab', melody: 'hook-b' }, chords: [Am, F, C, G] },
  ],

  // intro → run ×2 → lift → run (loops forever, like a level should)
  chain: [0, 1, 1, 2, 1],

  fills: {
    'snare roll': { kick: [0], snare: [8, 9, 10, 11, 12, 13, 14, 15] },
    'tom run':    { kick: [0], tom: [[6, 7], [8, 5], [10, 3], [12, 0], [14, -3]], crash: [0] },
  },
};
