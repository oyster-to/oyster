export function setLane(song, lane, selection) { song.lanes[lane].selection = selection; }
export function toggleMute(song, lane) { return (song.lanes[lane].muted = !song.lanes[lane].muted); }
export function toggleSolo(song, lane) { return (song.lanes[lane].soloed = !song.lanes[lane].soloed); }
