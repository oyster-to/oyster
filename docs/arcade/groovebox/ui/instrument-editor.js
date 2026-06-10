// ui/instrument-editor.js — edit one instrument's patch (PR2 slice 3).
// Pattern follows ui/punch-editor.js: deep-cloned draft, sliders read ranges
// from the engine registry (PATCH_PARAMS), hold-to-TEST auditions the UNSAVED
// draft live (the playing loop sounds it), SAVE persists to localStorage.
import { PATCH_PARAMS, OSC_SHAPES, validateInstrument, DEFAULT_INSTRUMENTS } from '../engine/instruments.js';

// UI metadata only — ranges/scales live in PATCH_PARAMS (one source of truth).
const PARAM_UI = {
  'volume':                 { label: 'volume',      fmt: v => `${v.toFixed(1)} dB` },
  'envelope.attack':        { label: 'attack',      fmt: v => `${(v * 1000).toFixed(0)} ms` },
  'envelope.decay':         { label: 'decay',       fmt: v => `${(v * 1000).toFixed(0)} ms` },
  'envelope.sustain':       { label: 'sustain',     fmt: v => v.toFixed(2) },
  'envelope.release':       { label: 'release',     fmt: v => `${(v * 1000).toFixed(0)} ms` },
  'oscillator.width':       { label: 'pulse width', fmt: v => v.toFixed(2) },
  'filter.freq':            { label: 'filter Hz',   fmt: v => `${Math.round(v)} Hz` },
  'filterEnvelope.baseFrequency': { label: 'flt base', fmt: v => `${Math.round(v)} Hz` },
  'filterEnvelope.octaves': { label: 'flt sweep',   fmt: v => v.toFixed(1) },
  'pitch.pitchDecay':       { label: 'pitch drop',  fmt: v => `${(v * 1000).toFixed(0)} ms` },
  'pitch.octaves':          { label: 'pitch range', fmt: v => v.toFixed(1) },
  'trigger.velocity':       { label: 'hit level',   fmt: v => v.toFixed(2) },
};

// Which params each archetype exposes (only ones the synth actually reads).
const ARCHETYPE_PARAMS = {
  membrane: ['volume', 'pitch.pitchDecay', 'pitch.octaves', 'trigger.velocity'],
  noise:    ['volume', 'envelope.attack', 'envelope.decay', 'envelope.sustain', 'envelope.release', 'filter.freq', 'trigger.velocity'],
  mono:     ['volume', 'envelope.attack', 'envelope.decay', 'envelope.sustain', 'envelope.release',
             'filterEnvelope.baseFrequency', 'filterEnvelope.octaves', 'trigger.velocity'],
  poly:     ['volume', 'envelope.attack', 'envelope.decay', 'envelope.sustain', 'envelope.release',
             'oscillator.width', 'trigger.velocity'],
};

// slider position (0..1) ↔ value, honouring the registry's scale
function posToVal(id, pos) {
  const { min, max, scale } = PATCH_PARAMS[id];
  if (scale === 'log') return min * Math.pow(max / min, pos);
  return min + (max - min) * pos;
}
function valToPos(id, v) {
  const { min, max, scale } = PATCH_PARAMS[id];
  if (scale === 'log') return Math.log(v / min) / Math.log(max / min);
  return (v - min) / (max - min);
}

const get = (o, p) => p.split('.').reduce((x, k) => (x == null ? x : x[k]), o);
function set(o, p, v) {
  const ks = p.split('.');
  let t = o;
  for (const k of ks.slice(0, -1)) t = (t[k] = t[k] || {});
  t[ks.at(-1)] = v;
}

let _open = false;
export const isInstrumentEditorOpen = () => _open;

/**
 * openInstrumentEditor({ id, eng, onSaved })
 * id — instrument id in the engine's set (e.g. 'gb-kick', 'gb-bass')
 */
export function openInstrumentEditor({ id, patch, eng, onSaved, onPreview, onRestore, onCommit }) {
  if (_open) return;
  const stash = eng.getInstruments();
  const startPatch = patch ?? stash[id];
  if (!startPatch) return;                  // stale/unknown id — never open broken
  _open = true;
  let draft = JSON.parse(JSON.stringify(startPatch));
  let previewing = false;
  let _tweakTimer = null, _tweakLast = 0;
  // Persistence/preview hooks. Default = the global instrument set (+ localStorage)
  // — used by the drum-slot editor. The lane EDIT injects per-lane (song-local)
  // hooks so editing forks to a Custom patch instead of mutating the stock preset.
  const preview = d => onPreview ? onPreview(d) : eng.setInstruments({ ...stash, [id]: d });
  const restore = () => onRestore ? onRestore() : eng.setInstruments(stash);
  const persist = d => {
    if (onCommit) { onCommit(d); return; }
    const next = { ...stash, [id]: d };
    eng.setInstruments(next);
    localStorage.setItem('gb-instruments', JSON.stringify(next));
  };
  function applyDraftLive() {
    if (!previewing) return;
    const now = Date.now();
    const run = () => { _tweakLast = Date.now(); if (previewing) preview(draft); };
    if (now - _tweakLast > 150) run();
    else { clearTimeout(_tweakTimer); _tweakTimer = setTimeout(run, 150 - (now - _tweakLast)); }
  }

  const backdrop = document.createElement('div');
  backdrop.id = 'inst-editor-backdrop';
  const modal = document.createElement('div');
  modal.id = 'inst-editor';
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);

  function stopPreview() {
    if (!previewing) return;
    previewing = false;
    restore();                              // undo the live preview
  }
  function close() {
    stopPreview();
    _open = false;
    backdrop.remove();
    document.removeEventListener('keydown', onKey, true);
  }
  function onKey(e) {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
  }
  document.addEventListener('keydown', onKey, true);
  backdrop.addEventListener('pointerdown', e => { if (e.target === backdrop) close(); });

  function save() {
    if (!validateInstrument(draft)) return;
    previewing = false;                     // a still-held TEST must not restore over the save
    draft.name = (draft.name || 'Sound').trim().slice(0, 24) || 'Sound';
    persist(draft);                         // global set (default) or song-local fork (lane EDIT)
    close();
    onSaved?.();
  }

  const label = t => { const s = document.createElement('span'); s.className = 'ie-rl'; s.textContent = t; return s; };
  const value = t => { const s = document.createElement('span'); s.className = 'ie-val'; s.textContent = t; return s; };

  function refreshSave() {
    const btn = modal.querySelector('.ie-save');
    if (btn) btn.disabled = !validateInstrument(draft);
  }

  function render() {
    modal.innerHTML = '';
    // header: name + hold-to-TEST (auditions the UNSAVED draft over the loop)
    const hd = document.createElement('div');
    hd.className = 'ie-hd';
    const name = document.createElement('input');
    name.className = 'ie-name';
    name.maxLength = 24;
    name.value = draft.name;
    name.oninput = () => { draft.name = name.value; refreshSave(); };
    const test = document.createElement('button');
    test.className = 'ie-test';
    test.innerHTML = eng.isPlaying() ? 'TEST<small>hold to hear</small>' : 'TEST<small>tap to hear</small>';
    test.addEventListener('pointerdown', e => {
      e.preventDefault(); test.setPointerCapture(e.pointerId);
      if (!validateInstrument(draft)) return;
      if (!eng.isPlaying()) { eng.auditionInstrument(draft); return; }   // one-shot, no transport needed
      previewing = true;
      preview(draft);                                  // draft is live while held
    });
    test.addEventListener('pointerup', stopPreview);
    test.addEventListener('pointercancel', stopPreview);
    hd.append(name, test);
    modal.appendChild(hd);

    // oscillator shape (mono/poly only)
    if (draft.patch.archetype === 'mono' || draft.patch.archetype === 'poly') {
      const row = document.createElement('div');
      row.className = 'ie-row';
      row.appendChild(label('waveform'));
      const sel = document.createElement('select');
      sel.className = 'ie-sel';
      for (const sh of OSC_SHAPES) {
        const o = document.createElement('option');
        o.value = sh; o.textContent = sh === 'fatsawtooth' ? 'fat saw' : sh;
        if ((draft.patch.oscillator?.shape ?? 'triangle') === sh) o.selected = true;
        sel.appendChild(o);
      }
      sel.onchange = () => { set(draft.patch, 'oscillator.shape', sel.value); refreshSave(); };
      row.appendChild(sel);
      modal.appendChild(row);
    }

    // param sliders — ranges/scales straight from the registry
    for (const pid of ARCHETYPE_PARAMS[draft.patch.archetype] ?? []) {
      if (pid === 'filter.freq' && !draft.patch.filter) continue;   // no filter on this patch
      const ui = PARAM_UI[pid];
      const cur = get(draft.patch, pid);
      const reg = PATCH_PARAMS[pid];
      const shown = cur ?? (pid === 'trigger.velocity' ? 1 : (reg.min + reg.max) / 2);
      const row = document.createElement('div');
      row.className = 'ie-row';
      const v = value(ui.fmt(shown));
      const s = document.createElement('input');
      s.type = 'range'; s.min = 0; s.max = 1000; s.step = 1;
      s.className = 'ie-slider';
      s.value = Math.round(valToPos(pid, shown) * 1000);
      s.oninput = () => {
        const nv = posToVal(pid, s.value / 1000);
        set(draft.patch, pid, Math.round(nv * 1000) / 1000);
        v.textContent = ui.fmt(get(draft.patch, pid));
        applyDraftLive();                            // throttled — see above
        refreshSave();
      };
      row.append(label(ui.label), s, v);
      modal.appendChild(row);
    }

    // footer
    const ft = document.createElement('div');
    ft.className = 'ie-ft';
    const reset = document.createElement('button');
    reset.className = 'ie-reset';
    reset.textContent = 'reset to default';
    reset.onclick = () => {
      if (DEFAULT_INSTRUMENTS[id]) { draft = JSON.parse(JSON.stringify(DEFAULT_INSTRUMENTS[id])); render(); }
    };
    const cancel = document.createElement('button');
    cancel.className = 'ie-cancel';
    cancel.textContent = 'cancel';
    cancel.onclick = close;
    const saveBtn = document.createElement('button');
    saveBtn.className = 'ie-save';
    saveBtn.textContent = 'SAVE';
    saveBtn.onclick = save;
    ft.append(reset, cancel, saveBtn);
    modal.appendChild(ft);
    refreshSave();
  }

  render();
}
