// ─── Lane-list normalisation ──────────────────────────────────────────────────

const LANE_ORDER = ['drums', 'bass', 'chords', 'melody'];

/**
 * normalizeLanes(authored)
 * Accepts either:
 *   - the authored object shape  { drums:{…}, bass:{…}, chords:{…}, melody:{…} }
 *   - or an already-normalised list  [{id,type,…}, …]
 * Returns a lane list. Idempotent.
 * Also caches `song._poolsByType` on the song object (caller must pass song as
 * second arg when available, or call cachePoolsByType separately).
 */
export function normalizeLanes(authored, song) {
  if (Array.isArray(authored)) {
    // already a list — idempotent; still cache pools if song provided
    if (song) cachePoolsByType(authored, song);
    return authored;
  }
  const lanes = LANE_ORDER.map(type => {
    const src = authored[type] || {};
    const lane = { id: type, type, name: type, ...src };
    // melody lanes get a default tone if not set
    if (type === 'melody' && !lane.tone) lane.tone = 'pulse';
    return lane;
  });
  if (song) cachePoolsByType(lanes, song);
  return lanes;
}

/**
 * cachePoolsByType(lanes, song)
 * Stores `song._poolsByType = { drums, bass, chords, melody }` from the first
 * lane of each type that has a pool. Called by normalizeLanes and addLane so
 * the pool is always available even after all lanes of a type are removed.
 */
export function cachePoolsByType(lanes, song) {
  const cache = song._poolsByType || {};
  for (const type of LANE_ORDER) {
    if (!cache[type]) {
      const lane = lanes.find(l => l.type === type && l.pool !== undefined);
      if (lane) cache[type] = lane.pool;
    }
  }
  song._poolsByType = cache;
}

// ─── Stage 2: lane mutation helpers (Tone-free, unit-tested) ─────────────────

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
 * addLane(song, type) → new lane object (already pushed onto song.lanes).
 * Sources pool from: existing lane of that type → _poolsByType cache → undefined.
 * chords has no pool (it uses chord modes) — pool omitted for chords.
 * Returns the new lane.
 */
export function addLane(song, type) {
  const lanes = song.lanes;
  const id   = uniqueLaneId(lanes, type);
  const name = uniqueLaneName(lanes, type);

  // Source pool: prefer an existing lane of this type, then cached pool
  let pool;
  if (type !== 'chords') {
    const existing = laneByType(lanes, type);
    pool = existing?.pool ?? song._poolsByType?.[type];
  }

  // Sensible default selection
  let selection;
  if (type === 'chords') {
    selection = 'pad';
  } else {
    const keys = pool ? Object.keys(pool) : [];
    selection = keys[0] ?? undefined;
  }

  const lane = {
    id,
    type,
    name,
    selection,
    muted: false,
    soloed: false,
    ...(pool !== undefined ? { pool } : {}),
    ...(type === 'melody' ? { tone: 'pulse' } : {}),
  };

  lanes.push(lane);
  // Update pool cache
  if (pool !== undefined && song._poolsByType && !song._poolsByType[type]) {
    song._poolsByType[type] = pool;
  }
  return lane;
}

/**
 * duplicateLane(song, id) → clone of the lane with fresh id/name/mute/solo.
 * Pool is shared by reference. Inserted immediately after the source.
 * Returns the new lane, or null if source not found.
 */
export function duplicateLane(song, id) {
  const lanes = song.lanes;
  const srcIdx = lanes.findIndex(l => l.id === id);
  if (srcIdx < 0) return null;
  const src = lanes[srcIdx];

  const newId   = uniqueLaneId(lanes, src.type);
  const newName = uniqueLaneName(lanes, src.name);

  const lane = {
    ...src,
    id:     newId,
    name:   newName,
    muted:  false,
    soloed: false,
    // pool shared by reference (already on src — spread preserves it)
  };

  lanes.splice(srcIdx + 1, 0, lane);
  return lane;
}

/**
 * removeLane(song, id) → removed lane id, or null if last lane / not found.
 * Guard: never remove the last remaining lane.
 */
export function removeLane(song, id) {
  const lanes = song.lanes;
  if (lanes.length <= 1) return null;
  const idx = lanes.findIndex(l => l.id === id);
  if (idx < 0) return null;
  lanes.splice(idx, 1);
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

export function setLane(lanes, id, selection) {
  const lane = lanes.find(l => l.id === id);
  if (lane) lane.selection = selection;
}

export function captureScene(lanes) {
  const sel = {};
  for (const lane of lanes) sel[lane.id] = lane.selection;
  return { bars: 4, lanes: sel, fill: null };
}

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
