export function setLane(song, lane, selection) { song.lanes[lane].selection = selection; }
export function toggleMute(song, lane) { return (song.lanes[lane].muted = !song.lanes[lane].muted); }
