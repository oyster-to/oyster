// Electric Feel (MGMT) — auto-imported from MIDI (4/4 @ 110bpm, 3-bar loop).
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
    [[0,'C2',1],[2,'C2',1],[4,'C2',1],[6,'C2',1],[8,'C2',1],[10,'C2',1],[12,'G#1',1],[14,'G#1',1]],
    [[0,'G#1',1],[2,'G#1',1],[4,'G#1',1],[6,'G#1',1],[8,'A#1',1],[10,'A#1',1],[12,'A#1',1],[14,'A#1',1]],
    [[0,'A#1',1],[2,'A#1',1],[4,'G1',1],[6,'G1',1],[8,'G1',1],[10,'G1',1],[12,'G1',1],[14,'G1',1]]
  ];

export const electricFeel = {
  title: 'Electric Feel',
  artist: 'MGMT',
  meter: { beatsPerBar:4, beatUnit:4, stepsPerBeat:4 },
  bpm: 110,
  arrangement: [
    { bars:3, lanes:{ drums:'midi', bass:'midi', chords:'pad', melody:'lead' }, fill:'snare roll' },
    { bars:3, lanes:{ drums:'four', bass:'octave', chords:'arp', melody:'lead' }, fill:'crash build' },
  ],
  fills: {
    'snare roll': { kick:[0], snare:[8,9,10,11,12,13,14,15] },
    'crash build':{ kick:[0,8], snare:[14,15], crash:[12] },
    'tom roll':   { kick:[0,4], tom:[[8,7],[10,3],[12,2],[14,-2]] },
  },
  // Key: G# major — the riff anchors on G# (G#, G#, Gm); tonic = first chord.
  harmony: { key: { root:'G#', mode:'major' }, progression: [
    { name:'G#', root:'G#2', voicing:['G#3','C3','D#3'] },
    { name:'G#', root:'G#2', voicing:['G#3','C3','D#3'] },
    { name:'Gm', root:'G2', voicing:['G3','A#3','D3'] },
  ]},
  lanes: {
    drums:  { selection:'midi', muted:false, cycleLen:3,
              pool:{
                midi: [
        {hat:[0,2,4,6,8,10,12,14], crash:[0,8,12], kick:[0,12], snare:[4,8]},
        {snare:[0,4,12], hat:[0,2,4,6,8,10,12,14], crash:[4,8], kick:[8]},
        {snare:[0,8,12], hat:[0,2,4,6,8,10,12], crash:[0,4], kick:[4]}
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
      [[4,'D#5',1],[6,'F5',1],[7,'F5',1],[8,'G5',1],[10,'A#5',1],[11,'A#5',1],[12,'F5',1],[14,'G5',1],[15,'G5',1]],
      [[0,'D#5',1],[2,'F5',1],[3,'F5',1],[4,'C5',1],[6,'D#5',1],[7,'D#5',1],[8,'F5',1],[12,'F5',1],[14,'D#5',1],[15,'D#5',1]],
      [[0,'G5',1],[2,'F5',1],[3,'F5',1],[4,'D#5',1],[6,'F5',1],[7,'F5',1],[8,'C5',1],[10,'D#5',1],[11,'D#5',1],[12,'A#4',1],[14,'C5',1],[15,'C5',1]]
    ],
    } },
  },
};
