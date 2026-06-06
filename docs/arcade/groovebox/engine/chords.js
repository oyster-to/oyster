// engine/chords.js — pure chord-symbol parser/formatter (Tone-free, unit-tested).
//
// Turns a text progression like "F#m D A E/G#" into the rich chord shape the
// harmony schema uses: { name, root, voicing }. The inverse formatProgression()
// renders chords back to the editable text line.
//
// Grammar per whitespace-separated token:
//   <root><quality>[/<bass>]
//   root    : A–G with an optional # or b accidental
//   quality : '' (major triad) or 'm' (minor triad)
//   bass    : optional slash note (letter + optional accidental) — sets the
//             chord's ROOT note (the played bass) while the voicing stays the
//             chord's own triad (a slash/inversion).
//
// Register conventions mirror the presets (read kids.js / rising-sun.js):
//   bass root  → octave 2 (e.g. 'F#2')
//   triad      → built upward from octave 3 (e.g. ['F#3','A3','C#4'])

const PC_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const LETTER_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

// pitch-class (0–11) of a note letter + optional accidental, or null.
function pc(letter, accidental) {
  let n = LETTER_PC[letter];
  if (n == null) return null;
  if (accidental === '#') n += 1; else if (accidental === 'b') n -= 1;
  return ((n % 12) + 12) % 12;
}

// Build a note name at or above a given midi-octave-floor: returns the lowest
// occurrence of `pitchClass` at octave >= floorOct, then names it.
function noteAt(pitchClass, octave) {
  return PC_NAMES[pitchClass] + octave;
}

// Build an ascending triad from a root pitch-class, starting at octave 3, where
// each successive tone is the next-higher occurrence of its pitch-class (so the
// voicing always rises, crossing octave boundaries like the presets do).
function triad(rootPc, third) {
  const intervals = [0, third, 7];           // root, 3rd (3=min/4=maj), 5th
  const out = [];
  let prevMidi = -Infinity;
  for (const iv of intervals) {
    const target = (rootPc + iv) % 12;
    // lowest midi at octave>=3 with this pitch class that is strictly ascending
    let oct = 3;
    let midi = (oct + 1) * 12 + target;
    while (midi <= prevMidi) { oct++; midi = (oct + 1) * 12 + target; }
    out.push(noteAt(target, oct));
    prevMidi = midi;
  }
  return out;
}

const TOKEN_RE = /^([A-G])(#|b)?(m)?(?:\/([A-G])(#|b)?)?$/;

// parseProgression(text) → { chords: [{name, root, voicing}], errors: [{index, token}] }
// Parses what it can; unparseable tokens are recorded in `errors` (with their
// position index) and skipped from `chords`.
export function parseProgression(text) {
  const chords = [];
  const errors = [];
  const tokens = String(text).trim().split(/\s+/).filter(Boolean);
  tokens.forEach((token, index) => {
    const m = token.match(TOKEN_RE);
    if (!m) { errors.push({ index, token }); return; }
    const [, letter, acc, minor, bassLetter, bassAcc] = m;
    const rootPc = pc(letter, acc);
    if (rootPc == null) { errors.push({ index, token }); return; }
    const third = minor ? 3 : 4;
    const voicing = triad(rootPc, third);
    // Bass note: slash bass if present, else the triad root, both at octave 2.
    const bassPc = bassLetter ? pc(bassLetter, bassAcc) : rootPc;
    if (bassPc == null) { errors.push({ index, token }); return; }
    const root = noteAt(bassPc, 2);
    // Display name: canonicalise the root pitch-class spelling + quality + slash.
    const name = PC_NAMES[rootPc] + (minor ? 'm' : '')
      + (bassLetter ? '/' + PC_NAMES[bassPc] : '');
    chords.push({ name, root, voicing });
  });
  return { chords, errors };
}

// formatProgression(chords) → the editable text line (space-joined chord names).
export function formatProgression(chords) {
  if (!Array.isArray(chords)) return '';
  return chords.map(c => c.name).join(' ');
}
