import { createEngine } from '../engine/index.js';
import { laneAudible } from '../engine/song.js';
import { parseProgression, formatProgression } from '../engine/chords.js';
import { kids } from '../songs/kids.js';
import { risingSun } from '../songs/rising-sun.js';
import { electricFeel } from '../songs/electric-feel.js';
import { heartbeats } from '../songs/heartbeats.js';
import { digitalLove } from '../songs/digital-love.js';
import { memoryReboot } from '../songs/memory-reboot.js';
import { takeOnMe } from '../songs/take-on-me.js';
import { firstRoll } from '../songs/first-roll.js';
import { pressStart } from '../songs/press-start.js';
import { scallywag } from '../songs/scallywag.js';
import { booWaltz } from '../songs/boo-waltz.js';
import { makeViz } from './viz.js';
import { makeKnob } from './knob.js';
import { initShare, maybeLoadShared, loadSharedSong, clearLoadedFrom } from './share.js';
import { listItems } from '../registry/client.js';
import { openPunchEditor, isPunchEditorOpen } from './punch-editor.js';
import { DEFAULT_PRESETS } from '../engine/punch-presets.js';

const eng = createEngine();
const TONES = ['pulse','square','sawtooth','fatsawtooth','triangle','sine'];

// ─── Knob info map (single source of truth) ───────────────────────────────────
const KNOB_INFO = {
  vol:  ['Volume',   'Lane output level'],
  pan:  ['Pan',      'Left / right placement'],
  cut:  ['Cutoff',   'Filter sweep — left = low-pass (darker), right = high-pass (thinner), centre = open'],
  res:  ['Resonance','Emphasis at the filter cutoff (squelch)'],
  drv:  ['Drive',    'Overdrive / distortion'],
  dly:  ['Delay',    'Echo send amount'],
  fdbk: ['Feedback', 'How many times the delay repeats (slap → wash)'],
  cho:  ['Chorus',   'Shimmer / width'],
  wob:  ['Wobble',   'LFO auto-filter movement'],
  cru:  ['Crush',    'Bit-crusher (lo-fi)'],
  vrb:  ['Reverb',   'Space / room send'],
  cmp:  ['Comp',     'Compression — evens out dynamics'],
  bal:  ['Balance',  'Master left / right'],
  wid:  ['Width',    'Stereo width (mono ↔ wide)'],
  lo:   ['Low EQ',   'Master bass shelf'],
  hi:   ['High EQ',  'Master treble shelf'],
};

function knobTip(k) {
  const info = KNOB_INFO[k];
  return info ? info[0] + ' — ' + info[1] : k;
}

const SONGS = { kids, 'rising-sun': risingSun, 'electric-feel': electricFeel, heartbeats, 'digital-love': digitalLove, 'memory-reboot': memoryReboot, 'take-on-me': takeOnMe, 'first-roll': firstRoll, 'press-start': pressStart, scallywag, 'boo-waltz': booWaltz };

const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// Module-level refs — reassigned by mount() on every song switch.
let song;
let viz;
// Track which lane is currently open in the viz (for edit-button highlight).
let _editingLaneId = null;
// Mobile accordion — which lane's knob strip is expanded. Survives re-renders
// (renderStrips re-applies it), mirroring the _editingLaneId pattern.
let _openLaneId = null;

// ─── Drag-reorder state ───────────────────────────────────────────────────────
let _draggedLaneId = null;

// ─── Section drag-reorder state ───────────────────────────────────────────────
const SECTION_IDS = ['viz', 'master', 'punch', 'strips', 'fills'];
let _draggedSecId = null;

function refreshStates() {
  const host = document.getElementById('strips');
  const lanes = eng.getLanes();
  for (const lane of lanes) {
    const row = host.querySelector(`.lane[data-lane="${lane.id}"]`);
    if (!row) continue;
    row.querySelector(`.mute[data-lane="${lane.id}"]`).classList.toggle('muted', !!lane.muted);
    row.querySelector(`.solo[data-lane="${lane.id}"]`).classList.toggle('soloed', !!lane.soloed);
    row.classList.toggle('silenced', !laneAudible(lanes, lane));
  }
}

// ─── Per-lane level meter rAF loop ───────────────────────────────────────────
let _meterRafId = null;
// Cached fill element refs — rebuilt by cacheMeterFills() after renderStrips/renderMaster.
let _laneFillCache = {};   // { [laneId]: HTMLElement }
let _masterFillCache = []; // [fillL, fillR]

// Call after any DOM rebuild that touches strips or master to refresh refs.
function cacheMeterFills() {
  _laneFillCache = {};
  const host = document.getElementById('strips');
  if (host) {
    for (const lane of eng.getLanes()) {
      const el = host.querySelector(`.lane[data-lane="${lane.id}"] .lvl-fill`);
      if (el) _laneFillCache[lane.id] = el;
    }
  }
  _masterFillCache = [];
  const masterHost = document.getElementById('master');
  if (masterHost) {
    const fills = masterHost.querySelectorAll('.lvl-stereo .lvl-fill');
    _masterFillCache = [fills[0] || null, fills[1] || null];
  }
}

function startMeterLoop() {
  if (_meterRafId !== null) return;   // already running — don't stack
  let _frameCount = 0;
  function tick() {
    _frameCount++;
    // Lane meters: throttled to ~30fps (every other frame) — saves half the
    // Tone.Meter.getValue() calls and style writes per lane per second.
    if (_frameCount % 2 === 0) {
      for (const lane of eng.getLanes()) {
        const fill = _laneFillCache[lane.id];
        if (fill) fill.style.height = (eng.getLevel(lane.id) * 100) + '%';
      }
    }
    // Master L/R stereo meters: update every frame (only 2 elements, cheap).
    const [l, r] = eng.getMasterLevel();
    if (_masterFillCache[0]) _masterFillCache[0].style.height = (l * 100) + '%';
    if (_masterFillCache[1]) _masterFillCache[1].style.height = (r * 100) + '%';
    _meterRafId = requestAnimationFrame(tick);
  }
  _meterRafId = requestAnimationFrame(tick);
}

function stopMeterLoop() {
  if (_meterRafId !== null) { cancelAnimationFrame(_meterRafId); _meterRafId = null; }
  // Zero out fills using cached refs (no querySelector needed).
  for (const fill of Object.values(_laneFillCache)) {
    if (fill) fill.style.height = '0%';
  }
  if (_masterFillCache[0]) _masterFillCache[0].style.height = '0%';
  if (_masterFillCache[1]) _masterFillCache[1].style.height = '0%';
}

// Wrap kgroups in a single flex container so the mobile layout can scroll/wrap it.
// Sticky edge arrows (shown via .fade-l/.fade-r) hint at off-screen knobs and
// page the strip on tap.
function makeKnobrow(groups) {
  const row = document.createElement('div');
  row.className = 'knobrow';
  const mkHint = dir => {
    const h = document.createElement('button');
    h.type = 'button';
    h.className = 'knob-scroll-hint ' + dir;
    h.textContent = dir === 'l' ? '‹' : '›';
    h.setAttribute('aria-label', dir === 'l' ? 'Scroll knobs left' : 'Scroll knobs right');
    h.addEventListener('click', e => {
      e.stopPropagation();
      row.scrollBy({ left: dir === 'l' ? -140 : 140, behavior: 'smooth' });
    });
    return h;
  };
  row.appendChild(mkHint('l'));
  for (const g of groups) row.appendChild(g);
  row.appendChild(mkHint('r'));
  row.addEventListener('scroll', () => updateKnobrowFade(row), { passive: true });
  requestAnimationFrame(() => updateKnobrowFade(row));
  return row;
}

// Edge-fade hint classes for horizontally scrollable knob strips. rAF-coalesced:
// momentum scrolling and resize bursts fire many times per frame, but the
// layout reads + class toggles only need to run once per paint.
function updateKnobrowFade(row) {
  if (row._fadeRaf) return;
  row._fadeRaf = requestAnimationFrame(() => {
    row._fadeRaf = null;
    const overR = row.scrollLeft + row.clientWidth < row.scrollWidth - 1;
    const overL = row.scrollLeft > 1;
    row.classList.toggle('fade-r', overR);
    row.classList.toggle('fade-l', overL);
  });
}
function updateAllKnobrowFades() {
  document.querySelectorAll('.knobrow').forEach(updateKnobrowFade);
}
window.addEventListener('resize', updateAllKnobrowFades);

// Open/close the mobile accordion. null closes all. Single owner of the .open
// class and aria-expanded so they can't drift.
function setOpenLane(id) {
  _openLaneId = id;
  const host = document.getElementById('strips');
  if (!host) return;
  host.querySelectorAll('.lane').forEach(l => {
    const open = !!id && l.dataset.lane === id;
    l.classList.toggle('open', open);
    const chev = l.querySelector('.lane-expand');
    if (chev) chev.setAttribute('aria-expanded', String(open));
  });
  updateAllKnobrowFades();
}

function makeKgroup(label, knobDefs) {
  const grp = document.createElement('div');
  grp.className = 'kgroup';
  const lbl = document.createElement('span');
  lbl.className = 'kgroup-lbl';
  lbl.textContent = label;
  grp.appendChild(lbl);
  const row = document.createElement('div');
  row.className = 'kgroup-knobs';
  for (const def of knobDefs) row.appendChild(makeKnob(def));
  grp.appendChild(row);
  return grp;
}

// Highlight the editing strip + the matching quick-edit tab; clear scope.
function updateEditHighlight(id) {
  _editingLaneId = id;
  const host = document.getElementById('strips');
  if (host) {
    host.querySelectorAll('.lane').forEach(row => {
      const isEditing = row.dataset.lane === id;
      row.classList.toggle('editing', isEditing);
      const editBtn = row.querySelector('.lane-edit');
      if (editBtn) editBtn.classList.toggle('editing', isEditing);
    });
  }
  const bar = document.querySelector('.vtabs');
  if (bar) {
    bar.querySelectorAll('.vtab-lane').forEach(t => t.classList.toggle('on', t.dataset.edit === id));
    bar.querySelectorAll('[data-view]').forEach(x => x.classList.remove('on'));
  }
}

// Screen tabs in the LCD: Song first, then one per editable lane, then Scope.
// Rebuilt on every renderStrips() so it tracks add/dup/remove/rename.
function renderViewTabs() {
  const bar = document.querySelector('.vtabs');
  if (!bar) return;
  bar.innerHTML = '';
  const songTab = document.createElement('button');
  songTab.dataset.view = 'song';
  songTab.textContent = 'Song';
  songTab.onclick = () => activateSongTab();
  bar.appendChild(songTab);
  for (const lane of eng.getLanes()) {
    if (lane.type === 'chords') continue;   // chords has no grid/roll editor
    const b = document.createElement('button');
    b.className = 'vtab-lane';
    b.dataset.edit = lane.id;
    b.textContent = lane.name;
    b.onclick = () => activateEditLane(lane.id);
    bar.appendChild(b);
  }
  const scope = document.createElement('button');
  scope.dataset.view = 'scope';
  scope.textContent = 'Scope';
  scope.onclick = () => toggleScope(scope);
  bar.appendChild(scope);
  if (_songTabOpen) songTab.classList.add('on');
  else if (_editingLaneId) updateEditHighlight(_editingLaneId);
}

// The screen has two tab panes — #lcd-body (viz: lane editors / scope) and
// #lcd-song (song structure) — plus the SELECT SONG picker, which overlays
// whichever pane is current and closes back to it. Display toggles only —
// the viz is never disposed here, so switching is free.
let _songTabOpen = false;
function setLcdPane(songOpen) {
  _songTabOpen = songOpen;
  const body = document.getElementById('lcd-body');
  const songPane = document.getElementById('lcd-song');
  if (body) body.hidden = songOpen;
  if (songPane) songPane.hidden = !songOpen;
}

// Song tab: show the song structure pane, clear lane-editing highlights.
function activateSongTab() {
  const bar = document.querySelector('.vtabs');
  if (bar) {
    bar.querySelectorAll('button').forEach(x => x.classList.remove('on'));
    bar.querySelector('[data-view="song"]')?.classList.add('on');
  }
  const host = document.getElementById('strips');
  if (host) {
    host.querySelectorAll('.lane').forEach(row => row.classList.remove('editing'));
    host.querySelectorAll('.lane-edit').forEach(b => b.classList.remove('editing'));
  }
  setLcdPane(true);
}

// Scope toggle: on → show oscilloscope; off (click again) → back to last lane editor.
function toggleScope(btn) {
  if (btn.classList.contains('on')) {
    btn.classList.remove('on');
    if (_editingLaneId) activateEditLane(_editingLaneId);
  } else {
    document.querySelector('.vtabs').querySelectorAll('button').forEach(x => x.classList.remove('on'));
    btn.classList.add('on');
    const host = document.getElementById('strips');
    if (host) {
      host.querySelectorAll('.lane').forEach(row => row.classList.remove('editing'));
      host.querySelectorAll('.lane-edit').forEach(b => b.classList.remove('editing'));
    }
    setLcdPane(false);
    viz.setView('scope');
  }
}

// Open a lane editor in the viz + update highlight.
function activateEditLane(id) {
  setLcdPane(false);
  viz.editLane(id);
  updateEditHighlight(id);
}

// ─── SELECT SONG — the cartridge drawer ──────────────────────────────────────
// Cartridges are hardware: tapping the song slot opens a rack panel anchored
// under it (bottom sheet on mobile — the Help/Settings idiom). Every song is
// a cartridge card — notch colour says AI original / cover / shared, shared
// carts carry a play-count badge. Picking loads + closes; outside click,
// ✕ and Escape close.
const PRESET_ORDER = ['press-start', 'scallywag', 'boo-waltz', 'first-roll', 'kids',
  'rising-sun', 'electric-feel', 'heartbeats', 'digital-love', 'memory-reboot', 'take-on-me'];
const AI_PRESETS = new Set(['press-start', 'scallywag', 'boo-waltz', 'first-roll']);
let _pickerOpen = false;
let _sharedItems = [];          // registry shelf rows — refreshed on each open
let _currentSongKey = 'press-start';   // preset key, or 's:<id>' for a shared song

function songButtonLabel(text) {
  const btn = document.getElementById('songbtn');
  if (btn) btn.innerHTML = `<span class="songbtn-t">${esc(text)}</span><span class="songbtn-caret">▾</span>`;
}

function presetLabel(key) {
  const s = SONGS[key];
  if (!s) return key;
  return `${AI_PRESETS.has(key) ? '★ ' : ''}${s.title || key}${s.artist ? ` — ${s.artist}` : ''}`;
}

function cartEl({ cls, title, author, plays, onPick, selected }) {
  const b = document.createElement('button');
  b.className = 'kart' + (cls ? ` ${cls}` : '') + (selected ? ' sel' : '');
  const badge = typeof plays === 'number' && plays > 0
    ? `<span class="kart-plays">▶ ${plays}</span>` : '';
  b.innerHTML = `<span class="kart-notch"></span><span class="kart-meta">`
    + `<span class="kart-t">${esc(title)}</span>`
    + (author ? `<span class="kart-a">${esc(author)}</span>` : '')
    + `</span>${badge}`;
  b.onclick = onPick;
  return b;
}

function renderPicker() {
  const host = document.getElementById('song-picker');
  if (!host) return;
  host.innerHTML = '';
  const head = document.createElement('div');
  head.className = 'picker-head';
  head.innerHTML = `<span>SELECT SONG</span>`;
  const close = document.createElement('button');
  close.className = 'picker-close';
  close.textContent = '✕';
  close.setAttribute('aria-label', 'Close song picker');
  close.onclick = () => closePicker();
  head.appendChild(close);
  host.appendChild(head);

  const sect = (label) => {
    const s = document.createElement('div');
    s.className = 'picker-sect';
    s.textContent = label;
    host.appendChild(s);
  };

  const presetCart = (key) => {
    const s = SONGS[key];
    if (!s) return;
    host.appendChild(cartEl({
      cls: AI_PRESETS.has(key) ? 'ai' : 'cover',
      title: s.title || key,
      author: s.artist || '',
      selected: _currentSongKey === key,
      onPick: () => { closePicker(); loadSong(key); },
    }));
  };

  sect('BUILT-IN');
  for (const key of PRESET_ORDER) if (AI_PRESETS.has(key)) presetCart(key);

  // The social shelf rides high — right under the house carts.
  if (_sharedItems.length) {
    sect('SHARED — FROM OTHER PLAYERS');
    for (const it of _sharedItems) {
      host.appendChild(cartEl({
        cls: 'shared',
        title: it.name,
        author: it.author || '',
        plays: it.plays,
        selected: _currentSongKey === `s:${it.id}`,
        onPick: async () => {
          closePicker();
          eng.stop();
          stopMeterLoop();
          const play = document.getElementById('play');
          play.classList.remove('on');
          play.textContent = '▶ play';
          try { await loadSharedSong(eng, shareHooks, it.id); }
          catch (err) { gbNotice(`couldn't load (${err.message})`); }
        },
      }));
    }
  }

  sect('JUKEBOX — COVERS');
  for (const key of PRESET_ORDER) if (!AI_PRESETS.has(key)) presetCart(key);
}

function openPicker() {
  const host = document.getElementById('song-picker');
  if (!host) return;
  renderPicker();
  _pickerOpen = true;
  host.hidden = false;
  document.getElementById('songbtn')?.classList.add('open');
  // Refresh the shelf in the background; re-render if anything changed.
  listItems('song', 25).then(({ items }) => {
    if (!Array.isArray(items)) return;
    _sharedItems = items;
    if (_pickerOpen) renderPicker();
  }).catch(() => {});
}

function closePicker() {
  if (!_pickerOpen) return;
  _pickerOpen = false;
  const host = document.getElementById('song-picker');
  if (host) host.hidden = true;
  document.getElementById('songbtn')?.classList.remove('open');
}

// Outside click closes the drawer (same manners as the Settings popover).
document.addEventListener('click', e => {
  if (!_pickerOpen) return;
  const host = document.getElementById('song-picker');
  const btn = document.getElementById('songbtn');
  if (host && !host.contains(e.target) && e.target !== btn && !btn?.contains(e.target)) closePicker();
});

function renderStrips() {
  const host = document.getElementById('strips');
  const lanes = eng.getLanes();
  const isLast = lanes.length === 1;

  const grooves = eng.getGrooves();
  const patterns = eng.getPatterns();
  const editPat = patterns[eng.getEditPatternIndex()];
  host.innerHTML = lanes.map(lane => {
    const tone = lane.type === 'melody'
      ? `<select data-tone data-lane="${lane.id}">${TONES.map(t=>`<option value="${t}"${t===(lane.tone||'pulse')?' selected':''}>${t==='fatsawtooth'?'fat saw':t}</option>`).join('')}</select>`
      : '';
    // Groove dropdown — picks the groove the EDIT pattern plays for this lane.
    const laneGrooves = grooves[lane.id] || {};
    const picked = editPat?.lanes?.[lane.id];
    const grooveSel = `<select data-groove data-lane="${lane.id}">${Object.keys(laneGrooves).map(n=>`<option value="${esc(n)}"${n===picked?' selected':''}>${esc(n)}</option>`).join('')}</select>`;
    // Edit button — present for types with an editor (drums, melody, bass); skip chords.
    const hasEditor = lane.type !== 'chords';
    const editBtn = hasEditor
      ? `<button class="lane-edit" data-lane="${lane.id}" title="View/edit ${esc(lane.name)} in the screen">VIEW</button>`
      : `<button class="lane-edit" data-lane="${lane.id}" title="No editor for ${esc(lane.name)}" disabled>VIEW</button>`;
    // Grid columns: drag | name | mctl | meter | MIX | TONE | FX | M/S | actions
    return `<div class="lane" data-lane="${lane.id}" data-type="${lane.type}">
      <span class="lane-drag" title="Drag to reorder">⠿</span>
      <span class="name" title="double-click to rename">${esc(lane.name)}</span>
      <div class="mctl">${grooveSel}${tone}</div>
      <div class="lvl"><div class="lvl-fill"></div></div>
      <div class="msgroup">
        <button class="mute" data-lane="${lane.id}" aria-label="mute ${esc(lane.name)}" title="Mute">M</button>
        <button class="solo" data-lane="${lane.id}" aria-label="solo ${esc(lane.name)}" title="Solo">S</button>
      </div>
      <div class="lane-actions">
        ${editBtn}
        <button class="lane-dup" data-lane="${lane.id}" title="Duplicate lane">⧉</button>
        <button class="lane-rm" data-lane="${lane.id}" title="Remove lane"${isLast ? ' disabled' : ''}>✕</button>
      </div>
      <button type="button" class="lane-expand" data-lane="${lane.id}" title="Show/hide mixer knobs" aria-label="${esc(lane.name)} mixer knobs" aria-expanded="false"><svg class="le-arrow" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button>
    </div>`;
  }).join('');

  // Add-lane button at the bottom of strips
  const addBtn = document.createElement('div');
  addBtn.className = 'addlane-wrap';
  addBtn.innerHTML = `<button class="addlane-btn" title="Add a new lane">＋ add lane</button>
    <div class="addlane-menu" hidden>
      <button data-addtype="drums">Drums</button>
      <button data-addtype="bass">Bass</button>
      <button data-addtype="chords">Chords</button>
      <button data-addtype="melody">Melody</button>
    </div>`;
  host.appendChild(addBtn);

  // Wire add-lane toggle
  const addLaneBtn = addBtn.querySelector('.addlane-btn');
  const addMenu    = addBtn.querySelector('.addlane-menu');

  function closeAddMenu() {
    addMenu.hidden = true;
    document.removeEventListener('click', outsideClickClose);
  }
  function outsideClickClose(e) {
    if (!addMenu.contains(e.target) && e.target !== addLaneBtn) closeAddMenu();
  }

  addLaneBtn.onclick = e => {
    e.stopPropagation();
    const opening = addMenu.hidden;
    addMenu.hidden = !addMenu.hidden;
    if (opening) {
      document.addEventListener('click', outsideClickClose);
    } else {
      document.removeEventListener('click', outsideClickClose);
    }
  };
  addMenu.querySelectorAll('[data-addtype]').forEach(b => b.onclick = () => {
    eng.addLane(b.dataset.addtype);
    closeAddMenu();
    renderStrips();
  });

  host.querySelectorAll('select[data-tone]').forEach(s => s.onchange = e => eng.setTone(s.dataset.lane, e.target.value));
  host.querySelectorAll('select[data-groove]').forEach(s => s.onchange = () => {
    eng.setLaneGroove(s.dataset.lane, s.value);
    refreshVizPattern();   // editor must re-target the new groove
  });
  host.querySelectorAll('.mute').forEach(b => b.onclick = () => {
    eng.toggleMute(b.dataset.lane);
    refreshStates();
  });
  host.querySelectorAll('.solo').forEach(b => b.onclick = () => {
    eng.toggleSolo(b.dataset.lane);
    refreshStates();
  });

  // Duplicate button
  host.querySelectorAll('.lane-dup').forEach(b => b.onclick = () => {
    eng.duplicateLane(b.dataset.lane);
    renderStrips();
  });

  // Remove button
  host.querySelectorAll('.lane-rm').forEach(b => {
    if (!b.disabled) b.onclick = () => {
      eng.removeLane(b.dataset.lane);
      renderStrips();
    };
  });

  // Edit button — open that lane's editor in the viz
  host.querySelectorAll('.lane-edit:not(:disabled)').forEach(b => {
    b.onclick = () => {
      activateEditLane(b.dataset.lane);
    };
  });

  // Double-click name to rename (inline edit)
  host.querySelectorAll('.lane .name').forEach(nameEl => {
    nameEl.ondblclick = () => {
      const id = nameEl.closest('.lane').dataset.lane;
      const current = nameEl.textContent;
      const input = document.createElement('input');
      input.className = 'lane-rename-input';
      input.value = current;
      nameEl.replaceWith(input);
      input.focus();
      input.select();
      const commit = () => {
        eng.renameLane(id, input.value);
        renderStrips();
      };
      input.onblur = commit;
      input.onkeydown = e => {
        if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
        if (e.key === 'Escape') { input.value = current; input.blur(); }
      };
    };
  });

  // Build grouped knobs and insert before the M/S group
  host.querySelectorAll('.lane').forEach(row => {
    const id = row.dataset.lane;
    const msgroup = row.querySelector('.msgroup');

    const mixGrp = makeKgroup('MIX', [
      { label: 'vol', value: 1.0, onChange: v => eng.setLaneFX(id, 'vol',   v), tip: knobTip('vol'), k: 'vol' },
      { label: 'pan', value: 0.5, onChange: v => eng.setLaneFX(id, 'pan',   v), tip: knobTip('pan'), k: 'pan' },
    ]);
    const toneGrp = makeKgroup('TONE', [
      { label: 'cut', value: 0.5, onChange: v => eng.setLaneFX(id, 'cut',   v), tip: knobTip('cut'), k: 'cut' },
      { label: 'res', value: 0,   onChange: v => eng.setLaneFX(id, 'res',   v), tip: knobTip('res'), k: 'res' },
      { label: 'drv', value: 0,   onChange: v => eng.setLaneFX(id, 'drive', v), tip: knobTip('drv'), k: 'drv' },
    ]);
    const fxGrp = makeKgroup('FX', [
      { label: 'dly',  value: 0,   onChange: v => eng.setLaneFX(id, 'delay',  v), tip: knobTip('dly'),  k: 'dly'  },
      { label: 'fdbk', value: 0.3, onChange: v => eng.setLaneFX(id, 'fdbk',   v), tip: knobTip('fdbk'), k: 'fdbk' },
      { label: 'cho',  value: 0,   onChange: v => eng.setLaneFX(id, 'cho',    v), tip: knobTip('cho'),  k: 'cho'  },
      { label: 'wob',  value: 0,   onChange: v => eng.setLaneFX(id, 'wob',    v), tip: knobTip('wob'),  k: 'wob'  },
      { label: 'cru',  value: 0,   onChange: v => eng.setLaneFX(id, 'crush',  v), tip: knobTip('cru'),  k: 'cru'  },
      { label: 'vrb',  value: 0,   onChange: v => eng.setLaneFX(id, 'reverb', v), tip: knobTip('vrb'),  k: 'vrb'  },
      { label: 'cmp',  value: 0,   onChange: v => eng.setLaneFX(id, 'comp',   v), tip: knobTip('cmp'),  k: 'cmp'  },
    ]);

    const knobrow = makeKnobrow([mixGrp, toneGrp, fxGrp]);
    msgroup.before(knobrow);

    // Mobile accordion: chevron or lane header (not its controls) toggles the
    // lane's knob strip — one lane open at a time. No-op on desktop (chevron
    // hidden, knobrows always visible).
    const chev = row.querySelector('.lane-expand');
    const toggleOpen = () => setOpenLane(row.classList.contains('open') ? null : id);
    chev.onclick = toggleOpen;
    row.addEventListener('click', e => {
      // Gate on the CSS breakpoint itself (chevron is display:none on desktop)
      // so the JS behaviour can't desync from the @media value.
      if (getComputedStyle(chev).display === 'none') return;
      // .name owns dblclick-rename; .lvl is a readout, not a control.
      if (e.target.closest('button, select, input, .knobrow, .lane-drag, .name, .lvl')) return;
      toggleOpen();
    });
  });
  // ─── Drag-to-reorder ────────────────────────────────────────────────────────
  host.querySelectorAll('.lane-drag').forEach(handle => {
    const row = handle.closest('.lane');
    // Only the handle initiates drag
    handle.addEventListener('mousedown', () => { row.draggable = true; });
    handle.addEventListener('mouseup',   () => { row.draggable = false; });

    row.addEventListener('dragstart', e => {
      _draggedLaneId = row.dataset.lane;
      row.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });

    row.addEventListener('dragend', () => {
      row.classList.remove('dragging');
      row.draggable = false;
      _draggedLaneId = null;
      // Clear all drop indicators
      host.querySelectorAll('.lane').forEach(r => r.classList.remove('drop-above', 'drop-below'));
    });

    row.addEventListener('dragover', e => {
      if (!_draggedLaneId || _draggedLaneId === row.dataset.lane) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const rect = row.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      host.querySelectorAll('.lane').forEach(r => r.classList.remove('drop-above', 'drop-below'));
      if (e.clientY < midY) row.classList.add('drop-above');
      else                   row.classList.add('drop-below');
    });

    row.addEventListener('dragleave', () => {
      row.classList.remove('drop-above', 'drop-below');
    });

    row.addEventListener('drop', e => {
      e.preventDefault();
      if (!_draggedLaneId || _draggedLaneId === row.dataset.lane) return;
      const lanes = eng.getLanes();
      const targetIdx = lanes.findIndex(l => l.id === row.dataset.lane);
      const rect = row.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      const insertBefore = e.clientY < midY;
      const toIndex = insertBefore ? targetIdx : targetIdx + 1;
      eng.moveLane(_draggedLaneId, toIndex);
      renderStrips();
    });
  });

  refreshStates();
  cacheMeterFills();  // re-cache .lvl-fill refs after DOM rebuild
  renderViewTabs();   // rebuild quick-edit tabs to track the current lane list
  updateEmptyGroups(); // hide kgroups where all knobs are hidden
  // Re-apply the accordion's open lane across the innerHTML rebuild (drop it
  // if that lane was removed).
  setOpenLane(host.querySelector(`.lane[data-lane="${_openLaneId}"]`) ? _openLaneId : null);
}

// Sync every strip groove dropdown to the EDIT pattern's picks. Called whenever
// the edit pattern changes (from renderPatterns). Reflects the edit pattern only
// — never chain playback.
function syncStripGrooves() {
  const host = document.getElementById('strips');
  if (!host) return;
  const editPat = eng.getPatterns()[eng.getEditPatternIndex()];
  if (!editPat) return;
  host.querySelectorAll('select[data-groove]').forEach(s => {
    const picked = editPat.lanes?.[s.dataset.lane];
    if (picked !== undefined && s.value !== picked) s.value = picked;
  });
}

// ─── Fills row ───────────────────────────────────────────────────────────────
let _lastChainJSON = '';

function renderChain(queue) {
  const chainEl = document.querySelector('.fillchain');
  if (!chainEl) return;
  const json = JSON.stringify(queue);
  if (json === _lastChainJSON) return;
  _lastChainJSON = json;

  chainEl.innerHTML = '';
  queue.forEach((name, i) => {
    const chip = document.createElement('span');
    chip.className = 'fillchip' + (i === 0 ? ' next' : '');
    chip.textContent = name;
    chip.title = 'click to remove';
    chip.onclick = () => renderChain(eng.unqueueAt(i));
    chainEl.appendChild(chip);
  });
}

function renderFills() {
  const host = document.getElementById('fills');
  if (!host || !song.fills) return;
  host.innerHTML = '';
  _lastChainJSON = '';
  const row = document.createElement('div');
  row.className = 'fillsrow';
  const lbl = document.createElement('span');
  lbl.className = 'flbl';
  lbl.textContent = 'FILLS';
  row.appendChild(lbl);
  for (const name of Object.keys(song.fills)) {
    const btn = document.createElement('button');
    btn.className = 'fillbtn';
    btn.dataset.fill = name;
    btn.textContent = name;
    btn.onclick = () => { eng.queueFill(name); renderChain(eng.unqueueAt(Infinity)); };
    row.appendChild(btn);
  }
  // Chain display + clear button
  const chainEl = document.createElement('div');
  chainEl.className = 'fillchain';
  row.appendChild(chainEl);
  const clearBtn = document.createElement('button');
  clearBtn.className = 'fillclear';
  clearBtn.textContent = '✕';
  clearBtn.title = 'clear fill chain';
  clearBtn.onclick = () => { eng.clearQueue(); renderChain([]); };
  row.appendChild(clearBtn);
  host.appendChild(row);
}

// ─── Punch-in FX pads (data-driven; spec in project-notes/oyster/po20) ───────
// Pads render from preset data — names/keys live in the presets, not here.
// localStorage 'gb-punch-presets' overrides the repo defaults when valid
// (no editor UI yet — v3.5; hand-edited or future-UI overrides both load here).
function loadPunchPresets() {
  try {
    let saved = JSON.parse(localStorage.getItem('gb-punch-presets') || 'null');
    // Migration (matched BY NAME — index math broke when defaults reordered):
    // fill any defaults the saved set lacks, then — if no pads were renamed —
    // adopt the canonical default ORDER while keeping each pad's saved edits.
    // Renamed pads = user owns the layout; keep their order. Keys are
    // slot-bound, so they renumber either way.
    if (Array.isArray(saved)) {
      const byName = new Map(saved.filter(Boolean).map(p => [p.name, p]));
      for (const d of DEFAULT_PRESETS) if (!byName.has(d.name)) byName.set(d.name, d);
      const defaultNames = DEFAULT_PRESETS.map(d => d.name);
      const allStock = byName.size === defaultNames.length && defaultNames.every(n => byName.has(n));
      saved = allStock
        ? defaultNames.map(n => byName.get(n))
        : [...byName.values()].slice(0, DEFAULT_PRESETS.length);
      saved.forEach((p, i) => { p.key = String(i + 1); });
    }
    if (saved) return eng.setPunchPresets(saved);   // engine validates; invalid → defaults kept
  } catch (_) { /* corrupt JSON → defaults */ }
  return eng.getPunchPresets();
}
let PUNCH_BY_KEY = {};   // key → slot index, rebuilt by renderPunch()

function setPunch(slot, on) {
  eng.punch(slot, on);
  document.querySelector(`#punch .punchpad[data-slot="${slot}"]`)?.classList.toggle('held', on);
}

function renderPunch() {
  const host = document.getElementById('punch');
  if (!host) return;
  host.innerHTML = '';
  const presets = loadPunchPresets();
  PUNCH_BY_KEY = Object.fromEntries(presets.map((p, i) => [p.key, i]));
  const row = document.createElement('div');
  row.className = 'punchrow';
  const lbl = document.createElement('span');
  lbl.className = 'flbl';
  lbl.textContent = 'PUNCH';
  row.appendChild(lbl);
  presets.forEach((p, slot) => {
    const pad = document.createElement('button');
    pad.className = 'punchpad';
    pad.dataset.slot = slot;
    pad.append(p.name);
    const hint = document.createElement('span');
    hint.className = 'punchkey';
    hint.textContent = p.key;
    pad.appendChild(hint);
    // ✎ opens the preset editor for this slot (v3.5). pointerdown is stopped
    // so the pad doesn't punch underneath; all pads are force-released on
    // open (preview and pads share the punch bus).
    const edit = document.createElement('span');
    edit.className = 'punchedit';
    edit.title = 'Edit preset';
    edit.textContent = '✎';
    edit.addEventListener('pointerdown', e => {
      e.preventDefault(); e.stopPropagation();
      for (let s = 0; s < presets.length; s++) setPunch(s, false);
      openPunchEditor({ slot, eng, onSaved: renderPunch });
    });
    pad.appendChild(edit);
    pad.addEventListener('pointerdown', e => { e.preventDefault(); pad.setPointerCapture(e.pointerId); setPunch(slot, true); });
    const off = () => setPunch(slot, false);
    pad.addEventListener('pointerup', off);
    pad.addEventListener('pointercancel', off);
    row.appendChild(pad);
  });
  host.appendChild(row);
}

// Preset keys mirror the pads. Guards: key auto-repeat, and typing into inputs /
// selects / contenteditable (no keyboard hijack while renaming lanes etc.).
function isTypingTarget(el) {
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
}
document.addEventListener('keydown', e => {
  const slot = PUNCH_BY_KEY[e.key];
  if (slot === undefined || e.repeat || isTypingTarget(document.activeElement) || isPunchEditorOpen()) return;
  e.preventDefault();
  setPunch(slot, true);
});
document.addEventListener('keyup', e => {
  const slot = PUNCH_BY_KEY[e.key];
  if (slot !== undefined) setPunch(slot, false);
});
// Stuck-key guard: losing window focus releases every pad.
window.addEventListener('blur', () => { for (let s = 0; s < eng.getPunchPresets().length; s++) setPunch(s, false); });

// ─── Master FX ───────────────────────────────────────────────────────────────
// Tempo + transpose are hardware on MASTER (the screen strip carries the
// readouts; the controls live where the knobs are).
let currentBpm = 120;
let transpose = 0;
function fmtKey(n) { return n > 0 ? '+' + n : String(n); }

function makeTempoGroup() {
  const grp = document.createElement('div');
  grp.className = 'kgroup';
  const lbl = document.createElement('span');
  lbl.className = 'kgroup-lbl';
  lbl.textContent = 'TEMPO';
  grp.appendChild(lbl);
  const row = document.createElement('div');
  row.className = 'kgroup-knobs';
  // One label per control: the group label names it, the knob's sublabel slot
  // (where MIX knobs say vol/bal/wid) carries the live BPM value.
  const knob = makeKnob({
    label: String(currentBpm),
    // Clamp the dial position — a shared/legacy song can carry a BPM outside
    // the knob's 80–180 sweep; the engine keeps the true tempo, the dial pins.
    value: Math.max(0, Math.min(1, (currentBpm - 80) / 100)),
    fmt: v => Math.round(80 + v * 100),
    onChange: v => {
      currentBpm = Math.round(80 + v * 100);
      eng.setTempo(currentBpm);
      const kl = knob.querySelector('.knob-lbl');
      if (kl) kl.textContent = String(currentBpm);
      const sb = document.getElementById('strip-bpm');
      if (sb) sb.textContent = `${currentBpm} BPM`;
    },
    tip: 'Tempo (BPM) — drag up / down',
  });
  row.appendChild(knob);
  grp.appendChild(row);
  return grp;
}

function makeTransposeGroup() {
  const grp = document.createElement('div');
  grp.className = 'kgroup';
  const lbl = document.createElement('span');
  lbl.className = 'kgroup-lbl';
  lbl.textContent = 'TRANSPOSE';
  grp.appendChild(lbl);
  const row = document.createElement('div');
  row.className = 'kgroup-knobs';
  const stepper = document.createElement('div');
  stepper.className = 'key-stepper';
  const dn = document.createElement('button'); dn.textContent = '−';
  const val = document.createElement('span'); val.className = 'mono'; val.textContent = fmtKey(transpose);
  const up = document.createElement('button'); up.textContent = '＋';
  dn.onclick = () => { transpose = Math.max(-12, transpose - 1); eng.setTranspose(transpose); val.textContent = fmtKey(transpose); };
  up.onclick = () => { transpose = Math.min(12, transpose + 1); eng.setTranspose(transpose); val.textContent = fmtKey(transpose); };
  stepper.appendChild(dn); stepper.appendChild(val); stepper.appendChild(up);
  stepper.title = 'Shift the whole song up / down in semitones';
  row.appendChild(stepper);
  grp.appendChild(row);
  return grp;
}

function renderMaster() {
  const masterHost = document.getElementById('master');
  masterHost.innerHTML = '';
  const mwrap = document.createElement('div'); mwrap.className = 'masterfx';

  // Label
  const lbl = document.createElement('span'); lbl.className = 'mlbl'; lbl.textContent = 'MASTER';
  mwrap.appendChild(lbl);

  // Stereo L/R meters
  const stereoMeter = document.createElement('div'); stereoMeter.className = 'lvl-stereo';
  const meterLEl = document.createElement('div'); meterLEl.className = 'lvl';
  const meterLFill = document.createElement('div'); meterLFill.className = 'lvl-fill';
  meterLEl.appendChild(meterLFill);
  const meterREl = document.createElement('div'); meterREl.className = 'lvl';
  const meterRFill = document.createElement('div'); meterRFill.className = 'lvl-fill';
  meterREl.appendChild(meterRFill);
  stereoMeter.appendChild(meterLEl);
  stereoMeter.appendChild(meterREl);
  mwrap.appendChild(stereoMeter);

  // Knob groups mirroring lane strip layout
  const mixGrp = makeKgroup('MIX', [
    { label: 'vol', value: 1.0, onChange: v => eng.setMasterFX('vol',   v), tip: knobTip('vol'), k: 'vol' },
    { label: 'bal', value: 0.5, onChange: v => eng.setMasterFX('bal',   v), tip: knobTip('bal'), k: 'bal' },
    { label: 'wid', value: 0.5, onChange: v => eng.setMasterFX('width', v), tip: knobTip('wid'), k: 'wid' },
  ]);
  const toneGrp = makeKgroup('EQ', [
    { label: 'lo', value: 0.5, onChange: v => eng.setMasterFX('lo', v), tip: knobTip('lo'), k: 'lo' },
    { label: 'hi', value: 0.5, onChange: v => eng.setMasterFX('hi', v), tip: knobTip('hi'), k: 'hi' },
  ]);
  const fxGrp = makeKgroup('FX', [
    { label: 'vrb', value: 0, onChange: v => eng.setMasterFX('reverb', v), tip: knobTip('vrb'), k: 'vrb' },
    { label: 'cmp', value: 0, onChange: v => eng.setMasterFX('comp',   v), tip: knobTip('cmp'), k: 'cmp' },
  ]);
  // Tempo + transpose ride the header line (beside the label/meters) so they
  // stay on the top row on mobile while the FX knobrow wraps below.
  const songCtls = document.createElement('div');
  songCtls.className = 'master-song-ctls';
  songCtls.appendChild(makeTempoGroup());
  songCtls.appendChild(makeTransposeGroup());
  mwrap.appendChild(songCtls);

  mwrap.appendChild(makeKnobrow([mixGrp, toneGrp, fxGrp]));

  masterHost.appendChild(mwrap);
  cacheMeterFills();  // re-cache master meter fill refs after DOM rebuild
  updateEmptyGroups(); // hide master kgroups where all knobs are hidden
}

// ─── SONG tab (patterns row + nested chord line + chain row, on the screen) ──
function fmtKeyName(key) {
  return key ? `${key.root} ${key.mode}` : '';
}

let _chainDragFrom = null;

function renderPatterns() {
  const host = document.getElementById('lcd-song-rows');
  if (!host) return;
  host.innerHTML = '';
  const patterns = eng.getPatterns();
  const chain = eng.getChain();
  const editIdx = eng.getEditPatternIndex();

  // Patterns row: small "patterns" label (matching chords/chain rows) + slots +
  // duplicate/delete for the selected pattern.
  const prow = document.createElement('div');
  prow.className = 'pat-row';
  const plbl = document.createElement('span');
  plbl.className = 'pat-lbl';
  plbl.textContent = 'patterns';
  prow.appendChild(plbl);
  patterns.forEach((p, i) => {
    const b = document.createElement('button');
    b.className = 'pat-slot' + (i === editIdx ? ' sel' : '');
    b.dataset.idx = i;
    b.textContent = i === editIdx ? `${i + 1} ✎` : `${i + 1}`;
    b.title = 'click: edit this pattern — play will loop it';
    b.onclick = () => { eng.selectPattern(i); renderPatterns(); refreshVizPattern(); };
    prow.appendChild(b);
  });
  const add = document.createElement('button');
  add.className = 'pat-slot pat-add';
  add.textContent = '＋';
  add.title = 'add pattern';
  add.disabled = patterns.length >= 16;
  add.onclick = () => {
    const idx = eng.addPattern();
    if (idx !== null) { eng.selectPattern(idx); renderPatterns(); refreshVizPattern(); }
  };
  prow.appendChild(add);

  const dup = document.createElement('button');
  dup.className = 'pat-act'; dup.textContent = '⧉'; dup.title = 'duplicate pattern';
  dup.disabled = patterns.length >= 16;
  dup.onclick = () => {
    const idx = eng.duplicatePattern(editIdx);
    if (idx !== null) { eng.selectPattern(idx); renderPatterns(); refreshVizPattern(); }
  };
  prow.appendChild(dup);

  const del = document.createElement('button');
  del.className = 'pat-act'; del.textContent = '✕'; del.title = 'delete pattern';
  del.disabled = patterns.length <= 1;
  del.onclick = () => { eng.removePattern(editIdx); renderPatterns(); refreshVizPattern(); };
  prow.appendChild(del);
  host.appendChild(prow);

  // Chord line for the SELECTED pattern, nested under the patterns row (the
  // indent + spine say "this pattern's chords"). Chords belong to the pattern
  // (one per bar, cycling). Click anywhere → text input to edit (parser-backed);
  // empty → a "＋ chords" affordance. The status strip carries the SOUNDING
  // pattern's chords — this row is purely the edit pattern's.
  host.appendChild(buildChordLine(editIdx));

  // Chain row: chips (click = play chain from there; hover-✕ removes; drag reorders) + append.
  const crow = document.createElement('div');
  crow.className = 'chain-row';
  crow.innerHTML = `<span class="pat-lbl">chain</span>`;
  chain.forEach((pi, pos) => {
    const chip = document.createElement('button');
    chip.className = 'chain-chip';
    chip.dataset.pos = pos;
    chip.draggable = true;
    chip.innerHTML = `<span>${pi + 1}</span><span class="chip-x" title="remove">✕</span>`;
    chip.onclick = e => {
      if (e.target.classList.contains('chip-x')) { if (eng.removeChainAt(pos)) renderPatterns(); return; }
      eng.playChain(pos);
      renderPatterns();
    };
    chip.ondragstart = () => { _chainDragFrom = pos; chip.classList.add('dragging'); };
    chip.ondragend = () => { _chainDragFrom = null; chip.classList.remove('dragging'); };
    chip.ondragover = e => { e.preventDefault(); };
    chip.ondrop = e => {
      e.preventDefault();
      if (_chainDragFrom === null || _chainDragFrom === pos) return;
      const rect = chip.getBoundingClientRect();
      const before = e.clientX < rect.left + rect.width / 2;
      let to = before ? pos : pos + 1;
      if (_chainDragFrom < to) to--;           // account for the splice-out shifting targets left
      eng.moveChain(_chainDragFrom, to);
      renderPatterns();
    };
    crow.appendChild(chip);
  });
  const append = document.createElement('button');
  append.className = 'chain-chip chain-add';
  append.textContent = '＋';
  append.title = 'append selected pattern to chain';
  append.onclick = () => { eng.appendToChain(eng.getEditPatternIndex()); renderPatterns(); };
  crow.appendChild(append);
  host.appendChild(crow);

  renderStrip();        // chain/chords may have changed → rebuild the readout
  updatePatternsPlayback(eng.getPlaybackTarget());
  syncStripGrooves();   // edit pattern may have changed → resync strip dropdowns
}

// ─── LCD status strip (read-only narrator: title · chain · chords · key · bpm) ─
function renderStrip() {
  const host = document.getElementById('lcd-strip');
  if (!host) return;
  host.innerHTML = '';
  const s = eng.getSong();
  if (!s) return;
  const title = document.createElement('span');
  title.className = 'strip-title';
  title.textContent = (s.title || '').toUpperCase();
  host.appendChild(title);
  if (s.artist) {
    const credit = document.createElement('span');
    credit.className = 'strip-credit';
    credit.textContent = s.artist;
    host.appendChild(credit);
  }
  const chainWrap = document.createElement('span');
  chainWrap.className = 'strip-chain';
  eng.getChain().forEach((pi, pos) => {
    const seg = document.createElement('span');
    seg.className = 'strip-seg';
    seg.dataset.pos = pos;
    seg.textContent = pi + 1;
    chainWrap.appendChild(seg);
  });
  const loop = document.createElement('span');
  loop.className = 'strip-seg strip-loop hot';
  loop.hidden = true;
  chainWrap.appendChild(loop);
  host.appendChild(chainWrap);
  // Which pattern the editors are pointed at — visible from every view, in the
  // editing colour (teal), not the sounding colour (pink).
  const edit = document.createElement('span');
  edit.className = 'strip-seg strip-edit';
  edit.textContent = `✎ P${eng.getEditPatternIndex() + 1}`;
  host.appendChild(edit);
  // The strip is the door to the song's structure: tap it → Song tab.
  // It's a div, so make it a real control for keyboards / assistive tech.
  host.title = 'Open the Song editor';
  host.setAttribute('role', 'button');
  host.setAttribute('aria-label', 'Open the Song editor');
  host.tabIndex = 0;
  host.onclick = () => activateSongTab();
  host.onkeydown = e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activateSongTab(); }
  };
  const chordWrap = document.createElement('span');
  chordWrap.className = 'strip-chords';
  chordWrap.dataset.idx = -1;
  host.appendChild(chordWrap);
  const key = eng.getKey();
  if (key) {
    const keyEl = document.createElement('span');
    keyEl.className = 'strip-key';
    keyEl.textContent = fmtKeyName(key).toUpperCase();
    host.appendChild(keyEl);
  }
  const bpmEl = document.createElement('span');
  bpmEl.className = 'strip-bpm';
  bpmEl.id = 'strip-bpm';
  bpmEl.textContent = `${currentBpm} BPM`;
  host.appendChild(bpmEl);
  updateStrip(eng.getPlaybackTarget());
}

// Per-step strip update: hot-class moves only — chord segs rebuild only when
// the sounding pattern changes (a handful of nodes, on a bar boundary).
function updateStrip(target) {
  const host = document.getElementById('lcd-strip');
  if (!host || !target) return;
  const isPattern = target.kind === 'pattern';
  host.querySelectorAll('.strip-chain .strip-seg:not(.strip-loop)').forEach(seg => {
    seg.classList.toggle('hot', !isPattern && +seg.dataset.pos === target.chainPos);
  });
  const loop = host.querySelector('.strip-loop');
  if (loop) {
    loop.hidden = !isPattern;
    if (isPattern) loop.textContent = `LOOP P${target.patternIdx + 1}`;
  }
  const wrap = host.querySelector('.strip-chords');
  if (wrap) {
    if (+wrap.dataset.idx !== target.patternIdx) {
      wrap.dataset.idx = target.patternIdx;
      wrap.innerHTML = '';
      (eng.getPatternChords(target.patternIdx) || []).forEach((c, i) => {
        const seg = document.createElement('span');
        seg.className = 'strip-seg';
        seg.dataset.i = i;
        seg.textContent = c.name;
        wrap.appendChild(seg);
      });
    }
    const segs = wrap.querySelectorAll('.strip-seg');
    if (segs.length) {
      const hot = target.barInPattern % segs.length;
      segs.forEach(seg => seg.classList.toggle('hot', +seg.dataset.i === hot));
    }
  }
}

// Build the chord line for pattern `idx`: "chords" label + chord chips (or a
// "＋ chords" affordance when empty). Nested under the patterns row — the
// indent says whose chords they are, so no P-marker. The chip area is
// clickable → beginChordEdit swaps in the text input. Watching the sounding
// pattern's chords is the strip's job; this row is the edit pattern's.
function buildChordLine(idx) {
  const row = document.createElement('div');
  row.className = 'chord-row';
  row.dataset.idx = idx;
  const lbl = document.createElement('span');
  lbl.className = 'pat-lbl';
  lbl.textContent = 'chords';
  row.appendChild(lbl);

  const chips = document.createElement('div');
  chips.className = 'h-chips';
  const chords = eng.getPatternChords(idx) || [];
  if (chords.length) {
    chords.forEach((c, i) => {
      const chip = document.createElement('span');
      chip.className = 'h-chip';
      chip.dataset.idx = i;
      chip.textContent = c.name;
      chips.appendChild(chip);
    });
  } else {
    const add = document.createElement('span');
    add.className = 'h-chip h-empty';
    add.textContent = '＋ chords';
    chips.appendChild(add);
  }
  chips.onclick = () => beginChordEdit(idx);
  row.appendChild(chips);
  // The song's key rides the chords row — it's harmony information.
  const key = eng.getKey();
  if (key) {
    const badge = document.createElement('span');
    badge.className = 'h-key';
    badge.textContent = fmtKeyName(key);
    row.appendChild(badge);
  }
  return row;
}

// Swap the chip area for a text input prefilled from the pattern's chords.
// Enter / blur commit (parse → setPatternChords); Escape cancels; invalid input
// keeps a red border and stays editing.
function beginChordEdit(idx) {
  const host = document.getElementById('lcd-song-rows');
  const chips = host?.querySelector('.chord-row .h-chips');
  if (!chips) return;
  const chords = eng.getPatternChords(idx) || [];
  const input = document.createElement('input');
  input.className = 'h-edit';
  input.value = formatProgression(chords);
  input.placeholder = 'e.g. F#m D A E/G#';
  chips.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const cancel = () => { if (done) return; done = true; renderPatterns(); refreshVizPattern(); };
  const commit = () => {
    if (done) return;
    const text = input.value.trim();
    if (text === '') {                         // empty → clear the pattern's chords
      done = true;
      eng.selectPattern(idx);
      eng.setPatternChords([]);
      renderPatterns();
      refreshVizPattern();
      return;
    }
    const { chords: parsed, errors } = parseProgression(text);
    if (errors.length || !parsed.length) { input.classList.add('invalid'); return; }
    done = true;
    eng.selectPattern(idx);                    // setPatternChords targets the edit pattern
    eng.setPatternChords(parsed);
    renderPatterns();
    refreshVizPattern();   // melody/bass tinting reads the new chords/key
  };
  input.oninput = () => input.classList.remove('invalid');
  input.onkeydown = e => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
  };
  input.onblur = commit;
}

// Glow + row dimming — called from renderPatterns and every step.
function updatePatternsPlayback(target) {
  const host = document.getElementById('lcd-song-rows');
  if (!host || !target) return;
  const isPattern = target.kind === 'pattern';
  const prow = host.querySelector('.pat-row');
  const crow = host.querySelector('.chain-row');
  if (prow) prow.classList.toggle('dimmed', !isPattern);
  if (crow) crow.classList.toggle('dimmed', isPattern);
  host.querySelectorAll('.pat-slot').forEach(b => {
    b.classList.toggle('playing', isPattern && +b.dataset.idx === target.patternIdx);
  });
  host.querySelectorAll('.chain-chip').forEach(c => {
    c.classList.toggle('playing', !isPattern && +c.dataset.pos === target.chainPos);
  });
  // The chord row shows the EDIT pattern's chords; light the live chord only
  // when the edit pattern happens to be the one sounding. (The strip narrates
  // the sounding pattern; no prose status — the chips ARE the status.)
  const liveRow = host.querySelector('.chord-row');
  const chordChips = liveRow ? liveRow.querySelectorAll('.h-chip:not(.h-empty)') : [];
  if (chordChips.length) {
    const isSounding = +liveRow.dataset.idx === target.patternIdx;
    const sounding = target.barInPattern % chordChips.length;
    chordChips.forEach(chip => chip.classList.toggle('sounding', isSounding && +chip.dataset.idx === sounding));
  }
}

// Tell the viz the edit pattern changed (rebuilds the open editor).
function refreshVizPattern() {
  if (_editingLaneId) activateEditLane(_editingLaneId);
}

// ─── Reset FX to neutral (call before mount on song switch) ──────────────────
function resetFX() {
  for (const lane of eng.getLanes()) {
    eng.setLaneFX(lane.id, 'cut',    0.5);
    eng.setLaneFX(lane.id, 'res',    0);
    eng.setLaneFX(lane.id, 'drive',  0);
    eng.setLaneFX(lane.id, 'delay',  0);
    eng.setLaneFX(lane.id, 'fdbk',   0.3);
    eng.setLaneFX(lane.id, 'cho',    0);
    eng.setLaneFX(lane.id, 'wob',    0);
    eng.setLaneFX(lane.id, 'crush',  0);
    eng.setLaneFX(lane.id, 'vol',    1);
    eng.setLaneFX(lane.id, 'pan',    0.5);
    eng.setLaneFX(lane.id, 'reverb', 0);
    eng.setLaneFX(lane.id, 'comp',   0);
  }
  eng.setMasterFX('vol',    1);
  eng.setMasterFX('bal',    0.5);
  eng.setMasterFX('width',  0.5);
  eng.setMasterFX('lo',     0.5);
  eng.setMasterFX('hi',     0.5);
  eng.setMasterFX('reverb', 0);
  eng.setMasterFX('comp',   0);
}

// ─── Mount: (re)build all per-song UI ────────────────────────────────────────
function mount() {
  song = eng.getSong();
  // No credit line — the strip carries title + artist; the dropdown carries the title.
  renderStrips();
  renderFills();
  renderPunch();
  renderMaster();
  renderPatterns();   // also rebuilds the LCD status strip
  viz?.dispose?.();   // stop the outgoing viz's rAF loops before replacing it
  viz = makeViz(document.getElementById('lcd-body'), song, eng);
  // Scope/Song tabs off — lane editor takes over.
  document.querySelectorAll('[data-view]').forEach(x => x.classList.remove('on'));
  // Auto-open the first editable lane (drums or first non-chords lane).
  const lanes = eng.getLanes();
  const firstEditable = lanes.find(l => l.type !== 'chords') || lanes[0];
  if (firstEditable) activateEditLane(firstEditable.id);
}

// ─── Load a different song ────────────────────────────────────────────────────
function loadSong(key) {
  eng.stop();
  stopMeterLoop();
  const play = document.getElementById('play');
  play.classList.remove('on');
  play.textContent = '▶ play';
  eng.load(SONGS[key]);
  clearLoadedFrom();   // the registry item this session had loaded is gone
  _currentSongKey = key;
  songButtonLabel(presetLabel(key));
  afterSongLoad();
}

// Shared post-load path (preset switch + shared-song load): bpm/key sync, FX
// reset, full UI remount (mount → renderMaster rebuilds the TEMPO/TRANSPOSE
// controls from the synced state). Caller has already eng.load()ed the new song.
function afterSongLoad() {
  const s = eng.getSong();
  currentBpm = s.bpm;
  eng.setTempo(s.bpm);
  transpose = 0;
  eng.setTranspose(0);
  resetFX();
  mount();
}

// ─── Transport ───────────────────────────────────────────────────────────────
document.getElementById('play').onclick = async function() {
  if (this.classList.contains('on')) {
    eng.stop(); this.classList.remove('on'); this.textContent='▶ play';
    stopMeterLoop();
    updatePatternsPlayback(eng.getPlaybackTarget());
    updateStrip(eng.getPlaybackTarget());
  } else {
    await eng.play(); this.classList.add('on'); this.textContent='⏹ stop';
    startMeterLoop();
    updatePatternsPlayback(eng.getPlaybackTarget());
    updateStrip(eng.getPlaybackTarget());
  }
};
// (Tempo + transpose controls live on MASTER — built in renderMaster().)

// The song slot opens the cartridge drawer.
document.getElementById('songbtn').onclick = () => { _pickerOpen ? closePicker() : openPicker(); };

// ─── Theme picker — drawer with live swatches (Henry's request) ──────────────
// Each row's swatches carry data-theme, so the theme's OWN css block resolves
// the chip colours locally: cabinet · screen · accent · hot, never hardcoded.
const THEME_GROUPS = [
  ['', [['oyster', 'Oyster'], ['midnight', 'Midnight'], ['light', 'Light'], ['beige', 'Beige'], ['purple', 'Purple'], ['amber', 'Amber']]],
  ['Handhelds', [['playdate', 'Playdate'], ['gameboy', 'Game Boy'], ['r1', 'Rabbit'], ['switch', 'Switch']]],
  ['Consoles', [['atari2600', 'Atari 2600'], ['famicom', 'Famicom'], ['nes', 'NES'], ['snes', 'SNES'], ['snesus', 'SNES US'], ['megadrive', 'Sega'], ['ps1', 'PlayStation'], ['n64', 'N64'], ['dreamcast', 'Dreamcast'], ['gamecube', 'GameCube'], ['xbox', 'Xbox']]],
  ['Computers', [['spectrum', 'ZX Spectrum'], ['amiga', 'Amiga']]],
  ['Calculators', [['casiofx', 'Casio fx'], ['ti83', 'TI-83'], ['vl1', 'VL-Tone'], ['hp12c', 'HP-12C'], ['et66', 'Braun ET66'], ['littleprof', 'Little Professor']]],
  ['Studio', [['tr808', 'TR-808'], ['mpc', 'MPC'], ['dx7', 'DX7']]],
];
const THEME_LABELS = new Map(THEME_GROUPS.flatMap(([, ts]) => ts));
let _themePickerOpen = false;

function currentTheme() { return document.documentElement.dataset.theme || 'oyster'; }

function applyTheme(t) {
  if (t === 'oyster') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  localStorage.setItem('gb-theme', t);
  const btn = document.getElementById('themebtn');
  if (btn) btn.textContent = THEME_LABELS.get(t) || t;
  // Invalidate canvas colour cache + repaint active view with new colours.
  viz?.invalidateThemeColors?.();
}

function renderThemePicker() {
  const host = document.getElementById('theme-picker');
  if (!host) return;
  host.innerHTML = '';
  const head = document.createElement('div');
  head.className = 'picker-head';
  head.innerHTML = '<span>SELECT THEME</span>';
  const close = document.createElement('button');
  close.className = 'picker-close';
  close.textContent = '✕';
  close.setAttribute('aria-label', 'Close theme picker');
  close.onclick = () => closeThemePicker();
  head.appendChild(close);
  host.appendChild(head);
  const cur = currentTheme();
  for (const [label, themes] of THEME_GROUPS) {
    if (label) {
      const s = document.createElement('div');
      s.className = 'picker-sect';
      s.textContent = label;
      host.appendChild(s);
    }
    const grid = document.createElement('div');
    grid.className = 'theme-grid';
    for (const [value, name] of themes) {
      const b = document.createElement('button');
      b.className = 'ttile' + (value === cur ? ' sel' : '');
      b.title = name;
      // The plate carries data-theme, so the theme's OWN css block paints the
      // mini machine: cabinet, screen, accent play-bar, hot dot.
      b.innerHTML = `<span class="ttile-plate" data-theme="${esc(value)}">`
        + `<i class="tp-scr"></i><i class="tp-acc"></i><i class="tp-hot"></i></span>`
        + `<span class="ttile-nm">${esc(name)}</span>`;
      b.onclick = () => { applyTheme(value); renderThemePicker(); };   // stay open — theme browsing is the fun part
      grid.appendChild(b);
    }
    host.appendChild(grid);
  }
}

function openThemePicker() {
  renderThemePicker();
  _themePickerOpen = true;
  const host = document.getElementById('theme-picker');
  if (host) host.hidden = false;
  document.getElementById('themebtn')?.classList.add('open');
}
function closeThemePicker() {
  if (!_themePickerOpen) return;
  _themePickerOpen = false;
  const host = document.getElementById('theme-picker');
  if (host) host.hidden = true;
  document.getElementById('themebtn')?.classList.remove('open');
}
document.getElementById('themebtn').onclick = () => { _themePickerOpen ? closeThemePicker() : openThemePicker(); };
document.addEventListener('click', e => {
  if (!_themePickerOpen) return;
  const host = document.getElementById('theme-picker');
  const btn = document.getElementById('themebtn');
  if (host && !host.contains(e.target) && e.target !== btn && !btn?.contains(e.target)) closeThemePicker();
});
// Screen picker (Settings) — override the theme's glass with a chosen LCD.
document.getElementById('screensel').onchange = e => {
  const v = e.target.value;
  if (v === 'default') delete document.documentElement.dataset.screen;
  else document.documentElement.dataset.screen = v;
  localStorage.setItem('gb-screen', v);
  viz.invalidateThemeColors?.();
};

// (Scope + quick-edit lane tabs are built and wired in renderViewTabs().)

// ─── Step callback (registered once; closes over module-level song/viz) ──────
eng.onStep(({ absStep, bar, stepInBar, fill, queue, target }) => {
  viz.setStep({ absStep, bar, stepInBar, target });
  const fillsHost = document.getElementById('fills');
  if (fillsHost) {
    fillsHost.querySelectorAll('.fillbtn').forEach(btn => {
      btn.classList.toggle('firing', btn.dataset.fill === fill);
    });
    renderChain(queue);
  }
  updatePatternsPlayback(target);
  updateStrip(target);
});

// ─── Restore saved theme ──────────────────────────────────────────────────────
(function () {
  let saved = localStorage.getItem('gb-theme');
  if (saved === 'dark') saved = 'midnight';   // Dark was renamed; Oyster is the default now
  if (saved && saved !== 'oyster') {
    document.documentElement.dataset.theme = saved;
    const btn = document.getElementById('themebtn');
    if (btn) btn.textContent = THEME_LABELS.get(saved) || saved;
  }
  const screen = localStorage.getItem('gb-screen');
  if (screen && screen !== 'default') {
    document.documentElement.dataset.screen = screen;
    const ssel = document.getElementById('screensel');
    if (ssel) ssel.value = screen;
  }
})();

// ─── View-settings: hidden-knob persistence ───────────────────────────────────
// Apply persisted hidden-knob body classes before first render.
(function () {
  const hidden = JSON.parse(localStorage.getItem('gb-hidden-knobs') || '[]');
  for (const k of hidden) document.body.classList.add('hide-k-' + k);
})();

// ─── Help modal ───────────────────────────────────────────────────────────────
document.querySelectorAll('#help-tabs .help-tab').forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll('#help-tabs .help-tab').forEach(b => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.help-section').forEach(s => s.classList.toggle('active', s.dataset.help === btn.dataset.help));
  };
});
document.getElementById('help-btn').onclick = () => {
  document.getElementById('help-modal').hidden = false;
};
document.getElementById('help-modal-close').onclick = () => {
  document.getElementById('help-modal').hidden = true;
};
document.getElementById('help-modal-backdrop').onclick = () => {
  document.getElementById('help-modal').hidden = true;
};
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { document.getElementById('help-modal').hidden = true; closePicker(); closeThemePicker(); }
});

// ─── View-settings popover ────────────────────────────────────────────────────
const _vsBtn  = document.getElementById('viewsettings-btn');
const _vsPanel = document.getElementById('viewsettings');

// All 12 lane knob keys (master-only keys excluded from presets).
const ALL_LANE_KNOBS = ['vol','pan','cut','res','drv','dly','fdbk','cho','wob','cru','vrb','cmp'];

// Preset definitions: name → visible lane-knob keys.
const PRESETS = [
  { name: 'All',      visible: ['vol','pan','cut','res','drv','dly','fdbk','cho','wob','cru','vrb','cmp'] },
  { name: 'Standard', visible: ['vol','pan','cut','drv','vrb','cmp'] },
  { name: 'Simple',   visible: ['vol','pan','cut'] },
  { name: 'Mixer',    visible: ['vol','pan'] },
];

// Return the matching preset name for the given hidden-set (array), or null.
function matchPreset(hiddenArr) {
  const hiddenSet = new Set(hiddenArr);
  for (const p of PRESETS) {
    const expectedHidden = ALL_LANE_KNOBS.filter(k => !p.visible.includes(k));
    if (
      expectedHidden.length === hiddenSet.size &&
      expectedHidden.every(k => hiddenSet.has(k))
    ) return p.name;
  }
  return null;
}

// Return true if the given hidden-set matches the saved user set.
function matchUserPreset(hiddenArr) {
  const saved = JSON.parse(localStorage.getItem('gb-user-knobs') || 'null');
  if (!saved) return false;
  const a = [...hiddenArr].sort().join(',');
  const b = [...saved].sort().join(',');
  return a === b;
}

// Hide/show each .kgroup depending on whether ALL its knobs are hidden.
function updateEmptyGroups() {
  const hidden = new Set(JSON.parse(localStorage.getItem('gb-hidden-knobs') || '[]'));
  document.querySelectorAll('.kgroup').forEach(grp => {
    const knobs = grp.querySelectorAll('.knob[data-k]');
    if (knobs.length === 0) return; // no knobs → leave as-is
    const allHidden = [...knobs].every(kn => hidden.has(kn.dataset.k));
    grp.style.display = allHidden ? 'none' : '';
  });
}

// FX-type knobs only (vol/pan/cut are always-on routing — hiding stays visual).
// Maps knob key → [engine param, off value].
const FX_KNOB_MAP = {
  res:  ['res',   0],
  drv:  ['drive', 0],
  dly:  ['delay', 0],
  fdbk: ['fdbk',  0],
  cho:  ['cho',   0],
  wob:  ['wob',   0],
  cru:  ['crush', 0],
  vrb:  ['reverb',0],
  cmp:  ['comp',  0],
};

// Single path for all hidden-set changes: apply body classes, sync checkboxes,
// persist to localStorage, and update the active preset highlight.
function setHiddenSet(hiddenArr) {
  // Apply body classes for ALL known knobs (not just lane knobs).
  const allKnobs = Object.keys(KNOB_INFO);
  for (const k of allKnobs) {
    document.body.classList.toggle('hide-k-' + k, hiddenArr.includes(k));
  }
  // Sync checkboxes.
  const _vsForm = document.getElementById('viewsettings-checks');
  if (_vsForm) {
    _vsForm.querySelectorAll('input[data-vs-k]').forEach(cb => {
      cb.checked = !hiddenArr.includes(cb.dataset.vsK);
    });
  }
  // Persist.
  localStorage.setItem('gb-hidden-knobs', JSON.stringify(hiddenArr));
  // Auto-save to user preset when the selection is Custom (no built-in preset matches).
  const active = matchPreset(hiddenArr);
  if (active === null) {
    localStorage.setItem('gb-user-knobs', JSON.stringify(hiddenArr));
  }
  // Highlight matching preset button.
  // Priority: built-in preset > User > none.
  const isUser = active === null && matchUserPreset(hiddenArr);
  document.querySelectorAll('.vs-preset-btn').forEach(btn => {
    if (btn.dataset.preset === 'User') {
      btn.classList.toggle('on', isUser);
      // Enable/disable based on whether a user set has been saved.
      const hasSaved = localStorage.getItem('gb-user-knobs') !== null;
      btn.disabled = !hasSaved;
    } else {
      btn.classList.toggle('on', btn.dataset.preset === active);
    }
  });
  // Disengage FX-type knobs that are now hidden: zero their engine param on every
  // current lane. Lanes added later start with defaults (all FX off) so they're
  // already consistent. Re-enabling a knob does nothing here — the user re-dials.
  const hiddenSet = new Set(hiddenArr);
  for (const lane of eng.getLanes()) {
    for (const [k, [param, offVal]] of Object.entries(FX_KNOB_MAP)) {
      if (hiddenSet.has(k)) {
        eng.setLaneFX(lane.id, param, offVal);
      }
    }
  }
  // Hide groups where all knobs are now hidden.
  updateEmptyGroups();
}

// Build the grouped checkbox rows (labels/tips come from KNOB_INFO).
const _vsForm = document.getElementById('viewsettings-checks');
// Grouped to mirror the knob strips (MIX/TONE/FX kgroups) + the master-only knobs.
const _vsGroups = [
  ['MIX',    ['vol', 'pan']],
  ['TONE',   ['cut', 'res', 'drv']],
  ['FX',     ['dly', 'fdbk', 'cho', 'wob', 'cru', 'vrb', 'cmp']],
  ['MASTER', ['bal', 'wid', 'lo', 'hi']],
];

// ── Preset row (inserted before the checkboxes) ──
const _vsPresetRow = document.createElement('div');
_vsPresetRow.className = 'vs-presets';
const _vsPresetLbl = document.createElement('span');
_vsPresetLbl.className = 'vs-preset-lbl';
_vsPresetLbl.textContent = 'Presets';
_vsPresetRow.appendChild(_vsPresetLbl);
const _vsPresetBtns = document.createElement('div');
_vsPresetBtns.className = 'vs-preset-btns';
for (const p of PRESETS) {
  const btn = document.createElement('button');
  btn.className = 'vs-preset-btn';
  btn.dataset.preset = p.name;
  btn.textContent = p.name;
  btn.onclick = () => {
    const hidden = ALL_LANE_KNOBS.filter(k => !p.visible.includes(k));
    // Preserve master-knob hidden state (bal/wid/lo/hi stay unchanged).
    const current = JSON.parse(localStorage.getItem('gb-hidden-knobs') || '[]');
    const masterHidden = current.filter(k => !ALL_LANE_KNOBS.includes(k));
    setHiddenSet([...hidden, ...masterHidden]);
  };
  _vsPresetBtns.appendChild(btn);
}
// User preset button — recalls the last hand-made (Custom) selection.
{
  const userBtn = document.createElement('button');
  userBtn.className = 'vs-preset-btn';
  userBtn.dataset.preset = 'User';
  userBtn.textContent = 'User';
  const hasSavedUser = localStorage.getItem('gb-user-knobs') !== null;
  userBtn.disabled = !hasSavedUser;
  userBtn.onclick = () => {
    const saved = JSON.parse(localStorage.getItem('gb-user-knobs') || 'null');
    if (!saved) return;
    setHiddenSet(saved);
  };
  _vsPresetBtns.appendChild(userBtn);
}
_vsPresetRow.appendChild(_vsPresetBtns);
_vsForm.before(_vsPresetRow);

for (const [groupName, groupKeys] of _vsGroups) {
  const head = document.createElement('div');
  head.className = 'vs-group-lbl';
  head.textContent = groupName;
  _vsForm.appendChild(head);
  for (const k of groupKeys) {
    const info = KNOB_INFO[k];
    const row = document.createElement('label');
    row.className = 'vs-row';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.dataset.vsK = k;
    const hidden = JSON.parse(localStorage.getItem('gb-hidden-knobs') || '[]');
    cb.checked = !hidden.includes(k);
    cb.addEventListener('change', () => {
      const nowHidden = JSON.parse(localStorage.getItem('gb-hidden-knobs') || '[]');
      if (cb.checked) {
        const idx = nowHidden.indexOf(k);
        if (idx !== -1) nowHidden.splice(idx, 1);
      } else {
        if (!nowHidden.includes(k)) nowHidden.push(k);
      }
      setHiddenSet(nowHidden);
    });
    const lbl = document.createElement('span');
    lbl.textContent = info ? info[0] : k;
    row.appendChild(cb);
    row.appendChild(lbl);
    _vsForm.appendChild(row);
  }
}

// ── Display section: global UI toggles (all default off) ──
{
  const head = document.createElement('div');
  head.className = 'vs-group-lbl';
  head.textContent = 'DISPLAY';
  _vsForm.appendChild(head);
  // `key` doubles as the localStorage key and the body class, so one grep
  // finds every representation of a toggle.
  const addToggle = (label, key, onChange) => {
    const row = document.createElement('label');
    row.className = 'vs-row';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = localStorage.getItem(key) === '1';
    document.body.classList.toggle(key, cb.checked);
    cb.addEventListener('change', () => {
      document.body.classList.toggle(key, cb.checked);
      localStorage.setItem(key, cb.checked ? '1' : '0');
      if (onChange) onChange();
    });
    const lbl = document.createElement('span');
    lbl.textContent = label;
    row.appendChild(cb);
    row.appendChild(lbl);
    _vsForm.appendChild(row);
  };
  addToggle('Knob values', 'gb-knob-values');
  addToggle('Wrap knobs (mobile)', 'gb-knob-wrap', updateAllKnobrowFades);
}

// Highlight the matching preset on load (based on already-restored hidden set).
{
  const initialHidden = JSON.parse(localStorage.getItem('gb-hidden-knobs') || '[]');
  const active = matchPreset(initialHidden);
  const isUser = active === null && matchUserPreset(initialHidden);
  document.querySelectorAll('.vs-preset-btn').forEach(btn => {
    if (btn.dataset.preset === 'User') {
      btn.classList.toggle('on', isUser);
    } else {
      btn.classList.toggle('on', btn.dataset.preset === active);
    }
  });
}

_vsBtn.onclick = e => {
  e.stopPropagation();
  _vsPanel.hidden = !_vsPanel.hidden;
};
document.addEventListener('click', e => {
  if (!_vsPanel.contains(e.target) && e.target !== _vsBtn) {
    _vsPanel.hidden = true;
  }
});

// ─── Section drag-reorder ─────────────────────────────────────────────────────
// Wraps each top-level section in a .sec div with a .sec-drag handle once at
// startup. The handle lives outside the section's innerHTML so re-renders
// (renderStrips, renderFills, etc.) never remove it. Order is persisted to
// localStorage('gb-section-order').

function saveSectionOrder() {
  const inner = document.querySelector('.cabinet-inner');
  if (!inner) return;
  const order = [...inner.querySelectorAll(':scope > .sec')].map(w => w.dataset.sec);
  localStorage.setItem('gb-section-order', JSON.stringify(order));
}

function initSectionWrappers() {
  const inner = document.querySelector('.cabinet-inner');
  if (!inner) return;

  // 1. Wrap each section element in a .sec div with a drag handle
  for (const id of SECTION_IDS) {
    const sec = document.getElementById(id);
    if (!sec) continue;
    const wrap = document.createElement('div');
    wrap.className = 'sec';
    wrap.dataset.sec = id;
    sec.replaceWith(wrap);
    const handle = document.createElement('span');
    handle.className = 'sec-drag';
    handle.title = 'Drag to reorder section';
    handle.textContent = '⠿';
    wrap.appendChild(handle);
    wrap.appendChild(sec);
  }

  // 2. Restore saved order (move wrappers within .cabinet-inner).
  // Tolerant of orders saved before newer sections existed (e.g. punch):
  // keep the user's sequence, splice missing sections in at their default
  // position, drop ids that no longer exist.
  const saved = JSON.parse(localStorage.getItem('gb-section-order') || 'null');
  if (saved && Array.isArray(saved) && saved.length) {
    const order = saved.filter(id => SECTION_IDS.includes(id));
    for (const id of SECTION_IDS) {
      if (!order.includes(id)) order.splice(SECTION_IDS.indexOf(id), 0, id);
    }
    for (const id of order) {
      const wrap = inner.querySelector(`.sec[data-sec="${id}"]`);
      if (wrap) inner.appendChild(wrap);
    }
  }

  // 3. Wire drag-and-drop on each .sec wrapper
  let _dragIndicator = null;

  inner.querySelectorAll('.sec').forEach(wrap => {
    const handle = wrap.querySelector('.sec-drag');

    handle.addEventListener('mousedown', () => { wrap.draggable = true; });
    handle.addEventListener('mouseup',   () => { wrap.draggable = false; });

    wrap.addEventListener('dragstart', e => {
      _draggedSecId = wrap.dataset.sec;
      wrap.classList.add('sec-dragging');
      e.dataTransfer.effectAllowed = 'move';
      // Prevent lane-drag handlers from also firing
      e.stopPropagation();
    });

    wrap.addEventListener('dragend', () => {
      wrap.classList.remove('sec-dragging');
      wrap.draggable = false;
      _draggedSecId = null;
      inner.querySelectorAll('.sec').forEach(w => w.classList.remove('sec-drop-above', 'sec-drop-below'));
    });

    wrap.addEventListener('dragover', e => {
      if (!_draggedSecId || _draggedSecId === wrap.dataset.sec) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
      const rect = wrap.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      inner.querySelectorAll('.sec').forEach(w => w.classList.remove('sec-drop-above', 'sec-drop-below'));
      if (e.clientY < midY) wrap.classList.add('sec-drop-above');
      else                   wrap.classList.add('sec-drop-below');
    });

    wrap.addEventListener('dragleave', e => {
      // Only clear if leaving the wrapper entirely (not entering a child)
      if (!wrap.contains(e.relatedTarget)) {
        wrap.classList.remove('sec-drop-above', 'sec-drop-below');
      }
    });

    wrap.addEventListener('drop', e => {
      e.preventDefault();
      e.stopPropagation();
      if (!_draggedSecId || _draggedSecId === wrap.dataset.sec) return;
      const draggedWrap = inner.querySelector(`.sec[data-sec="${_draggedSecId}"]`);
      if (!draggedWrap) return;
      const rect = wrap.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      if (e.clientY < midY) {
        inner.insertBefore(draggedWrap, wrap);
      } else {
        wrap.after(draggedWrap);
      }
      inner.querySelectorAll('.sec').forEach(w => w.classList.remove('sec-drop-above', 'sec-drop-below'));
      saveSectionOrder();
    });
  });
}

// ─── Initial load ─────────────────────────────────────────────────────────────
const BOOT_SONG = 'press-start';
eng.load(SONGS[BOOT_SONG]);
_currentSongKey = BOOT_SONG;
songButtonLabel(presetLabel(BOOT_SONG));
const initialSong = eng.getSong();
currentBpm = initialSong.bpm;
eng.setTempo(initialSong.bpm);
mount();
// Wrap sections and wire section drag-reorder once, after first mount.
initSectionWrappers();

// ─── Share registry ───────────────────────────────────────────────────────────
function gbNotice(msg) {
  let el = document.getElementById('gb-notice');
  if (!el) {
    el = document.createElement('div');
    el.id = 'gb-notice';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(gbNotice._t);
  gbNotice._t = setTimeout(() => el.classList.remove('show'), 2600);
}
const shareHooks = {
  notice: gbNotice,
  onSongLoaded: (rec) => {
    afterSongLoad();
    // The slot is the title surface — shared songs read "♫ name — author".
    if (rec) {
      _currentSongKey = `s:${rec.id}`;
      songButtonLabel(`♫ ${rec.name}${rec.author ? ` — ${rec.author}` : ''}`);
    }
  },
  onGroovesChanged: () => { renderStrips(); refreshVizPattern(); },
  // v1: import into the first matching lane (multi-lane-same-type songs are
  // rare; the groove still lands correctly, just without a picker).
  pickLane: lanes => Promise.resolve(lanes[0].id),
};
initShare(eng, shareHooks);
maybeLoadShared(eng, shareHooks);

// ─── Discovery shelf — prefetch the registry list for the picker ─────────────
// Fire-and-forget: no registry (vite dev / offline) → no shelf, app unaffected.
listItems('song', 25)
  .then(({ items }) => { if (Array.isArray(items)) _sharedItems = items; })
  .catch(() => { /* shelf is best-effort */ });
// Press-and-hold on a control must not open the browser context menu (Android
// Chrome long-press → "more actions / translate"). Scoped to controls so
// right-click elsewhere stays normal on desktop.
document.addEventListener('contextmenu', e => {
  // Target can be a Text node on some WebKit paths — normalize to an Element.
  const el = e.target instanceof Element ? e.target : e.target.parentElement;
  if (el && el.closest('.knob, .punchpad, .lane-expand, .knob-scroll-hint, .lane-drag, .sec-drag, #viz')) {
    e.preventDefault();
  }
});
