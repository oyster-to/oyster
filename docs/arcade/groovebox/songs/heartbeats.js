// Heartbeats (The Knife) — auto-imported from MIDI (4/4 @ 88bpm, 8-bar loop).
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
    []
  ];

export const heartbeats = {
  title: 'Heartbeats',
  artist: 'The Knife',
  meter: { beatsPerBar:4, beatUnit:4, stepsPerBeat:4 },
  bpm: 88,
  arrangement: [
    { bars:8, lanes:{ drums:'midi', bass:'octave', chords:'pad', melody:'lead' }, fill:'snare roll' },
    { bars:8, lanes:{ drums:'four', bass:'octave', chords:'arp', melody:'lead' }, fill:'crash build' },
  ],
  fills: {
    'snare roll': { kick:[0], snare:[8,9,10,11,12,13,14,15] },
    'crash build':{ kick:[0,8], snare:[14,15], crash:[12] },
    'tom roll':   { kick:[0,4], tom:[[8,7],[10,3],[12,2],[14,-2]] },
  },
  // Key: D# major — vamps D#↔C; tonic = the opening (and most-held) D# chord.
  harmony: { key: { root:'D#', mode:'major' }, progression: [
    { name:'D#', root:'D#2', voicing:['D#3','G3','A#3'] },
    { name:'D#', root:'D#2', voicing:['D#3','G3','A#3'] },
    { name:'C', root:'C2', voicing:['C3','E3','G3'] },
    { name:'C', root:'C2', voicing:['C3','E3','G3'] },
    { name:'D#', root:'D#2', voicing:['D#3','G3','A#3'] },
    { name:'D#', root:'D#2', voicing:['D#3','G3','A#3'] },
    { name:'C', root:'C2', voicing:['C3','E3','G3'] },
    { name:'C', root:'C2', voicing:['C3','E3','G3'] },
  ]},
  lanes: {
    drums:  { selection:'midi', muted:false, cycleLen:8,
              pool:{
                midi: [
        {hat:[0,1,4,5,8,9,12,13], kick:[0,3,4,8,11,12], snare:[4,12]},
        {hat:[0,1,4,5,8,9,12,13], kick:[0,3,4,8,11,12], snare:[4,12]},
        {hat:[0,1,4,5,8,9,12,13], kick:[0,3,4,8,11,12], snare:[4,12]},
        {hat:[0,1,4,5,8,9,12,13], kick:[0,3,4,8,11,12], snare:[4,12], tom:[[14,0],[15,0]]},
        {hat:[0,1,4,5,8,9,12,13], kick:[0,3,4,8,11,12], snare:[4,12]},
        {hat:[0,1,4,5,8,9,12,13], kick:[0,3,4,8,11,12], snare:[4,12]},
        {hat:[0,1,4,5,8,9,12,13], kick:[0,3,4,8,11,12], snare:[4,12]},
        {hat:[0,1,4,5,8,9,12,13], kick:[0,3,4,8,11,12], snare:[4,12]}
      ],
                four:     { kick:[0,4,8,12], snare:[4,12], hat:[0,2,4,6,8,10,12,14] },
                backbeat: { kick:[0,8], snare:[4,12], hat:[2,6,10,14] },
              } },
    bass:   { selection:'octave', muted:false,
              pool:{
                midi:    (bar) => BASS[bar % BASS.length],
                octave:  (bar,chord) => [0,2,4,6,8,10,12,14].map((s,i) => [s, i%2 ? transposeNote(chord.root,12) : chord.root, 2]),
                whole:   (bar,chord) => [[0, chord.root, 16]],
              } },
    chords: { selection:'pad', muted:false },
    melody: { selection:'lead', muted:false, pool:{
      lead: [
      [[0,'D#2',4],[7,'D#2',1],[8,'D3',1],[9,'D#3',1],[10,'D#2',2],[14,'D#2',2]],
      [[1,'D#2',1],[2,'D3',1],[3,'D#3',1],[4,'D#2',2],[7,'D#2',1],[8,'D3',1],[9,'D#3',1],[10,'D#2',2],[12,'A#2',1],[13,'D#3',1],[14,'A#2',2]],
      [[0,'C2',4],[7,'C2',1],[8,'A#2',1],[9,'C3',1],[10,'C2',2],[14,'C2',2]],
      [[1,'C2',1],[2,'A#2',1],[3,'C3',1],[4,'C2',2],[7,'C2',1],[8,'A#2',1],[9,'C3',1],[10,'C2',2],[12,'G3',4]],
      [[0,'D#2',4],[7,'D#2',1],[8,'D3',1],[9,'D#3',1],[10,'A#2',2],[14,'D#2',2]],
      [[1,'D#2',1],[2,'D3',1],[3,'D#3',1],[4,'D#2',2],[7,'D#2',1],[8,'D3',1],[9,'D#3',1],[10,'D#2',2],[12,'A#3',4]],
      [[0,'C2',4],[7,'C2',1],[8,'A#2',1],[9,'C3',1],[10,'C2',2],[14,'C2',2]],
      [[1,'C2',1],[2,'A#2',1],[3,'C3',1],[4,'C2',2],[7,'C2',1],[8,'A#2',1],[9,'C3',1],[10,'C2',2],[12,'G3',4]]
    ],
    } },
  },
};
