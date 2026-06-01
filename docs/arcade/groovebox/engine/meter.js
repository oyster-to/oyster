// A meter at 16th-note grid resolution. stepsPerBeat = number of grid steps per beat unit.
//   4/4 -> {beatsPerBar:4, beatUnit:4, stepsPerBeat:4}  (16 steps)
//   3/4 -> {beatsPerBar:3, beatUnit:4, stepsPerBeat:4}  (12 steps)
//   6/8 -> {beatsPerBar:6, beatUnit:8, stepsPerBeat:2}  (12 steps), optional group:3 for accenting
export function stepsPerBar(m) { return m.beatsPerBar * m.stepsPerBeat; }
export function beatStarts(m) {
  const out = [];
  for (let b = 0; b < m.beatsPerBar; b++) out.push(b * m.stepsPerBeat);
  return out;
}
export const METERS = {
  '4/4': { beatsPerBar: 4, beatUnit: 4, stepsPerBeat: 4 },
  '3/4': { beatsPerBar: 3, beatUnit: 4, stepsPerBeat: 4 },
  '6/8': { beatsPerBar: 6, beatUnit: 8, stepsPerBeat: 2, group: 3 },
};
