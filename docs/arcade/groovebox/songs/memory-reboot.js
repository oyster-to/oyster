// Memory Reboot — auto-imported from MIDI (4/4 @ 145bpm, 16-bar loop).
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
    [[0,'B1',1],[2,'B1',1],[4,'B1',1],[6,'B1',1],[8,'B1',1],[12,'B1',1]],
    [[2,'B1',1],[4,'B1',1],[6,'B1',1],[8,'B1',1],[12,'B1',1]],
    [[2,'A1',1],[4,'A1',1],[6,'A1',1],[8,'A1',1],[12,'A1',1]],
    [[2,'A1',1],[4,'A1',1],[6,'A1',1],[8,'A1',1],[12,'A1',1]],
    [[0,'F#1',1],[2,'F#1',1],[4,'F#1',1],[6,'F#1',1],[8,'F#1',1],[12,'F#1',1]],
    [[2,'F#1',1],[4,'F#1',1],[6,'F#1',1],[8,'F#1',1],[12,'F#1',1]],
    [[0,'C#2',1],[2,'C#2',1],[4,'C#2',1],[6,'C#2',1],[8,'C#2',1],[12,'C#2',1]],
    [[2,'C#2',1],[4,'C#2',1],[6,'C#2',1],[8,'C#2',1],[12,'C#2',1]],
    [[0,'B1',1],[2,'B1',1],[4,'B1',1],[6,'B1',1],[8,'B1',1],[12,'B1',1]],
    [[2,'B1',1],[4,'B1',1],[6,'B1',1],[8,'B1',1],[12,'B1',1]],
    [[2,'A1',1],[4,'A1',1],[6,'A1',1],[8,'A1',1],[12,'A1',1]],
    [[2,'A1',1],[4,'A1',1],[6,'A1',1],[8,'A1',1],[12,'A1',1]],
    [[0,'F#1',1],[2,'F#1',1],[4,'F#1',1],[6,'F#1',1],[8,'F#1',1],[12,'F#1',1]],
    [[2,'F#1',1],[4,'F#1',1],[6,'F#1',1],[8,'F#1',1],[12,'F#1',1]],
    [[0,'C#2',1],[2,'C#2',1],[4,'C#2',1],[6,'C#2',1],[8,'C#2',1],[12,'C#2',1]],
    [[2,'C#2',1],[4,'C#2',1],[6,'C#2',1],[8,'C#2',1],[12,'C#2',1]]
  ];

export const memoryReboot = {
  title: 'Memory Reboot',
  artist: 'VØJ & Narvent',
  meter: { beatsPerBar:4, beatUnit:4, stepsPerBeat:4 },
  bpm: 145,
  arrangement: [
    { bars:16, lanes:{ drums:'midi', bass:'midi', chords:'pad', melody:'lead' }, fill:'snare roll' },
    { bars:16, lanes:{ drums:'four', bass:'octave', chords:'arp', melody:'lead' }, fill:'crash build' },
  ],
  fills: {
    'snare roll': { kick:[0], snare:[8,9,10,11,12,13,14,15] },
    'crash build':{ kick:[0,8], snare:[14,15], crash:[12] },
    'tom roll':   { kick:[0,4], tom:[[8,7],[10,3],[12,2],[14,-2]] },
  },
  // Key: B major — progression B–A–F#–C# centres on B; tonic = first chord.
  harmony: { key: { root:'B', mode:'major' }, progression: [
    { name:'B', root:'B2', voicing:['B3','D#3','F#3'] },
    { name:'B', root:'B2', voicing:['B3','D#3','F#3'] },
    { name:'A', root:'A2', voicing:['A3','C#3','E3'] },
    { name:'A', root:'A2', voicing:['A3','C#3','E3'] },
    { name:'F#', root:'F#2', voicing:['F#3','A#3','C#3'] },
    { name:'F#', root:'F#2', voicing:['F#3','A#3','C#3'] },
    { name:'C#', root:'C#2', voicing:['C#3','F3','G#3'] },
    { name:'C#', root:'C#2', voicing:['C#3','F3','G#3'] },
    { name:'B', root:'B2', voicing:['B3','D#3','F#3'] },
    { name:'B', root:'B2', voicing:['B3','D#3','F#3'] },
    { name:'A', root:'A2', voicing:['A3','C#3','E3'] },
    { name:'A', root:'A2', voicing:['A3','C#3','E3'] },
    { name:'F#', root:'F#2', voicing:['F#3','A#3','C#3'] },
    { name:'F#', root:'F#2', voicing:['F#3','A#3','C#3'] },
    { name:'C#', root:'C#2', voicing:['C#3','F3','G#3'] },
    { name:'C#', root:'C#2', voicing:['C#3','F3','G#3'] },
  ]},
  lanes: {
    drums:  { selection:'midi', muted:false, cycleLen:16,
              pool:{
                midi: [
        {kick:[0,2,4,6,8,12], hat:[0,2,4,6,8,10,12,14], snare:[8]},
        {kick:[0,2,4,6,8,12], hat:[0,2,4,6,8,10,12,14], snare:[8]},
        {kick:[0,2,4,6,8,12], hat:[0,2,4,6,8,10,12,14], snare:[8]},
        {kick:[0,2,4,6,8,12], hat:[0,2,4,6,8,10,12,14], snare:[8]},
        {kick:[0,2,4,6,8,12], hat:[0,2,4,6,8,10,12,14], snare:[8]},
        {kick:[0,2,4,6,8,12], hat:[0,2,4,6,8,10,12,14], snare:[8]},
        {kick:[0,2,4,6,8,12], hat:[0,2,4,6,8,10,12,14], snare:[8]},
        {kick:[0,2,4,6,8,12], hat:[0,2,4,6,8,10,12,14], snare:[8]},
        {kick:[0,2,4,6,8,12], hat:[0,2,4,6,8,10,12,14], snare:[8]},
        {kick:[0,2,4,6,8,12], hat:[0,2,4,6,8,10,12,14], snare:[8]},
        {kick:[0,2,4,6,8,12], hat:[0,2,4,6,8,10,12,14], snare:[8]},
        {kick:[0,2,4,6,8,12], hat:[0,2,4,6,8,10,12,14], snare:[8]},
        {kick:[0,2,4,6,8,12], hat:[0,2,4,6,8,10,12,14], snare:[8]},
        {kick:[0,2,4,6,8,12], hat:[0,2,4,6,8,10,12,14], snare:[8]},
        {kick:[0,2,4,6,8,12], hat:[0,2,4,6,8,10,12,14], snare:[8]},
        {kick:[0,2,4,6,8,12], hat:[0,2,4,6,8,10,12,14], snare:[8]}
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
      [[12,'B5',1]],
      [[0,'A5',1],[2,'B5',1],[6,'A5',1],[8,'G#5',1],[12,'E5',1],[14,'G#5',1]],
      [[0,'E5',1],[2,'E5',1],[4,'E5',1],[6,'E5',1],[8,'E5',1],[10,'E5',1],[12,'D#5',1],[14,'E5',1]],
      [[0,'G#5',1],[2,'D#5',1],[4,'E5',1],[6,'G#5',1],[12,'D#5',1],[14,'E5',1]],
      [[0,'E5',1],[2,'D#5',1],[4,'D#5',1],[6,'E5',1],[10,'E5',1],[12,'D#5',1],[14,'E5',1]],
      [[0,'B5',1],[4,'E5',1],[6,'B5',1],[8,'G#5',1],[12,'E5',1],[14,'G#5',1]],
      [[0,'E5',1],[2,'E5',1],[4,'E5',1],[6,'E5',1],[8,'E5',1],[10,'E5',1],[12,'D#5',1],[14,'E5',1]],
      [[0,'G#5',1],[2,'E5',1],[6,'G#5',1],[8,'E5',1],[12,'E5',1],[14,'G#5',1]],
      [[0,'E5',1],[2,'E5',1],[4,'E5',1],[6,'E5',1],[8,'E5',1],[10,'E5',1],[12,'B5',1]],
      [[0,'A5',1],[2,'B5',1],[6,'A5',1],[8,'G#5',1],[12,'E5',1],[14,'G#5',1]],
      [[0,'E5',1],[2,'E5',1],[4,'E5',1],[6,'E5',1],[8,'E5',1],[10,'E5',1],[12,'D#5',1],[14,'E5',1]],
      [[0,'G#5',1],[2,'D#5',1],[4,'E5',1],[6,'G#5',1],[12,'D#5',1],[14,'E5',1]],
      [[0,'E5',1],[2,'D#5',1],[4,'D#5',1],[6,'E5',1],[10,'E5',1],[12,'D#5',1],[14,'E5',1]],
      [[0,'B5',1],[4,'E5',1],[6,'B5',1],[8,'G#5',1],[12,'E5',1],[14,'G#5',1]],
      [[0,'E5',1],[2,'E5',1],[4,'E5',1],[6,'E5',1],[8,'E5',1],[10,'E5',1],[12,'D#5',1],[14,'E5',1]],
      [[0,'B5',1],[2,'E5',1],[6,'B5',1],[8,'G#5',1],[12,'E5',1],[14,'G#5',1]]
    ],
    } },
  },
};
