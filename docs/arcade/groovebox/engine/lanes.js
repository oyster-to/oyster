// ─── Lane mutation helpers (Tone-free, unit-tested) ──────────────────────────
import { emptyBarFor } from './patterns.js';


/**
 * uniqueLaneId(lanes, type) → collision-free id string.
 * Returns `type` if unused; otherwise `type-2`, `type-3` … until free.
 */
export function uniqueLaneId(lanes, type) {
  const ids = new Set(lanes.map(l => l.id));
  if (!ids.has(type)) return type;
  let n = 2;
  while (ids.has(`${type}-${n}`)) n++;
  return `${type}-${n}`;
}

/**
 * uniqueLaneName(lanes, baseName) → collision-free display name.
 * Returns `baseName` if unused; otherwise `baseName 2`, `baseName 3` …
 */
function uniqueLaneName(lanes, baseName) {
  const names = new Set(lanes.map(l => l.name));
  if (!names.has(baseName)) return baseName;
  let n = 2;
  while (names.has(`${baseName} ${n}`)) n++;
  return `${baseName} ${n}`;
}

/**
 * addLane(song, type) → new mixer-only lane + empty data slots in every pattern.
 * Returns the new lane.
 */
export function addLane(song, type) {
  const lanes = song.lanes;
  const lane = {
    id: uniqueLaneId(lanes, type),
    type,
    name: uniqueLaneName(lanes, type),
    muted: false,
    soloed: false,
    ...(type === 'melody' ? { tone: 'pulse' } : {}),
  };
  lanes.push(lane);
  // New lane gets one 'empty' groove; every pattern picks it.
  song.grooves[lane.id] = { empty: [emptyBarFor(lane)] };
  for (const pat of song.patterns) pat.lanes[lane.id] = 'empty';
  return lane;
}

/**
 * duplicateLane(song, id) → clone lane + deep-copy its data in every pattern.
 * Inserted immediately after the source.
 * Returns the new lane, or null if source not found.
 */
export function duplicateLane(song, id) {
  const lanes = song.lanes;
  const srcIdx = lanes.findIndex(l => l.id === id);
  if (srcIdx < 0) return null;
  const src = lanes[srcIdx];
  const lane = { ...src, id: uniqueLaneId(lanes, src.type), name: uniqueLaneName(lanes, src.name), muted: false, soloed: false };
  lanes.splice(srcIdx + 1, 0, lane);
  // Deep-copy the source lane's groove map under the new id; copy picks everywhere.
  song.grooves[lane.id] = JSON.parse(JSON.stringify(song.grooves[src.id] ?? {}));
  for (const pat of song.patterns) pat.lanes[lane.id] = pat.lanes[src.id];
  return lane;
}

/**
 * removeLane(song, id) → removed id or null; also drops its pattern data.
 * Guard: never remove the last remaining lane.
 */
export function removeLane(song, id) {
  const lanes = song.lanes;
  if (lanes.length <= 1) return null;
  const idx = lanes.findIndex(l => l.id === id);
  if (idx < 0) return null;
  lanes.splice(idx, 1);
  delete song.grooves[id];
  for (const pat of song.patterns) delete pat.lanes[id];
  return id;
}

/**
 * renameLane(song, id, name) — sets lane.name (trimmed; ignores empty).
 */
export function renameLane(song, id, name) {
  const trimmed = (name || '').trim();
  if (!trimmed) return;
  const lane = song.lanes.find(l => l.id === id);
  if (lane) lane.name = trimmed;
}

/**
 * laneByType(lanes, type) — first lane of that type (for back-compat with
 * arrangement sections which are keyed by type name).
 */
export function laneByType(lanes, type) {
  return lanes.find(l => l.type === type) ?? null;
}

// ─── List-based lane mutations (operate by id) ────────────────────────────────

export function toggleMute(lanes, id) {
  const lane = lanes.find(l => l.id === id);
  if (!lane) return false;
  return (lane.muted = !lane.muted);
}

export function toggleSolo(lanes, id) {
  const lane = lanes.find(l => l.id === id);
  if (!lane) return false;
  return (lane.soloed = !lane.soloed);
}

export function soloExclusive(lanes, id) {
  const lane = lanes.find(l => l.id === id);
  if (!lane) return false;
  const turningOn = !lane.soloed;
  for (const l of lanes) l.soloed = false;
  lane.soloed = turningOn;
  return turningOn;
}

/**
 * moveLane(song, fromId, toIndex) — reorders song.lanes in place.
 * Removes the lane with `fromId`, then splices it in at `toIndex` (clamped).
 * No-op if `fromId` is not found. Returns the lane if moved, null otherwise.
 */
export function moveLane(song, fromId, toIndex) {
  const lanes = song.lanes;
  const fromIdx = lanes.findIndex(l => l.id === fromId);
  if (fromIdx < 0) return null;
  const [lane] = lanes.splice(fromIdx, 1);
  const clampedTo = Math.max(0, Math.min(toIndex, lanes.length));
  lanes.splice(clampedTo, 0, lane);
  return lane;
}

// ─── Per-drum-voice mute/solo (reads the drums-type lane object directly) ─────

export function toggleDrumMute(drumsLane, voice) {
  drumsLane.voiceMute ||= {};
  return (drumsLane.voiceMute[voice] = !drumsLane.voiceMute[voice]);
}

export function toggleDrumSolo(drumsLane, voice) {
  drumsLane.voiceSolo ||= {};
  const turningOn = !drumsLane.voiceSolo[voice];
  for (const v in drumsLane.voiceSolo) drumsLane.voiceSolo[v] = false;
  drumsLane.voiceSolo[voice] = turningOn;
  return turningOn;
}
