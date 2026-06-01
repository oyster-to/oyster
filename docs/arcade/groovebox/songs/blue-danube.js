// The Blue Danube — Johann Strauss II, public domain. D major, 3/4 waltz.
// meter: 3/4 → beatsPerBar:3, beatUnit:4, stepsPerBeat:4 → 12 steps/bar
// Beats at steps 0 (strong), 4, 8. bpm 150.

function transposeNote(note, semis) {
  const m = note.match(/^([A-G]#?)(-?\d+)$/);
  if (!m) return note;
  const NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
  const idx = NAMES.indexOf(m[1]);
  if (idx < 0) return note;
  const total = idx + (parseInt(m[2]) + 1) * 12 + semis;
  return NAMES[((total % 12) + 12) % 12] + (Math.floor(total / 12) - 1);
}

function low(n) { return transposeNote(n, -24); }

// Melody — the famous Blue Danube waltz theme (recognisable, not note-perfect).
// Over a 4-bar progression (D, D, A, A).
// Pattern: rising D-major arpeggio (D→F#→A) with held top note, then "dum-dum" answer.
//
// Bar 1 (D):  D5 held → the long intro upbeat
//             [0,D5,4] [4,D5,4] [8,D5,4]  — held D
// Bar 2 (D):  rising arpeggio D→F#→A, then short answers
//             [0,D5,2] [2,F#5,2] [4,A5,4] [8,F#5,2] [10,D5,2]
// Bar 3 (A):  A4 rise on A chord — E5→C#5→A4
//             [0,E5,2] [2,C#5,2] [4,A4,4] [8,C#5,2] [10,E5,2]
// Bar 4 (A):  "dum-dum" two-note answer then pause
//             [0,A5,4] [4,E5,4]

const LEAD = [
  // Bar 1 — D: held D5, building tension before the main phrase
  [[0,'D5',4],[4,'D5',4],[8,'D5',4]],
  // Bar 2 — D: the iconic rising arpeggio D→F#→A, then step back down
  [[0,'D5',2],[2,'F#5',2],[4,'A5',4],[8,'F#5',2],[10,'D5',2]],
  // Bar 3 — A: A-chord arpeggio rising E→C#→A (inverted for interest), answer
  [[0,'E5',2],[2,'C#5',2],[4,'A4',4],[8,'C#5',2],[10,'E5',2]],
  // Bar 4 — A: "dum-dum" two-note answer (A5→E5), then rest
  [[0,'A5',4],[4,'E5',6]],
];

// Variation — the second phrase (the "answer" to the main theme, slightly more melodic)
const LEAD_VAR = [
  // D: descending answer phrase
  [[0,'A5',4],[4,'F#5',2],[6,'D5',2],[8,'F#5',4]],
  // D: stepwise fill
  [[0,'D5',2],[2,'E5',2],[4,'F#5',4],[8,'A5',4]],
  // A: chord tone decoration
  [[0,'A5',2],[2,'G#5',2],[4,'A5',4],[8,'E5',4]],
  // A: closing figure
  [[0,'C#5',2],[2,'A4',2],[4,'E5',4],[8,'A5',4]],
];

export const blueDanube = {
  meter: { beatsPerBar:3, beatUnit:4, stepsPerBeat:4 },
  bpm: 150,

  arrangement: [
    { bars:4, lanes:{ drums:'waltz',     bass:'oompah', chords:'pad', melody:'lead'    }, fill:'snare 3'  },
    { bars:4, lanes:{ drums:'waltz hat', bass:'oompah', chords:'pad', melody:'lead var'}, fill:'roll'     },
    { bars:4, lanes:{ drums:'oompah',    bass:'root',   chords:'pad', melody:'lead'    }, fill:'snare 3'  },
  ],

  fills: {
    'snare 3': { kick:[0], snare:[4,8,10] },
    'roll':    { kick:[0], snare:[6,7,8,9,10,11] },
  },

  harmony: {
    progression: [
      { name:'D',  root:'D2',  voicing:['D3','F#3','A3'] },
      { name:'D',  root:'D2',  voicing:['D3','F#3','A3'] },
      { name:'A',  root:'A2',  voicing:['A3','C#4','E4'] },
      { name:'A',  root:'A2',  voicing:['A3','C#4','E4'] },
    ],
  },

  lanes: {
    drums: {
      selection: 'waltz',
      muted: false,
      pool: {
        // Classic waltz — "oom" on beat 1, "pah-pah" on beats 2 & 3
        waltz:       { kick:[0], snare:[4,8] },
        // With hi-hat on every 8th note
        'waltz hat': { kick:[0], snare:[4,8], hat:[0,2,4,6,8,10] },
        // Oom-pah variant — hat on just the pah beats
        oompah:      { kick:[0], snare:[4,8], hat:[4,8] },
      },
    },

    bass: {
      selection: 'oompah',
      muted: false,
      pool: {
        // Waltz oom-pah-pah: root on beat 1, chord tones on beats 2 & 3
        oompah: (bar, chord) => [
          [0, chord.root,                                        4],
          [4, low(chord.voicing[1] || chord.voicing[0]),        4],
          [8, low(chord.voicing[2] || chord.voicing[1] || chord.voicing[0]), 4],
        ],
        // Whole-bar root
        root:   (bar, chord) => [[0, chord.root, 12]],
        // Root plus octave on beat 2
        octave: (bar, chord) => [
          [0, chord.root,                        4],
          [4, transposeNote(chord.root, 12),     4],
          [8, chord.root,                        4],
        ],
      },
    },

    chords: { selection:'pad', muted:false },

    melody: {
      selection: 'lead',
      muted: false,
      pool: {
        lead:      LEAD,
        'lead var': LEAD_VAR,
      },
    },
  },
};
