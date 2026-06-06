import { createEngine } from '../engine/index.js';
import { laneAudible } from '../engine/song.js';
import { kids } from '../songs/kids.js';
import { risingSun } from '../songs/rising-sun.js';
import { electricFeel } from '../songs/electric-feel.js';
import { heartbeats } from '../songs/heartbeats.js';
import { digitalLove } from '../songs/digital-love.js';
import { memoryReboot } from '../songs/memory-reboot.js';
import { takeOnMe } from '../songs/take-on-me.js';
import { makeViz } from './viz.js';
import { makeKnob } from './knob.js';

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

const SONGS = { kids, 'rising-sun': risingSun, 'electric-feel': electricFeel, heartbeats, 'digital-love': digitalLove, 'memory-reboot': memoryReboot, 'take-on-me': takeOnMe };

const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// Module-level refs — reassigned by mount() on every song switch.
let song;
let viz;
// Track which lane is currently open in the viz (for edit-button highlight).
let _editingLaneId = null;

// ─── Drag-reorder state ───────────────────────────────────────────────────────
let _draggedLaneId = null;

// ─── Section drag-reorder state ───────────────────────────────────────────────
const SECTION_IDS = ['viz', 'strips', 'fills', 'master', 'arrange'];
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

// Quick-edit tabs in the VIEW bar: one per editable lane (emoji + name) + Scope.
// Rebuilt on every renderStrips() so it tracks add/dup/remove/rename.
function renderViewTabs() {
  const bar = document.querySelector('.vtabs');
  if (!bar) return;
  bar.innerHTML = '<span class="vtabs-lbl">VIEW</span>';
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
  scope.textContent = '📈 Scope';
  scope.onclick = () => toggleScope(scope);
  bar.appendChild(scope);
  if (_editingLaneId) updateEditHighlight(_editingLaneId);
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
    viz.setView('scope');
  }
}

// Open a lane editor in the viz + update highlight.
function activateEditLane(id) {
  viz.editLane(id);
  updateEditHighlight(id);
}

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

    msgroup.before(mixGrp, toneGrp, fxGrp);
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

// ─── Master FX ───────────────────────────────────────────────────────────────
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
  mwrap.appendChild(mixGrp);
  mwrap.appendChild(toneGrp);
  mwrap.appendChild(fxGrp);

  masterHost.appendChild(mwrap);
  cacheMeterFills();  // re-cache master meter fill refs after DOM rebuild
  updateEmptyGroups(); // hide master kgroups where all knobs are hidden
}

// ─── PATTERNS module (patterns row + chain row + playback label) ─────────────
let _chainDragFrom = null;

function renderPatterns() {
  const host = document.getElementById('arrange');   // id kept for saved section order
  if (!host) return;
  host.innerHTML = '';
  const patterns = eng.getPatterns();
  const chain = eng.getChain();
  const editIdx = eng.getEditPatternIndex();
  const editPat = patterns[editIdx];

  const head = document.createElement('div');
  head.className = 'arrange-head';
  head.innerHTML = `<span class="albl">PATTERNS</span><span class="pat-editing">Editing: Pattern ${editIdx + 1}</span><span class="pat-playing" id="pat-playing"></span>`;
  host.appendChild(head);

  // Patterns row: slots + length + duplicate/delete for the selected pattern.
  const prow = document.createElement('div');
  prow.className = 'pat-row';
  patterns.forEach((p, i) => {
    const b = document.createElement('button');
    b.className = 'pat-slot' + (i === editIdx ? ' sel' : '');
    b.dataset.idx = i;
    b.textContent = i + 1;
    b.title = 'edit (loops while playing)';
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

  const len = document.createElement('span');
  len.className = 'pat-len';
  len.innerHTML = `<span class="pat-lbl">length</span>` +
    [1, 2, 4].map(n => `<button class="pat-len-btn${editPat?.bars === n ? ' on' : ''}" data-n="${n}">${n}</button>`).join('');
  len.querySelectorAll('.pat-len-btn').forEach(b => b.onclick = () => {
    eng.setPatternBars(editIdx, +b.dataset.n);
    renderPatterns(); refreshVizPattern();
  });
  prow.appendChild(len);

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

  updatePatternsPlayback(eng.getPlaybackTarget());
  syncStripGrooves();   // edit pattern may have changed → resync strip dropdowns
}

// Glow + label + row dimming — called from renderPatterns and every step.
function updatePatternsPlayback(target) {
  const host = document.getElementById('arrange');
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
  const lbl = host.querySelector('#pat-playing');
  if (lbl) {
    const chain = eng.getChain();
    lbl.textContent = isPattern
      ? `Playing: Pattern ${target.patternIdx + 1} (loop)`
      : `Playing: Chain · ${chain.map((pi, i) => (i === target.chainPos ? '▸' : '') + (pi + 1)).join(' ')}`;
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
  const creditEl = document.getElementById('credit');
  if (creditEl) creditEl.textContent = song.artist ? `${song.title || ''} — ${song.artist}` : '';
  renderStrips();
  renderFills();
  renderMaster();
  renderPatterns();
  viz = makeViz(document.getElementById('viz'), song, eng);
  // Scope tab off — lane editor takes over.
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
  const s = eng.getSong();
  const bpm = document.getElementById('bpm');
  bpm.value = s.bpm;
  document.getElementById('bpmv').textContent = s.bpm;
  eng.setTempo(s.bpm);
  transpose = 0;
  eng.setTranspose(0);
  updateKeyDisplay();
  resetFX();
  mount();
}

// ─── Transport ───────────────────────────────────────────────────────────────
document.getElementById('play').onclick = async function() {
  if (this.classList.contains('on')) {
    eng.stop(); this.classList.remove('on'); this.textContent='▶ play';
    stopMeterLoop();
  } else {
    await eng.play(); this.classList.add('on'); this.textContent='⏹ stop';
    startMeterLoop();
  }
};
document.getElementById('bpm').oninput = e => { eng.setTempo(+e.target.value); document.getElementById('bpmv').textContent = e.target.value; };

// ─── KEY / transpose ─────────────────────────────────────────────────────────
let transpose = 0;
let keyQuantizeOn = localStorage.getItem('gb-key-quantize') === '1';
function fmtKey(n) { return n > 0 ? '+' + n : String(n); }
function updateKeyDisplay() { document.getElementById('keyv').textContent = fmtKey(transpose); }
document.getElementById('key-dn').onclick = () => {
  transpose = Math.max(-12, transpose - 1);
  eng.setTranspose(transpose);
  updateKeyDisplay();
};
document.getElementById('key-up').onclick = () => {
  transpose = Math.min(12, transpose + 1);
  eng.setTranspose(transpose);
  updateKeyDisplay();
};
const _keyQBtn = document.getElementById('key-q');
function applyKeyQuantizeState() {
  _keyQBtn.setAttribute('aria-pressed', String(keyQuantizeOn));
  _keyQBtn.classList.toggle('on', keyQuantizeOn);
}
_keyQBtn.onclick = () => {
  keyQuantizeOn = !keyQuantizeOn;
  eng.setKeyQuantize(keyQuantizeOn);
  localStorage.setItem('gb-key-quantize', keyQuantizeOn ? '1' : '0');
  applyKeyQuantizeState();
};
// Restore persisted state
eng.setKeyQuantize(keyQuantizeOn);
applyKeyQuantizeState();

document.getElementById('songsel').onchange = e => loadSong(e.target.value);
document.getElementById('themesel').onchange = e => {
  const t = e.target.value;
  if (t === 'dark') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  localStorage.setItem('gb-theme', t);
  // Invalidate canvas colour cache + repaint active view with new colours.
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
});

// ─── Restore saved theme ──────────────────────────────────────────────────────
(function () {
  const saved = localStorage.getItem('gb-theme');
  if (saved && saved !== 'dark') {
    document.documentElement.dataset.theme = saved;
    const sel = document.getElementById('themesel');
    if (sel) sel.value = saved;
  }
})();

// ─── View-settings: hidden-knob persistence ───────────────────────────────────
// Apply persisted hidden-knob body classes before first render.
(function () {
  const hidden = JSON.parse(localStorage.getItem('gb-hidden-knobs') || '[]');
  for (const k of hidden) document.body.classList.add('hide-k-' + k);
})();

// ─── Help modal ───────────────────────────────────────────────────────────────
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
  if (e.key === 'Escape') document.getElementById('help-modal').hidden = true;
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

// Build checkbox rows from KNOB_INFO
const _vsForm = document.getElementById('viewsettings-checks');
const _vsKnobs = ['vol','pan','cut','res','drv','dly','fdbk','cho','wob','cru','vrb','cmp','bal','wid','lo','hi'];

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

for (const k of _vsKnobs) {
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

  // 2. Restore saved order (move wrappers within .cabinet-inner)
  const saved = JSON.parse(localStorage.getItem('gb-section-order') || 'null');
  if (saved && Array.isArray(saved) && saved.length === SECTION_IDS.length) {
    for (const id of saved) {
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
eng.load(kids);
const initialSong = eng.getSong();
document.getElementById('bpm').value = initialSong.bpm;
document.getElementById('bpmv').textContent = initialSong.bpm;
eng.setTempo(initialSong.bpm);
mount();
// Wrap sections and wire section drag-reorder once, after first mount.
initSectionWrappers();
