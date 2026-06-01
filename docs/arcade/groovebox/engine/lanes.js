// ─── Lane-list normalisation ──────────────────────────────────────────────────

const LANE_ORDER = ['drums', 'bass', 'chords', 'melody'];

/**
 * normalizeLanes(authored)
 * Accepts either:
 *   - the authored object shape  { drums:{…}, bass:{…}, chords:{…}, melody:{…} }
 *   - or an already-normalised list  [{id,type,…}, …]
 * Returns a lane list. Idempotent.
 */
export function normalizeLanes(authored) {
  if (Array.isArray(authored)) return authored; // already a list — idempotent
  return LANE_ORDER.map(type => {
    const src = authored[type] || {};
    const lane = { id: type, type, name: type, ...src };
    // melody lanes get a default tone if not set
    if (type === 'melody' && !lane.tone) lane.tone = 'pulse';
    return lane;
  });
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
