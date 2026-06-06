// Shared minimal-valid registry payloads for registry-*.test.js.
export const GROOVE_PAYLOAD = {
  laneType: 'drums',
  meter: { beatsPerBar: 4, beatUnit: 4, stepsPerBeat: 4 },
  bars: [{ kick: [0, 8], snare: [4, 12], hat: [0, 2, 4, 6, 8, 10, 12, 14], crash: [], tom: [] }],
};
export const SONG_PAYLOAD = {
  version: 2, title: 'T', artist: 'A',
  meter: { beatsPerBar: 4, beatUnit: 4, stepsPerBeat: 4 }, bpm: 120,
  lanes: [{ id: 'drums', type: 'drums', name: 'Drums', muted: false, soloed: false }],
  grooves: { drums: { main: [{ kick: [0], snare: [], hat: [], crash: [], tom: [] }] } },
  patterns: [{ lanes: { drums: 'main' } }],
  chain: [0],
  fills: {},
};
