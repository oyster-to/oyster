// songs/blank.js — the "＋ New" starters. Minimal *alive* skeletons (never an
// empty grid), authored directly in the v2 schema (no rich/flatten dependency).
//
// Deliberate choices:
//   - drums + bass + chords only; no melody lane. Melody is literal and
//     key-bound (the song's identity) — you add it via ＋ add instrument when
//     you have an idea, not before.
//   - bass + chords are RELATIVE (R / V*) so they auto-fit whatever chords or
//     key you change to — born portable, droppable into any progression.
//   - boots playing a I–V–vi–IV in C major (all white keys): alive on hit,
//     obviously yours to reshape.
//   - meter is chosen at New (there is no meter editing at runtime); each
//     template pins one meter and picks grooves authored for it. Groove names
//     match engine/groove-presets.js — the New flow stocks the rest of the
//     library around these picks, and addGroove skips names already present.

const PROGRESSION = [   // I–V–vi–IV in C
  { name: 'C',  root: 'C2', voicing: ['C3', 'E3', 'G3'] },
  { name: 'G',  root: 'G2', voicing: ['G3', 'B3', 'D4'] },
  { name: 'Am', root: 'A2', voicing: ['A3', 'C4', 'E4'] },
  { name: 'F',  root: 'F2', voicing: ['F3', 'A3', 'C4'] },
];

function template({ meter, grooves, picks }) {
  return {
    version: 2,
    title: 'Untitled', artist: '',
    meter,
    bpm: 120,
    key: { root: 'C', mode: 'major' },
    lanes: [
      { id: 'drums',  type: 'drums',  name: 'drums',  muted: false, soloed: false },
      { id: 'bass',   type: 'bass',   name: 'bass',   muted: false, soloed: false },
      { id: 'chords', type: 'chords', name: 'chords', muted: false, soloed: false },
    ],
    grooves,
    patterns: [{ lanes: picks, chords: PROGRESSION }],
    chain: [0],
    fills: {},
  };
}

export const blank = template({
  meter: { beatsPerBar: 4, beatUnit: 4, stepsPerBeat: 4 },   // 4/4 → 16 steps/bar
  grooves: {
    drums:  { 'four on the floor': [{ kick: [0, 4, 8, 12], snare: [4, 12], hat: [0, 2, 4, 6, 8, 10, 12, 14] }] },
    bass:   { 'root quarters': { relative: true, bars: [[[0, 'R', 4], [4, 'R', 4], [8, 'R', 4], [12, 'R', 4]]] } },
    chords: { pad: { relative: true, bars: [[[0, 'V*', 'bar']]] } },
  },
  picks: { drums: 'four on the floor', bass: 'root quarters', chords: 'pad' },
});

export const blankWaltz = template({
  meter: { beatsPerBar: 3, beatUnit: 4, stepsPerBeat: 4 },   // 3/4 → 12 steps/bar
  grooves: {
    drums:  { waltz: [{ kick: [0], snare: [4, 8], hat: [0, 2, 4, 6, 8, 10] }] },
    bass:   { 'oom-cha-cha': { relative: true, bars: [[[0, 'R', 4], [4, 'V2-12', 4], [8, 'V2-12', 4]]] } },
    chords: { pad: { relative: true, bars: [[[0, 'V*', 'bar']]] } },
  },
  picks: { drums: 'waltz', bass: 'oom-cha-cha', chords: 'pad' },
});
