// ─── Share UI: pure helpers + modal + boot loader ─────────────────────────────
// Pure helpers up top (unit-tested, no DOM). initShare()/maybeLoadShared() at
// the bottom own all DOM and are only called from app.js in the browser.

import { createItem, getItem, updateItem, getEditKey, storeEditKey, getAuthor, setAuthor,
         shareUrl, parseShareParam } from '../registry/client.js';
import { KIND_VERSIONS } from '../registry/validate.js';

export function dedupeName(existing, name) {
  const names = new Set(existing);
  if (!names.has(name)) return name;
  let n = 2;
  while (names.has(`${name}-${n}`)) n++;
  return `${name}-${n}`;
}

export function pickHostLanes(lanes, laneType) { return lanes.filter((l) => l.type === laneType); }

export function metersEqual(a, b) {
  return a.beatsPerBar === b.beatsPerBar && a.beatUnit === b.beatUnit && a.stepsPerBeat === b.stepsPerBeat;
}

// Assemble a kind=groove payload from the current song. Groove values may be
// chord-relative ({ relative: true, bars }) — the bundle carries the flag.
export function buildGrooveBundle(eng, laneId, grooveName) {
  const song = eng.getSong();
  const lane = eng.getLanes().find((l) => l.id === laneId);
  const value = eng.getGrooves()[laneId][grooveName];
  const relative = !Array.isArray(value);
  return JSON.parse(JSON.stringify({
    laneType: lane.type,
    meter: song.meter,
    bars: relative ? value.bars : value,
    ...(relative ? { relative: true } : {}),
    bpm: song.bpm,                                   // hint only, never applied on import
  }));
}

// 'owner-choice' → dialog offers Update / Share-as-new; 'remix' → POST with
// remix_of; 'new' → plain POST. Cross-kind extraction is 'new' in v1.
export function decideShareMode({ loadedFrom, hasEditKey, kind }) {
  if (!loadedFrom || loadedFrom.kind !== kind) return 'new';
  return hasEditKey ? 'owner-choice' : 'remix';
}

// Import a fetched groove record into laneId of the current song (spec's
// conservative semantics — no transformation). Returns { name, placed }.
export function importGroove(eng, record, laneId) {
  const existing = Object.keys(eng.getGrooves()[laneId] || {});
  const name = dedupeName(existing, record.name);
  const p = record.payload;
  const value = p.relative ? { relative: true, bars: p.bars } : p.bars;
  eng.addGroove(laneId, name, value);
  const placed = metersEqual(eng.getSong().meter, p.meter);
  if (placed) eng.setLaneGroove(laneId, name);
  return { name, placed };
}

// ─── DOM half ─────────────────────────────────────────────────────────────────

let loadedFrom = null;          // { id, kind } of the record this session loaded, if any
const $ = (id) => document.getElementById(id);

// initShare(eng, hooks) — hooks: { notice, onSongLoaded, onGroovesChanged, pickLane }.
// app.js supplies render callbacks and its notice helper; share.js owns the modal.
export function initShare(eng, hooks) {
  let tab = 'song';

  const open = () => {
    $('share-author').value = getAuthor();
    if (tab === 'groove') fillPickers();
    $('share-name').value = tab === 'song' ? (eng.getSong()?.title || 'untitled') : ($('share-groove').value || '');
    syncMode();
    $('share-result').hidden = true; $('share-error').hidden = true;
    $('share-modal').hidden = false;
  };
  const close = () => { $('share-modal').hidden = true; };

  function fillPickers() {
    const lanes = eng.getLanes();
    const cur = $('share-lane').value;
    $('share-lane').innerHTML = lanes.map((l) => `<option value="${l.id}"${l.id === cur ? ' selected' : ''}>${l.name}</option>`).join('');
    fillGrooves();
  }
  function fillGrooves() {
    const laneId = $('share-lane').value;
    const names = Object.keys(eng.getGrooves()[laneId] || {});
    $('share-groove').innerHTML = names.map((n) => `<option value="${n}">${n}</option>`).join('');
  }
  function syncMode() {
    const mode = decideShareMode({ loadedFrom, hasEditKey: !!(loadedFrom && getEditKey(loadedFrom.id)), kind: tab });
    $('share-update').hidden = mode !== 'owner-choice';
    $('share-submit').textContent = mode === 'owner-choice' ? 'Publish as new' : 'Publish';
  }
  function setTab(t) {
    tab = t;
    $('share-tab-song').classList.toggle('active', t === 'song');
    $('share-tab-groove').classList.toggle('active', t === 'groove');
    $('share-groove-pickers').hidden = t !== 'groove';
    open();
  }

  function bodyForTab() {
    if (tab === 'song') {
      return { kind: 'song', schema_version: KIND_VERSIONS.song,
               payload: JSON.parse(JSON.stringify(eng.getSong())) };
    }
    return { kind: 'groove', schema_version: KIND_VERSIONS.groove,
             payload: buildGrooveBundle(eng, $('share-lane').value, $('share-groove').value) };
  }

  async function submit(asUpdate) {
    const name = $('share-name').value.trim(), author = $('share-author').value.trim();
    if (!name) return showError('name required');
    setAuthor(author);
    try {
      const base = bodyForTab();
      if (asUpdate) {
        const { revision } = await updateItem(loadedFrom.id, {
          editKey: getEditKey(loadedFrom.id), name, author, payload: base.payload });
        showResult(loadedFrom.id, `updated (rev ${revision})`);
      } else {
        const body = { ...base, name, author };
        const mode = decideShareMode({ loadedFrom, hasEditKey: !!(loadedFrom && getEditKey(loadedFrom.id)), kind: tab });
        if (mode === 'remix') body.remix_of = loadedFrom.id;
        const { id, editKey } = await createItem(body);
        storeEditKey(id, editKey);
        if (tab === 'song') loadedFrom = { id, kind: 'song' };   // you now own what's on screen
        showResult(id);
      }
    } catch (e) { showError(e.message); }                        // dialog stays open, state intact
  }

  function showResult(id, note) {
    $('share-link').value = shareUrl(id);
    $('share-result').hidden = false; $('share-error').hidden = true;
    if (note) hooks.notice(note);
    syncMode();
  }
  function showError(msg) { $('share-error').textContent = msg; $('share-error').hidden = false; }

  $('share-btn').onclick = open;
  $('share-modal-close').onclick = close;
  $('share-modal-backdrop').onclick = close;
  $('share-tab-song').onclick = () => setTab('song');
  $('share-tab-groove').onclick = () => setTab('groove');
  $('share-lane').onchange = fillGrooves;
  $('share-submit').onclick = () => submit(false);
  $('share-update').onclick = () => submit(true);
  $('share-copy').onclick = () => { navigator.clipboard?.writeText($('share-link').value); hooks.notice('link copied'); };
}

// Boot-time: /s/<id> was redirected to /?s=<id> by the worker. Returns true if
// a share id was present (whether or not it loaded).
export async function maybeLoadShared(eng, hooks) {
  const id = parseShareParam(location.search);
  if (!id) return false;
  try {
    const rec = await getItem(id);
    loadedFrom = { id: rec.id, kind: rec.kind };
    if (rec.kind === 'song') {
      eng.load(rec.payload);
      hooks.onSongLoaded(rec);
      hooks.notice(`loaded "${rec.name}"${rec.author ? ` by ${rec.author}` : ''}`);
    } else {
      const lanes = pickHostLanes(eng.getLanes(), rec.payload.laneType);
      const laneId = lanes.length === 0 ? eng.addLane(rec.payload.laneType).id
                   : lanes.length === 1 ? lanes[0].id
                   : await hooks.pickLane(lanes);
      const { name, placed } = importGroove(eng, rec, laneId);
      hooks.onGroovesChanged();
      hooks.notice(placed ? `imported "${name}"${rec.author ? ` by ${rec.author}` : ''}`
        : `imported "${name}" (${rec.payload.meter.beatsPerBar}/${rec.payload.meter.beatUnit}) — in the groove menu, but this song is a different meter`);
    }
  } catch (e) { hooks.notice(`not found (${e.message})`); }  // app boots normally regardless
  return true;
}
