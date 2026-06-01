// MGMT "Kids" — A major, F#m–D–A–E/G#; melody transcribed from the MIDI (per-bar [step,note,durSteps]).
const RIFF = [
  [[0,'A4',2],[4,'B4',2],[8,'C#5',2],[12,'E5',2]],
  [[0,'F#5',4],[4,'G#5',2],[6,'F#5',2],[10,'E5',4],[14,'C#5',17]],
  [],
  [[0,'B4',15]],
];
export const kids = {
  meter: { beatsPerBar:4, beatUnit:4, stepsPerBeat:4 },
  bpm: 120,
  harmony: { progression: [
    { name:'F#m',  root:'F#2', voicing:['F#3','A3','C#4','E4'] },
    { name:'D',    root:'D2',  voicing:['D3','E3','A3'] },
    { name:'A',    root:'A2',  voicing:['A3','C#4','E4'] },
    { name:'E/G#', root:'G#2', voicing:['G#3','B3','E4'] },
  ]},
  lanes: {
    drums:  { selection:'four', muted:false, cycleLen:4,
              pool:{ four:{ kick:[0,4,8,12], snare:[4,12], hat:[0,2,4,6,8,10,12,14] } } },
    bass:   { selection:'octave', muted:false,
              pool:{ octave:(bar,chord)=>[0,2,4,6,8,10,12,14].map((s,i)=>
                       [s, i%2 ? Tone_transpose(chord.root,12) : chord.root, 2]) } },
    chords: { selection:'pad', muted:false },
    melody: { selection:'hook', muted:false, pool:{ hook: RIFF } },
  },
};
function Tone_transpose(note, semis){ return { 'F#2':'F#3','D2':'D3','A2':'A3','G#2':'G#3' }[note] || note; }
