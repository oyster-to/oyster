// House of the Rising Sun — traditional, public domain. A minor, 6/8 feel.
// meter: 6/8 → beatsPerBar:6, beatUnit:8, stepsPerBeat:2 → 12 steps/bar
// Dotted-quarter pulses at steps 0 and 6. bpm 90.

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

// Melody — "There is a house in New Orleans"
// One bar per chord in the 6-chord progression. Arpeggiated contour, octave 4–5.
// Am: A4 C5 E5 A5 (ascending then back)
// C:  E4 G4 C5 E5
// D:  D4 F#4 A4 D5
// F:  F4 A4 C5 F5
// Am: A4 C5 E5 (shorter — repeat feel)
// E:  E4 G#4 B4 E5

const LEAD = [
  // Am — steps 0,2,4,6,8,10 (6/8 subdivisions)
  [[0,'A4',2],[2,'C5',2],[4,'E5',2],[6,'A5',2],[8,'E5',2],[10,'C5',2]],
  // C
  [[0,'E4',2],[2,'G4',2],[4,'C5',2],[6,'E5',2],[8,'C5',2],[10,'G4',2]],
  // D
  [[0,'D4',2],[2,'F#4',2],[4,'A4',2],[6,'D5',2],[8,'A4',2],[10,'F#4',2]],
  // F
  [[0,'F4',2],[2,'A4',2],[4,'C5',2],[6,'F5',2],[8,'C5',2],[10,'A4',2]],
  // Am (second pass — slightly varied: start on E)
  [[0,'E4',2],[2,'A4',2],[4,'C5',2],[6,'E5',4],[10,'A4',2]],
  // E major — G# characteristic tone featured
  [[0,'E4',2],[2,'G#4',2],[4,'B4',2],[6,'E5',4],[10,'B4',2]],
];

// Second variation — half the notes, held longer (sparse feel)
const LEAD_SPARSE = [
  [[0,'A4',4],[4,'E5',4],[8,'C5',4]],
  [[0,'E4',4],[4,'C5',4],[8,'G4',4]],
  [[0,'D4',4],[4,'A4',4],[8,'F#4',4]],
  [[0,'F4',4],[4,'C5',4],[8,'A4',4]],
  [[0,'A4',6],[6,'E5',6]],
  [[0,'E4',6],[6,'B4',6]],
];

export const risingSun = {
  title: 'House of the Rising Sun',
  artist: 'Traditional',
  meter: { beatsPerBar:6, beatUnit:8, stepsPerBeat:2, group:3 },
  bpm: 90,

  arrangement: [
    { bars:6, lanes:{ drums:'ballad',  bass:'arp',  chords:'pad', melody:'lead'       }, fill:'snare turn' },
    { bars:6, lanes:{ drums:'swung',   bass:'arp',  chords:'pad', melody:'lead sparse'}, fill:'tom roll'   },
    { bars:6, lanes:{ drums:'full',    bass:'octave',chords:'pad', melody:'lead'      }, fill:'snare turn' },
  ],

  fills: {
    'snare turn': { kick:[0,6], snare:[9,10,11] },
    'tom roll':   { kick:[0], tom:[[6,7],[8,5],[10,3],[11,0]] },
    'crash open': { kick:[0,6], crash:[0], hat:[0,2,4,6,8,10] },
  },

  harmony: {
    progression: [
      { name:'Am', root:'A2', voicing:['A3','C4','E4'] },
      { name:'C',  root:'C2', voicing:['C3','E3','G3'] },
      { name:'D',  root:'D2', voicing:['D3','F#3','A3'] },
      { name:'F',  root:'F2', voicing:['F3','A3','C4'] },
      { name:'Am', root:'A2', voicing:['A3','C4','E4'] },
      { name:'E',  root:'E2', voicing:['E3','G#3','B3'] },
    ],
  },

  lanes: {
    drums: {
      selection: 'ballad',
      muted: false,
      pool: {
        // Sparse — accent the two dotted-quarter pulses
        ballad: { kick:[0,6], hat:[0,2,4,6,8,10] },
        // Swung — snare on pulse 2 (step 6)
        swung:  { kick:[0,6], snare:[6], hat:[0,2,4,6,8,10] },
        // Full — kick every dotted eighth, closed hat on every 8th
        full:   { kick:[0,3,6,9], snare:[6], hat:[0,1,2,3,4,5,6,7,8,9,10,11] },
      },
    },

    bass: {
      selection: 'arp',
      muted: false,
      pool: {
        // Iconic ascending arpeggio — chord tones at each 8th-note subdivision
        arp:    (bar, chord) => [0,2,4,6,8,10].map((s,i) =>
                  [s, low(chord.voicing[i % chord.voicing.length]), 2]),
        // Root on both dotted-quarter pulses
        root:   (bar, chord) => [[0, chord.root, 6],[6, chord.root, 6]],
        // Alternating root / octave-up
        octave: (bar, chord) => [0,2,4,6,8,10].map((s,i) =>
                  [s, i % 2 ? transposeNote(chord.root, 12) : chord.root, 2]),
      },
    },

    chords: { selection:'pad', muted:false },

    melody: {
      selection: 'lead',
      muted: false,
      pool: {
        lead:        LEAD,
        'lead sparse': LEAD_SPARSE,
      },
    },
  },
};
