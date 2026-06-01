// Electric Feel (MGMT) — auto-imported from MIDI (4/4 @ 102bpm, 16-bar loop).
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
    [[12,'C3',1],[14,'C3',2]],
    [[2,'C3',2],[4,'G2',1],[8,'G#2',8]],
    [[4,'A#1',2],[6,'A#2',1],[8,'C2',2],[10,'C3',1],[12,'G2',2]],
    [[0,'G#2',8],[12,'C3',1],[14,'C3',2]],
    [[2,'C3',2],[4,'G2',1],[8,'G#2',8]],
    [[4,'A#1',2],[6,'A#2',1],[8,'C2',2],[10,'C3',1],[12,'G2',2]],
    [[0,'G#2',8],[12,'C3',1],[14,'C3',2]],
    [[2,'C3',2],[4,'G2',1],[8,'G#2',8]],
    [[4,'A#1',2],[6,'A#2',1],[8,'C2',2],[10,'C3',1],[12,'G2',2]],
    [[0,'G#2',8],[12,'C3',1],[14,'C3',2]],
    [[2,'C3',2],[4,'G2',1],[8,'G#2',8]],
    [[4,'A#1',2],[6,'A#2',1],[8,'C2',2],[10,'C3',1],[12,'G2',2]],
    [[0,'G#2',8],[12,'C3',1],[14,'C3',2]],
    [[2,'C3',2],[4,'G2',1],[8,'G#2',8]],
    [[4,'A#1',2],[6,'A#2',1],[8,'C2',2],[10,'C3',1],[12,'G2',2]],
    [[0,'G#2',8],[12,'C3',1],[14,'C3',2]]
  ];

export const electricFeel = {
  meter: { beatsPerBar:4, beatUnit:4, stepsPerBeat:4 },
  bpm: 102,
  arrangement: [
    { bars:16, lanes:{ drums:'midi', bass:'midi', chords:'pad', melody:'lead' }, fill:'snare roll' },
    { bars:16, lanes:{ drums:'four', bass:'octave', chords:'arp', melody:'lead' }, fill:'crash build' },
  ],
  fills: {
    'snare roll': { kick:[0], snare:[8,9,10,11,12,13,14,15] },
    'crash build':{ kick:[0,8], snare:[14,15], crash:[12] },
    'tom roll':   { kick:[0,4], tom:[[8,7],[10,3],[12,2],[14,-2]] },
  },
  harmony: { progression: [
    { name:'C', root:'C2', voicing:['C3','E3','G3'] },
    { name:'D#', root:'D#2', voicing:['D#3','G3','A#3'] },
    { name:'Cm', root:'C2', voicing:['C3','D#3','G3'] },
    { name:'A#', root:'A#2', voicing:['A#3','D3','F3'] },
    { name:'D#', root:'D#2', voicing:['D#3','G3','A#3'] },
    { name:'Cm', root:'C2', voicing:['C3','D#3','G3'] },
    { name:'A#', root:'A#2', voicing:['A#3','D3','F3'] },
    { name:'D#', root:'D#2', voicing:['D#3','G3','A#3'] },
    { name:'Cm', root:'C2', voicing:['C3','D#3','G3'] },
    { name:'A#', root:'A#2', voicing:['A#3','D3','F3'] },
    { name:'D#', root:'D#2', voicing:['D#3','G3','A#3'] },
    { name:'Cm', root:'C2', voicing:['C3','D#3','G3'] },
    { name:'Cm', root:'C2', voicing:['C3','D#3','G3'] },
    { name:'Gm', root:'G2', voicing:['G3','A#3','D3'] },
    { name:'Gm', root:'G2', voicing:['G3','A#3','D3'] },
    { name:'G#', root:'G#2', voicing:['G#3','C3','D#3'] },
  ]},
  lanes: {
    drums:  { selection:'midi', muted:false, cycleLen:16,
              pool:{
                midi: [
        {crash:[12], hat:[12,14], kick:[12]},
        {hat:[0,2,4,6,8,10,12,14], snare:[0,12], kick:[4,8]},
        {hat:[0,2,4,6,8,10,12,14], snare:[0,8], kick:[4,12]},
        {hat:[0,2,4,6,8,10,12,14], kick:[0,12], snare:[4,8]},
        {hat:[0,2,4,6,8,10,12,14], snare:[0,12], kick:[4,8]},
        {hat:[0,2,4,6,8,10,12,14], snare:[0,8], kick:[4,12]},
        {hat:[0,2,4,6,8,10,12,14], kick:[0,12], snare:[4,8], crash:[12]},
        {hat:[0,2,4,6,8,10,12,14], snare:[0,12], kick:[4,8]},
        {hat:[0,2,4,6,8,10,12,14], snare:[0,8], kick:[4,12]},
        {hat:[0,2,4,6,8,10,12,14], kick:[0,12], snare:[4,8]},
        {hat:[0,2,4,6,8,10,12,14], snare:[0,12], kick:[4,8]},
        {hat:[0,2,4,6,8,10,12,14], snare:[0,8], kick:[4,12]},
        {hat:[0,2,4,6,8,10], kick:[0,12], snare:[4,8], tom:[[12,0],[14,0],[15,0]]},
        {snare:[0,8], tom:[[2,0],[3,0],[4,0],[6,0],[7,0],[10,0],[11,0],[12,0],[14,0],[15,0]], kick:[4,12]},
        {snare:[0,8], tom:[[2,0],[3,0],[4,0],[6,0],[7,0],[10,0],[11,0],[12,0],[14,0],[15,0]], kick:[4,12]},
        {snare:[0,8], tom:[[2,0],[3,0],[4,0],[6,0],[7,0],[10,0],[11,0],[12,0],[14,0],[15,0]], kick:[4,12]}
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
      [[12,'C5',2]],
      [[0,'C5',2],[4,'C5',2],[8,'C5',2],[12,'C5',2]],
      [[0,'C5',2],[4,'C5',2],[8,'C5',2],[12,'C5',2]],
      [[0,'C5',2],[4,'C5',2],[8,'C5',2],[12,'C5',2]],
      [[0,'C5',2],[4,'C5',2],[8,'C5',2],[12,'C5',2]],
      [[0,'C5',2],[4,'C5',2],[8,'C5',2],[12,'C5',2]],
      [[0,'C5',2],[4,'C5',2],[8,'C5',2],[12,'C5',2]],
      [[0,'C5',2],[4,'C5',2],[8,'C5',2],[12,'C5',2]],
      [[0,'C5',2],[4,'C5',2],[8,'C5',2],[12,'C5',2]],
      [[0,'C5',2],[4,'C5',2],[8,'C5',2],[12,'C5',2]],
      [[0,'C5',2],[4,'C5',2],[8,'C5',2],[12,'C5',2]],
      [[0,'C5',2],[4,'C5',2],[8,'C5',2],[12,'C5',2]],
      [[0,'C5',2],[4,'C5',2],[8,'C5',2]],
      [],
      [],
      []
    ],
    } },
  },
};
