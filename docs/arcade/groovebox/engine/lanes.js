export function setLane(song, lane, selection) { song.lanes[lane].selection = selection; }
export function captureScene(song) {
  return {
    bars: 4,
    lanes: {
      drums:  song.lanes.drums.selection,
      bass:   song.lanes.bass.selection,
      chords: song.lanes.chords.selection,
      melody: song.lanes.melody.selection,
    },
    fill: null,
  };
}
export function toggleMute(song, lane) { return (song.lanes[lane].muted = !song.lanes[lane].muted); }
export function toggleDrumMute(song, voice) {
  song.lanes.drums.voiceMute ||= {};
  return (song.lanes.drums.voiceMute[voice] = !song.lanes.drums.voiceMute[voice]);
}
export function toggleDrumSolo(song, voice) {
  song.lanes.drums.voiceSolo ||= {};
  const turningOn = !song.lanes.drums.voiceSolo[voice];   // exclusive: only one drum voice solo at a time
  for (const v in song.lanes.drums.voiceSolo) song.lanes.drums.voiceSolo[v] = false;
  song.lanes.drums.voiceSolo[voice] = turningOn;
  return turningOn;
}
export function toggleSolo(song, lane) { return (song.lanes[lane].soloed = !song.lanes[lane].soloed); }
export function soloExclusive(song, lane) {
  const turningOn = !song.lanes[lane].soloed;
  for (const l in song.lanes) song.lanes[l].soloed = false;
  song.lanes[lane].soloed = turningOn;
  return turningOn;
}
