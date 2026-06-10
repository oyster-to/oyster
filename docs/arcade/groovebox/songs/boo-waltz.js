// "Boo Waltz" — spooky haunted-mansion theme (Luigi's Mansion idiom), authored
// in v2 by an AI. D minor waltz (3/4, 12 steps/bar, beats at 0/4/8): oom-cha-cha
// bass, sine-wave theremin lead drifting through C# (harmonic minor) and a
// chromatic creep. A MAJOR as V = the menace. Composed by Claude, 2026-06-06.

const Dm = { name: 'Dm', root: 'D2', voicing: ['D3', 'F3', 'A3'] };
const Gm = { name: 'Gm', root: 'G2', voicing: ['G3', 'A#3', 'D4'] };
const A  = { name: 'A',  root: 'A2', voicing: ['A3', 'C#4', 'E4'] };
const Bb = { name: 'Bb', root: 'A#2', voicing: ['A#3', 'D4', 'F4'] };

export const booWaltz = {
  version: 2,
  title: 'Boo Waltz',
  artist: 'Claude × Oyster',
  meter: { beatsPerBar: 3, beatUnit: 4, stepsPerBeat: 4 },
  bpm: 120,
  key: { root: 'D', mode: 'minor' },

  lanes: [
    { id: 'drums',  type: 'drums',  name: 'drums',  muted: false, soloed: false },
    { id: 'bass',   type: 'bass',   name: 'bass',   muted: false, soloed: false },
    { id: 'chords', type: 'chords', name: 'chords', muted: false, soloed: false },
    { id: 'melody', type: 'melody', name: 'melody', muted: false, soloed: false, instrument: 'preset-sine-lead' },
  ],

  grooves: {
    drums: {
      // the ballroom: soft pulse on 1, brushes on 2 and 3
      ballroom: [{ kick: [0], hat: [4, 8] }],
      // footsteps: something walks on the off-16ths
      footsteps: [{ kick: [0], hat: [4, 8], snare: [6] }],
      // the chase: toms lurch through the bar
      lurch: [{ kick: [0, 8], hat: [2, 6, 10], tom: [[4, 0], [10, -4]] }],
    },
    bass: {
      // oom-cha-cha: root on 1, fifth above on 2 and 3
      'oom-cha-cha': { relative: true, bars: [[[0, 'R', 4], [4, 'V2-12', 4], [8, 'V2-12', 4]]] },
      // dread: one long root per bar, octave dip
      dread:         { relative: true, bars: [[[0, 'R', 8], [8, 'R+12', 4]]] },
    },
    chords: {
      // organ pad, whole bar
      organ: { relative: true, bars: [[[0, 'V*', 'bar']]] },
      // waltz comps on 2 and 3
      comp:  { relative: true, bars: [[[4, 'V*', 2], [8, 'V*', 2]]] },
    },
    melody: {
      // theremin line — long sighs, C# leading tones, a ghost exhaling
      theremin: [
        [[0, 'D5', 8], [8, 'C#5', 4]],
        [[0, 'D5', 4], [4, 'F5', 4], [8, 'E5', 4]],
        [[0, 'C#5', 8], [8, 'A4', 4]],
        [[0, 'D5', 12]],
      ],
      // the creep — chromatic descent, footstep-paced
      creep: [
        [[0, 'F5', 4], [4, 'E5', 4], [8, 'D#5', 4]],
        [[0, 'D5', 4], [4, 'C#5', 4], [8, 'D5', 4]],
        [[0, 'A#4', 4], [4, 'A4', 4], [8, 'G#4', 4]],
        [[0, 'A4', 12]],
      ],
      empty: [[]],
    },
  },

  patterns: [
    // 0: the door creaks open — organ + dread, theremin alone
    { lanes: { drums: 'ballroom', bass: 'dread', chords: 'organ', melody: 'theremin' }, chords: [Dm, Gm, A, Dm] },
    // 1: the waltz proper — oom-cha-cha
    { lanes: { drums: 'footsteps', bass: 'oom-cha-cha', chords: 'comp', melody: 'theremin' }, chords: [Dm, Gm, A, Dm] },
    // 2: something's behind you — chromatic creep over the darkened turn
    { lanes: { drums: 'lurch', bass: 'oom-cha-cha', chords: 'comp', melody: 'creep' }, chords: [Bb, Gm, A, A] },
  ],

  chain: [0, 1, 1, 2, 1],

  fills: {
    'thunder': { kick: [0, 4, 8], tom: [[2, 7], [6, 3], [10, -2]], crash: [0] },
  },
};
