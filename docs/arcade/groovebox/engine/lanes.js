export function setLane(song, lane, selection) { song.lanes[lane].selection = selection; }
export function toggleMute(song, lane) { return (song.lanes[lane].muted = !song.lanes[lane].muted); }
export function toggleSolo(song, lane) { return (song.lanes[lane].soloed = !song.lanes[lane].soloed); }
export function soloExclusive(song, lane) {
  const turningOn = !song.lanes[lane].soloed;
  for (const l in song.lanes) song.lanes[l].soloed = false;
  song.lanes[lane].soloed = turningOn;
  return turningOn;
}
