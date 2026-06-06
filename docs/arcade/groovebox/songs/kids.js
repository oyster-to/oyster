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

// Lower chord voicings (which sit around octave 3–4) into bass register (~octave 1–2).
function low(n) { return transposeNote(n, -24); }

// Chop steps from the prototype's MEL.chopped (CH array).
const CHOP_STEPS = [0,1,2,4,6,7,8,10,11,14,15];

export const kids = {
  title: 'Kids',
  artist: 'MGMT',
  meter: { beatsPerBar:4, beatUnit:4, stepsPerBeat:4 },
  bpm: 120,
  arrangement: [
    { bars:4, lanes:{ drums:'four',     bass:'octave',  chords:'pad',  melody:'hook' }, fill:'tom roll' },
    { bars:4, lanes:{ drums:'backbeat', bass:'eighths', chords:'pad',  melody:'hook' }, fill:'snare roll' },
    { bars:4, lanes:{ drums:'NIN',      bass:'16ths',   chords:'stab', melody:'hook' }, fill:'crash build' },
    { bars:4, lanes:{ drums:'four',     bass:'octave',  chords:'arp',  melody:'hook' }, fill:'glitch' },
  ],
  fills: {
    'tom roll':   { kick:[0,4], tom:[[8,7],[9,5],[10,3],[11,4],[12,2],[13,0],[14,-2],[15,-4]] },
    'snare roll': { kick:[0], snare:[8,9,10,11,12,13,14,15] },
    'crash build':{ kick:[0,8], hat:[0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15], snare:[14,15], crash:[12] },
    'glitch':     { snare:[0,1,2,6,7,10,11,12], kick:[4,8,14], crash:[0] },
    'snare 4s':   { kick:[0,8], snare:[0,4,8,12] },
    'snare 8ths': { kick:[0], snare:[0,2,4,6,8,10,12,14] },
    'snare stutter':{ kick:[0,8], snare:[12,13,14,15] },
    'kick build': { kick:[0,2,4,6,8,10,12,14], snare:[15] },
    '16th roll':  { snare:[0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15] },
    'tom run':    { kick:[0], tom:[[6,7],[7,5],[8,3],[10,2],[12,0],[14,-3]], crash:[0] },
    'flam':       { kick:[0,8], snare:[3,4,11,12] },
    'crash stabs':{ kick:[0,4,8,12], crash:[0,4,8,12] },
    'crash + tom':{ kick:[0,8], tom:[[10,5],[12,2]], crash:[0,14] },
    'gated glitch':{ snare:[0,1,4,5,8,9,12,13], kick:[6,14], crash:[2,10] },
  },
  // Key: A major — progression F#m–D–A–E/G# are all diatonic to A major
  // (the song's tonal centre, though it opens on the relative minor F#m).
  harmony: { key: { root:'A', mode:'major' }, progression: [
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
                'boom-cha roll': [
                  { kick:[0,4,8,12], snare:[2,6,10,14] },
                  { kick:[0,4,8],    snare:[2,6,10,13,14,15] },
                ],
                'boom-bap': { kick:[0,7,10], snare:[4,12], hat:[0,2,4,6,8,10,12,14] },
                'half-time':{ kick:[0], snare:[8], hat:[0,2,4,6,8,10,12,14] },
                'tribal toms':{ kick:[0,8], snare:[8], tom:[[2,7],[4,5],[6,3],[10,7],[12,5],[14,0]] },
                breaks:   { kick:[0,6,10], snare:[4,12], hat:[0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15] },
                house:    { kick:[0,4,8,12], snare:[4,12],  hat:[2,6,10,14] },
                NIN:      { kick:[0,3,4,7,8,11,12,15], snare:[2,6,10,14],
                            hat:[0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15], crash:[0] },
              } },
    bass:   { selection:'octave', muted:false,
              pool:{
                octave:   (bar,chord) => [0,2,4,6,8,10,12,14].map((s,i) =>
                            [s, i%2 ? transposeNote(chord.root, 12) : chord.root, 2]),
                eighths:  (bar,chord) => [0,2,4,6,8,10,12,14].map(s => [s, chord.root, 2]),
                '16ths':  (bar,chord) => Array.from({length:16},(_,s) => [s, chord.root, 1]),
                'on-beat':(bar,chord) => [0,4,8,12].map(s => [s, chord.root, 4]),
                whole:    (bar,chord) => [[0, chord.root, 16]],
                offbeat:  (bar,chord) => [2,6,10,14].map(s => [s, chord.root, 2]),
                walking:  (bar,chord) => [0,4,8,12].map((s,i) =>
                            [s, low(chord.voicing[i % chord.voicing.length]), 4]),
                counter:  (bar,chord) => {
                  const v = chord.voicing;
                  return [
                    [0,  chord.root,                    2],
                    [3,  low(v[2] || v[0]),             2],
                    [6,  low(v[1] || v[0]),             2],
                    [10, chord.root,                    2],
                    [12, low(v[1] || v[0]),             2],
                    [14, low(v[0]),                     2],
                  ];
                },
                'scale run': (bar,chord) => {
                  const v = chord.voicing;
                  const scale = [
                    chord.root,
                    low(v[1] || v[0]),
                    low(v[2] || v[1] || v[0]),
                    transposeNote(chord.root, 12),
                    low(v[0]),
                    low(v[1] || v[0]),
                    low(v[2] || v[1] || v[0]),
                    transposeNote(chord.root, 24),
                  ];
                  return [0,2,4,6,8,10,12,14].map((s,i) => [s, scale[i], 2]);
                },
                busy:     (bar,chord) => {
                  const v = chord.voicing;
                  const r = chord.root, r8 = transposeNote(chord.root, 12);
                  return [
                    [0,  r,                 2],
                    [2,  low(v[0]),         1],
                    [3,  low(v[1] || v[0]), 1],
                    [6,  low(v[2] || v[0]), 2],
                    [8,  r,                 2],
                    [10, low(v[1] || v[0]), 1],
                    [11, low(v[0]),         1],
                    [14, r8,                2],
                  ];
                },
              } },
    chords: { selection:'pad', muted:false },
    melody: { selection:'hook', muted:false, pool:{
      hook: RIFF,
      chopped: RIFF.map(bar => {
        if (!bar.length) return [];
        const notes = bar.map(x => x[1]);
        return CHOP_STEPS.map((st, i) => [st, notes[i % notes.length], 1]);
      }),
    } },
  },
};
