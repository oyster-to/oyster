// ─── Share-registry validation (pure, shared by Worker AND browser app) ──────
// Single source of truth alongside DATA-MODEL.md and the spec
// (po20/2026-06-06-share-registry-spec.md). Strict everywhere: unknown keys
// rejected; the ONLY extension point is `extensions: {}` inside payloads.

export const KIND_VERSIONS = { song: 2, groove: 1 };
export const LANE_TYPES = ['drums', 'bass', 'chords', 'melody'];
const NAME_MAX = 80, AUTHOR_MAX = 40;
const PAYLOAD_MAX = 64 * 1024;   // JSON.stringify length
const STRING_MAX = 1024;         // any single string value/key — blocks base64 audio
const ID_RE = /^[a-z0-9]{8}$/;

const ok = { ok: true };
const err = (error) => ({ ok: false, error });
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function strictKeys(obj, allowed, label) {
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) return `${label}: unknown key "${k}"`;
  return null;
}

// Walk payload: no string (value or key) may exceed STRING_MAX.
function oversizedString(v) {
  if (typeof v === 'string') return v.length > STRING_MAX;
  if (Array.isArray(v)) return v.some(oversizedString);
  if (isObj(v)) return Object.keys(v).some((k) => k.length > STRING_MAX || oversizedString(v[k]));
  return false;
}

function meterValid(m) {
  return isObj(m) && strictKeys(m, ['beatsPerBar', 'beatUnit', 'stepsPerBeat', 'group'], 'meter') === null &&
    [m.beatsPerBar, m.beatUnit, m.stepsPerBeat].every((n) => Number.isInteger(n) && n >= 1 && n <= 64) &&
    (m.group === undefined || (Number.isInteger(m.group) && m.group >= 1 && m.group <= 64));
}

// A per-step lock (DATA-MODEL "the lock object"): the one extensible slot on a
// step. Today only velocity — { v } where v multiplies the voice's base
// velocity (0 < v <= 2). Strict-keyed so a typo or a future-only key fails loud
// instead of silently no-op'ing. New lock params join `v` here, with this doc.
function lockValid(x) {
  return isObj(x) && strictKeys(x, ['v'], 'lock') === null &&
    typeof x.v === 'number' && Number.isFinite(x.v) && x.v > 0 && x.v <= 2;
}

// A pitched step tuple is [step, note, dur] with an OPTIONAL trailing lock
// object: [step, note, dur, lock]. A drum step is a plain number, or a tuple
// [step, ...] whose trailing element MAY be a lock ([step, lock] or
// [step, semi, lock]). Trailing object ⇒ must be a valid lock.
function stepTrailingLockOk(step) {
  if (!Array.isArray(step) || step.length === 0) return typeof step === 'number';
  const last = step[step.length - 1];
  // Only a plain object is a lock. A trailing ARRAY is a chord voicing (e.g.
  // [step, ['E4','G4']] with dur omitted) — not a lock, and was valid before.
  return (last !== null && typeof last === 'object' && !Array.isArray(last)) ? lockValid(last) : true;
}

// Bar-shape depth: drums bar = plain object of arrays; note bar
// (bass/chords/melody) = array of note events. Step tuples are otherwise NOT
// re-validated here (the engine is robust to bad picks) — the one exception is
// the lock object, which is strict contract surface.
function barsValid(laneType, bars) {
  if (!Array.isArray(bars) || bars.length < 1 || bars.length > 8) return false;
  if (laneType === 'drums') {
    return bars.every((b) => isObj(b) &&
      Object.values(b).every((steps) => Array.isArray(steps) && steps.every(stepTrailingLockOk)));
  }
  return bars.every((b) => Array.isArray(b) && b.every((t) => Array.isArray(t) && stepTrailingLockOk(t)));
}

// A groove VALUE in song.grooves: bars[] (literal) or — note lanes only —
// { relative: true, bars } with chord-relative REFs resolved against
// pattern.chords at schedule time.
function grooveValueValid(laneType, g) {
  if (Array.isArray(g)) return barsValid(laneType, g);
  if (laneType === 'drums') return false;
  return isObj(g) && strictKeys(g, ['relative', 'bars'], 'groove') === null &&
    g.relative === true && barsValid(laneType, g.bars);
}

// pattern.chords — one entry per bar of the pattern: {name, root, voicing} | null.
function chordsValid(chords) {
  if (!Array.isArray(chords) || chords.length < 1) return false;
  return chords.every((c) => c === null ||
    (isObj(c) && strictKeys(c, ['name', 'root', 'voicing'], 'chord') === null &&
     typeof c.name === 'string' && typeof c.root === 'string' &&
     Array.isArray(c.voicing) && c.voicing.every((v) => typeof v === 'string')));
}

export function validateGroovePayload(p) {
  if (!isObj(p)) return err('payload must be an object');
  const bad = strictKeys(p, ['laneType', 'meter', 'bars', 'relative', 'bpm', 'extensions'], 'groove payload');
  if (bad) return err(bad);
  if (!LANE_TYPES.includes(p.laneType)) return err('invalid laneType');
  if (!meterValid(p.meter)) return err('invalid meter');
  if (p.relative !== undefined && (p.relative !== true || p.laneType === 'drums')) return err('invalid relative');
  if (!barsValid(p.laneType, p.bars)) return err('invalid bars');
  if (p.bpm !== undefined && !(typeof p.bpm === 'number' && p.bpm >= 20 && p.bpm <= 999)) return err('invalid bpm');
  if (p.extensions !== undefined && !isObj(p.extensions)) return err('extensions must be an object');
  return ok;
}

export function validateSongPayload(p) {
  if (!isObj(p)) return err('payload must be an object');
  const bad = strictKeys(p, ['version', 'title', 'artist', 'meter', 'bpm', 'lanes', 'grooves',
    'patterns', 'chain', 'fills', 'transpose', 'key', 'extensions'], 'song payload');
  if (bad) return err(bad);
  if (p.key !== undefined && !(isObj(p.key) && typeof p.key.root === 'string' && typeof p.key.mode === 'string')) return err('invalid key');
  if (p.version !== 2) return err('song payload version must be 2');
  if (!meterValid(p.meter)) return err('invalid meter');
  if (!(typeof p.bpm === 'number' && p.bpm >= 20 && p.bpm <= 999)) return err('invalid bpm');
  if (!Array.isArray(p.lanes) || p.lanes.length < 1) return err('lanes required');
  const laneIds = new Set();
  for (const l of p.lanes) {
    if (!isObj(l) || typeof l.id !== 'string' || !LANE_TYPES.includes(l.type)) return err('invalid lane');
    if (laneIds.has(l.id)) return err('duplicate lane id');
    laneIds.add(l.id);
  }
  if (!isObj(p.grooves)) return err('grooves must be an object');
  for (const [laneId, byName] of Object.entries(p.grooves)) {
    if (!laneIds.has(laneId)) return err(`grooves for unknown lane "${laneId}"`);
    if (!isObj(byName)) return err('groove map must be an object');
    const laneType = p.lanes.find((l) => l.id === laneId).type;
    for (const g of Object.values(byName)) if (!grooveValueValid(laneType, g)) return err('invalid groove bars');
  }
  if (!Array.isArray(p.patterns) || p.patterns.length < 1 || p.patterns.length > 16) return err('patterns must be 1..16');
  for (const pat of p.patterns) {
    if (!isObj(pat) || strictKeys(pat, ['lanes', 'chords', 'name'], 'pattern') !== null || !isObj(pat.lanes)) return err('invalid pattern');
    if (pat.name !== undefined && (typeof pat.name !== 'string' || pat.name.length > NAME_MAX)) return err('invalid pattern name');
    if (pat.chords !== undefined && pat.chords !== null && !chordsValid(pat.chords)) return err('invalid pattern chords');
    for (const [laneId, name] of Object.entries(pat.lanes)) {
      if (name === null || name === undefined) continue;     // explicit no-pick is allowed
      if (!p.grooves[laneId]?.[name]) return err('pattern pick does not resolve');
    }
  }
  if (!Array.isArray(p.chain) || p.chain.length < 1 ||
      !p.chain.every((i) => Number.isInteger(i) && i >= 0 && i < p.patterns.length)) return err('invalid chain');
  if (p.fills !== undefined && !isObj(p.fills)) return err('fills must be an object');
  if (p.transpose !== undefined && !Number.isInteger(p.transpose)) return err('transpose must be an integer');
  if (p.extensions !== undefined && !isObj(p.extensions)) return err('extensions must be an object');
  return ok;
}

function validatePayload(kind, payload) {
  if (JSON.stringify(payload).length > PAYLOAD_MAX) return err('payload too large');
  if (oversizedString(payload)) return err('string field too large');
  return kind === 'song' ? validateSongPayload(payload) : validateGroovePayload(payload);
}

function validateNameAuthor(body) {
  if (typeof body.name !== 'string' || body.name.length < 1 || body.name.length > NAME_MAX) return err('invalid name');
  if (body.author !== undefined && (typeof body.author !== 'string' || body.author.length > AUTHOR_MAX)) return err('invalid author');
  return ok;
}

export function validateCreate(body) {
  if (!isObj(body)) return err('body must be an object');
  const bad = strictKeys(body, ['kind', 'schema_version', 'name', 'author', 'payload', 'remix_of'], 'body');
  if (bad) return err(bad);
  if (!(body.kind in KIND_VERSIONS)) return err('unknown kind');
  if (body.schema_version !== KIND_VERSIONS[body.kind]) return err('unsupported schema_version for kind');
  const na = validateNameAuthor(body); if (!na.ok) return na;
  if (body.remix_of !== undefined && !(typeof body.remix_of === 'string' && ID_RE.test(body.remix_of))) return err('invalid remix_of');
  return validatePayload(body.kind, body.payload);
}

// Update validates against the EXISTING row's kind/schema_version (identity
// fields are not in the allowed key list, so changing them is impossible).
export function validateUpdate(body, kind, schemaVersion) {
  if (!isObj(body)) return err('body must be an object');
  const bad = strictKeys(body, ['editKey', 'name', 'author', 'payload'], 'body');
  if (bad) return err(bad);
  if (typeof body.editKey !== 'string' || body.editKey.length < 16) return err('invalid editKey');
  const na = validateNameAuthor(body); if (!na.ok) return na;
  if (schemaVersion !== KIND_VERSIONS[kind]) return err('row schema_version unsupported');
  return validatePayload(kind, body.payload);
}
