// Take On Me — auto-imported from MIDI (4/4 @ 169bpm, 16-bar loop).
// PLACEHOLDER / copyright: swap before any public release. Auto-transcription —
// melody=top-note, drums=GM-mapped, chords=inferred; audition + tweak as needed.
function transposeNote(note, semis) {
  const m = note.match(/^([A-G]#?)(-?\d+)$/); if (!m) return note;
  const N = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
  const i = N.indexOf(m[1]); if (i < 0) return note;
  const t = i + (parseInt(m[2]) + 1) * 12 + semis;
  return N[((t % 12) + 12) % 12] + (Math.floor(t / 12) - 1);
}
const BASS = [
    [],
    [],
    [],
    [],
    [],
    [],
    [],
    [],
    [],
    [],
    [],
    [],
    [[0,'B1',2],[2,'D2',2],[6,'F#2',2],[8,'A2',2],[10,'F#2',2],[14,'D2',2]],
    [[0,'B1',2],[2,'E2',2],[6,'G#2',2],[8,'B2',2],[10,'G#2',2],[14,'E2',2]],
    [[0,'A1',2],[2,'C#2',2],[6,'E2',2],[8,'A2',2],[10,'E2',2],[14,'C#2',2]],
    [[0,'D2',2],[2,'F#2',2],[6,'A2',2],[8,'C#2',2],[10,'D2',2],[12,'F#2',2],[14,'C#3',2]]
  ];

export const takeOnMe = {
  title: 'Take On Me',
  artist: 'a-ha',
  meter: { beatsPerBar:4, beatUnit:4, stepsPerBeat:4 },
  bpm: 169,
  arrangement: [
    { bars:16, lanes:{ drums:'four', bass:'midi', chords:'pad', melody:'lead' }, fill:'snare roll' },
    { bars:16, lanes:{ drums:'backbeat', bass:'octave', chords:'arp', melody:'lead' }, fill:'crash build' },
  ],
  fills: {
    'snare roll': { kick:[0], snare:[8,9,10,11,12,13,14,15] },
    'crash build':{ kick:[0,8], snare:[14,15], crash:[12] },
    'tom roll':   { kick:[0,4], tom:[[8,7],[10,3],[12,2],[14,-2]] },
  },
  // Key: C major — the vamp opens and dwells on C; tonic = first chord.
  harmony: { key: { root:'C', mode:'major' }, progression: [
    { name:'C', root:'C2', voicing:['C3','E3','G3'] },
    { name:'C', root:'C2', voicing:['C3','E3','G3'] },
    { name:'C', root:'C2', voicing:['C3','E3','G3'] },
    { name:'C', root:'C2', voicing:['C3','E3','G3'] },
    { name:'C', root:'C2', voicing:['C3','E3','G3'] },
    { name:'E', root:'E2', voicing:['E3','G#3','B3'] },
    { name:'E', root:'E2', voicing:['E3','G#3','B3'] },
    { name:'E', root:'E2', voicing:['E3','G#3','B3'] },
    { name:'F#', root:'F#2', voicing:['F#3','A#3','C#3'] },
    { name:'G#', root:'G#2', voicing:['G#3','C3','D#3'] },
    { name:'D', root:'D2', voicing:['D3','F#3','A3'] },
    { name:'E', root:'E2', voicing:['E3','G#3','B3'] },
    { name:'E', root:'E2', voicing:['E3','G#3','B3'] },
    { name:'E', root:'E2', voicing:['E3','G#3','B3'] },
    { name:'E', root:'E2', voicing:['E3','G#3','B3'] },
    { name:'E', root:'E2', voicing:['E3','G#3','B3'] },
  ]},
  lanes: {
    drums:  { selection:'four', muted:false, cycleLen:16,
              pool:{
                midi: [
        {},
        {},
        {},
        {},
        {},
        {},
        {},
        {},
        {},
        {},
        {},
        {},
        {},
        {},
        {},
        {}
      ],
                four:     { kick:[0,4,8,12], snare:[4,12], hat:[0,2,4,6,8,10,12,14] },
                backbeat: { kick:[0,8], snare:[4,12], hat:[2,6,10,14] },
              } },
    bass:   { selection:'midi', muted:false,
              pool:{
                midi:    (bar) => BASS[bar % BASS.length],
                octave:  (bar,chord) => [0,2,4,6,8,10,12,14].map((s,i) => [s, i%2 ? transposeNote(chord.root,12) : chord.root, 2]),
                whole:   (bar,chord) => [[0, chord.root, 16]],
              } },
    chords: { selection:'pad', muted:false },
    melody: { selection:'lead', muted:false, pool:{
      lead: [
      [[0,'F#4',1],[2,'F#4',1],[4,'D4',1],[6,'B3',1],[10,'B3',1],[14,'E4',1]],
      [[2,'E4',1],[6,'E4',1],[8,'G#4',1],[10,'G#4',1],[12,'A4',1],[14,'B4',1]],
      [[0,'A4',1],[2,'A4',1],[4,'A4',1],[6,'E4',1],[10,'D4',1],[14,'F#4',1]],
      [[2,'F#4',1],[6,'F#4',1],[8,'E4',1],[10,'E4',1],[12,'F#4',1],[14,'E4',1]],
      [[0,'F#4',1],[2,'F#4',1],[4,'D4',1],[6,'B3',1],[10,'B3',1],[14,'E4',1]],
      [[2,'E4',1],[6,'E4',1],[8,'G#4',1],[10,'G#4',1],[12,'A4',1],[14,'B4',1]],
      [[0,'A4',1],[2,'A4',1],[4,'A4',1],[6,'E4',1],[10,'D4',1],[14,'F#4',1]],
      [[2,'F#4',1],[6,'F#4',1],[8,'E4',1],[10,'E4',1],[12,'F#4',1],[14,'E4',1]],
      [[0,'F#4',1],[2,'F#4',1],[4,'D4',1],[6,'B3',1],[10,'B3',1],[14,'E4',1]],
      [[2,'E4',1],[6,'E4',1],[8,'G#4',1],[10,'G#4',1],[12,'A4',1],[14,'B4',1]],
      [[0,'A4',1],[2,'A4',1],[4,'A4',1],[6,'F#4',1],[10,'D4',1],[14,'F#4',1]],
      [[2,'F#4',1],[6,'F#4',1],[8,'E4',1],[10,'E4',1],[12,'E4',1]],
      [],
      [],
      [],
      []
    ],
    } },
  },
};
