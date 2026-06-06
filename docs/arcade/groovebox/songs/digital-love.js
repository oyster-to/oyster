// Digital Love (Daft Punk) — auto-imported from MIDI (4/4 @ 124bpm, 2-bar loop).
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
    [[0,'D2',1],[2,'D2',1],[4,'D3',1],[6,'C#2',1],[8,'C#3',1],[10,'F#2',1],[12,'C#3',1],[14,'E2',1]],
    [[0,'B2',1],[2,'E3',1],[3,'F#3',1],[4,'B2',1],[8,'E2',1],[9,'C#4',1],[10,'A3',1],[11,'F#3',1],[12,'E2',1],[13,'B3',1],[14,'A3',1]]
  ];

export const digitalLove = {
  title: 'Digital Love',
  artist: 'Daft Punk',
  meter: { beatsPerBar:4, beatUnit:4, stepsPerBeat:4 },
  bpm: 124,
  arrangement: [
    { bars:2, lanes:{ drums:'four', bass:'midi', chords:'pad', melody:'lead' }, fill:'snare roll' },
    { bars:2, lanes:{ drums:'backbeat', bass:'octave', chords:'arp', melody:'lead' }, fill:'crash build' },
  ],
  fills: {
    'snare roll': { kick:[0], snare:[8,9,10,11,12,13,14,15] },
    'crash build':{ kick:[0,8], snare:[14,15], crash:[12] },
    'tom roll':   { kick:[0,4], tom:[[8,7],[10,3],[12,2],[14,-2]] },
  },
  // Key: C# minor — opens on C#m (i); C#m–E are diatonic to C# natural minor.
  harmony: { key: { root:'C#', mode:'minor' }, progression: [
    { name:'C#m', root:'C#2', voicing:['C#3','E3','G#3'] },
    { name:'E', root:'E2', voicing:['E3','G#3','B3'] },
  ]},
  lanes: {
    drums:  { selection:'four', muted:false, cycleLen:2,
              pool:{
                midi: [
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
      [[0,'F#4',1],[2,'F#4',1],[4,'D3',1],[6,'E4',1],[8,'C#3',1],[10,'A4',1],[12,'C#3',1],[14,'G#4',1]],
      [[0,'B2',1],[2,'E4',1],[3,'F#4',1],[4,'A4',1],[8,'G#4',1],[9,'A4',1],[10,'F#4',1],[11,'D4',1],[12,'F#4',1],[13,'G#4',1],[14,'F#4',1]]
    ],
    } },
  },
};
