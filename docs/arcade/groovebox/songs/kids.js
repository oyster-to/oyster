// MGMT "Kids" — A major, F#m–D–A–E/G#; melody transcribed from the MIDI (per-bar [step,note,durSteps]).
const RIFF = [
  [[0,'A4',2],[4,'B4',2],[8,'C#5',2],[12,'E5',2]],
  [[0,'F#5',4],[4,'G#5',2],[6,'F#5',2],[10,'E5',4],[14,'C#5',17]],
  [],
  [[0,'B4',15]],
];

// Semitone-transpose a note name (e.g. 'F#2') by an integer number of semitones.
// Tone-free: works in Node, safe to call in tests.
function transposeNote(note, semis) {
  const m = note.match(/^([A-G]#?)(-?\d+)$/);
  if (!m) return note;
  const NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
  const idx = NAMES.indexOf(m[1]);
  if (idx < 0) return note;
  const total = idx + (parseInt(m[2]) + 1) * 12 + semis;
  return NAMES[((total % 12) + 12) % 12] + (Math.floor(total / 12) - 1);
}

export const kids = {
  meter: { beatsPerBar:4, beatUnit:4, stepsPerBeat:4 },
  bpm: 120,
  fills: {
    'tom roll':   { kick:[0,4], tom:[[8,7],[9,5],[10,3],[11,4],[12,2],[13,0],[14,-2],[15,-4]] },
    'snare roll': { kick:[0], snare:[8,9,10,11,12,13,14,15] },
    'crash build':{ kick:[0,8], hat:[0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15], snare:[14,15], crash:[12] },
    'glitch':     { snare:[0,1,2,6,7,10,11,12], kick:[4,8,14], crash:[0] },
  },
  harmony: { progression: [
    { name:'F#m',  root:'F#2', voicing:['F#3','A3','C#4','E4'] },
    { name:'D',    root:'D2',  voicing:['D3','E3','A3'] },
    { name:'A',    root:'A2',  voicing:['A3','C#4','E4'] },
    { name:'E/G#', root:'G#2', voicing:['G#3','B3','E4'] },
  ]},
  lanes: {
    drums:  { selection:'four', muted:false, cycleLen:4,
              pool:{
                four:     { kick:[0,4,8,12], snare:[4,12],  hat:[0,2,4,6,8,10,12,14] },
                backbeat: { kick:[0,8],       snare:[4,12],  hat:[2,6,10,14] },
                'boom-cha':{ kick:[0,4,8,12], snare:[2,6,10,14] },
                house:    { kick:[0,4,8,12], snare:[4,12],  hat:[2,6,10,14] },
                NIN:      { kick:[0,3,4,7,8,11,12,15], snare:[2,6,10,14],
                            hat:[0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15], crash:[0] },
              } },
    bass:   { selection:'octave', muted:false,
              pool:{
                octave:  (bar,chord) => [0,2,4,6,8,10,12,14].map((s,i) =>
                           [s, i%2 ? transposeNote(chord.root, 12) : chord.root, 2]),
                eighths: (bar,chord) => [0,2,4,6,8,10,12,14].map(s => [s, chord.root, 2]),
                '16ths': (bar,chord) => Array.from({length:16},(_,s) => [s, chord.root, 1]),
                'on-beat':(bar,chord) => [0,4,8,12].map(s => [s, chord.root, 4]),
                whole:   (bar,chord) => [[0, chord.root, 16]],
              } },
    chords: { selection:'pad', muted:false },
    melody: { selection:'hook', muted:false, pool:{ hook: RIFF } },
  },
};
