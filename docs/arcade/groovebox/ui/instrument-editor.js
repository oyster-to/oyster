// ui/instrument-editor.js — edit one instrument's patch (PR2 slice 3).
// Pattern follows ui/punch-editor.js: deep-cloned draft, sliders read ranges
// from the engine registry (PATCH_PARAMS), hold-to-TEST auditions the UNSAVED
// draft live (the playing loop sounds it), SAVE persists to localStorage.
import { PATCH_PARAMS, OSC_SHAPES, validateInstrument, DEFAULT_INSTRUMENTS } from '../engine/instruments.js';
import { BRIGHT_OPEN } from '../engine/voices.js';
import { posToVal, valToPos } from './curve-math.js';
import { makeEnvGraph } from './env-graph.js';
import { makeFilterGraph } from './filter-graph.js';
import { makeKnob } from './knob.js';

// Short uppercase labels for the knob layout (the slider rows use PARAM_UI.label).
const KNOB_LABEL = {
  'volume': 'vol', 'trigger.velocity': 'hit',
  'vibrato.rate': 'vib hz', 'vibrato.depth': 'amt', 'oscillator.width': 'width',
  'filterEnvelope.baseFrequency': 'base', 'filterEnvelope.octaves': 'sweep',
};
// Waveform glyphs (20×13 viewBox, stroked with currentColor) for the icon picker.
const WAVE_ICON = {
  sawtooth:    '<polyline points="1,11 7,2 7,11 13,2 13,11 19,2 19,11"/>',
  fatsawtooth: '<polyline points="2,11 8,3 8,11 14,3 14,11 19,3"/><polyline points="1,11 6,5 6,11 11,5" opacity=".45"/>',
  square:      '<polyline points="1,11 1,3 10,3 10,11 19,11 19,3"/>',
  pulse:       '<polyline points="1,11 1,3 5,3 5,11 19,11"/>',
  triangle:    '<polyline points="1,11 6,2 11,11 16,2 20,9"/>',
  sine:        '<path d="M1,7 Q6,0 11,7 T20,7"/>',
};

// UI metadata only — ranges/scales live in PATCH_PARAMS (one source of truth).
const PARAM_UI = {
  'volume':                 { label: 'volume',      fmt: v => `${v.toFixed(1)} dB` },
  'envelope.attack':        { label: 'attack',      fmt: v => `${(v * 1000).toFixed(0)} ms` },
  'envelope.decay':         { label: 'decay',       fmt: v => `${(v * 1000).toFixed(0)} ms` },
  'envelope.sustain':       { label: 'sustain',     fmt: v => v.toFixed(2) },
  'envelope.release':       { label: 'release',     fmt: v => `${(v * 1000).toFixed(0)} ms` },
  'oscillator.width':       { label: 'pulse width', fmt: v => v.toFixed(2) },
  'filter.freq':            { label: 'filter Hz',   fmt: v => `${Math.round(v)} Hz` },
  'filter.Q':               { label: 'resonance',   fmt: v => v.toFixed(1) },
  'vibrato.rate':           { label: 'vibrato Hz',  fmt: v => `${v.toFixed(1)} Hz` },
  'vibrato.depth':          { label: 'vibrato amt', fmt: v => v.toFixed(2) },
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
             'oscillator.width', 'filter.freq', 'filter.Q', 'vibrato.rate', 'vibrato.depth', 'trigger.velocity'],
};

// slider position (0..1) ↔ value math now lives in ./curve-math.js (shared with
// the envelope/filter graphs).

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
 * openInstrumentEditor({ id, patch, eng, onSaved, onPreview, onRestore, onCommit })
 *   id    — instrument id in the global set (e.g. 'gb-kick'); the draft source
 *           and the default persistence target. Optional when `patch` is given.
 *   patch — explicit starting patch (used by the lane EDIT, where the lane's
 *           instrument may be a song-local custom not in the global set).
 *   onPreview/onRestore/onCommit — optional hooks. Default persists to the global
 *           instrument set + localStorage (drum-slot editor). The lane EDIT injects
 *           per-lane hooks so SAVE forks to a song-local Custom patch.
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
    eng.setInstruments({ ...stash, [id]: d });
    // Persist ONLY this edited instrument as an override (not the whole bank) —
    // otherwise localStorage freezes every stock preset at today's values and
    // future preset updates would never reach the user.
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem('gb-instruments') || '{}') || {}; } catch (_) { saved = {}; }
    saved[id] = d;
    localStorage.setItem('gb-instruments', JSON.stringify(saved));
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
  const section = (t, tag) => {
    const s = document.createElement('div'); s.className = 'ie-sec';
    s.innerHTML = `<b>${t}</b><i></i>${tag ? `<span class="ie-tag">${tag}</span>` : ''}`;
    return s;
  };
  // graphs + knobs mutate draft.patch in place; mirror the slider rows' live-preview + save-refresh
  const onGraphInput = () => { applyDraftLive(); refreshSave(); };

  // One knob bound to a registry param (normalized 0..1 in/out, value formatted
  // back through PARAM_UI). onChange mutates the draft + live-previews like a row.
  const paramKnob = pid => {
    const reg = PATCH_PARAMS[pid], ui = PARAM_UI[pid];
    const cur = get(draft.patch, pid) ?? (pid === 'trigger.velocity' ? 1 : (reg.min + reg.max) / 2);
    return makeKnob({
      label: KNOB_LABEL[pid] ?? ui.label, tip: ui.label,
      value: valToPos(pid, cur),
      fmt: norm => ui.fmt(posToVal(pid, norm)),
      onChange: norm => {
        set(draft.patch, pid, Math.round(posToVal(pid, norm) * 1000) / 1000);
        applyDraftLive(); refreshSave();
      },
    });
  };
  const knobGroup = (title, pids, tag) => {
    const row = document.createElement('div'); row.className = 'ie-knobrow';
    for (const pid of pids) row.appendChild(paramKnob(pid));
    return [section(title, tag), row];
  };
  // waveform icon picker (replaces the dropdown); re-renders on change so the
  // pulse-width knob can appear/vanish with the shape.
  const waveformButtons = () => {
    const wrap = document.createElement('div'); wrap.className = 'ie-waves';
    const curShape = draft.patch.oscillator?.shape ?? 'triangle';
    for (const sh of OSC_SHAPES) {
      const b = document.createElement('button');
      b.className = 'ie-wv' + (sh === curShape ? ' on' : '');
      b.title = sh === 'fatsawtooth' ? 'fat saw' : sh;
      b.innerHTML = `<svg viewBox="0 0 20 13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round">${WAVE_ICON[sh]}</svg>`;
      b.onclick = () => { set(draft.patch, 'oscillator.shape', sh); refreshSave(); render(); };
      wrap.appendChild(b);
    }
    return wrap;
  };

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

    // mono/poly get the graph + knob layout (matches the mock); membrane/noise
    // keep the slider rows for now. Seed/complete the graphed blocks first.
    const archetype = draft.patch.archetype;
    const knobby = archetype === 'mono' || archetype === 'poly';
    if (knobby) {
      const e = draft.patch.envelope ?? (draft.patch.envelope = {});
      if (e.attack === undefined) e.attack = 0.01;
      if (e.decay === undefined) e.decay = 0.2;
      if (e.sustain === undefined) e.sustain = 0.5;
      if (e.release === undefined) e.release = 0.2;
    }
    if (archetype === 'poly') {
      // Seed a NEUTRAL filter + vibrato (freq = BRIGHT_OPEN, Q = 1 mirror the
      // engine's transparent openInsert, so an edit→save round-trip never shifts
      // the velocity→brightness base cutoff).
      const f = draft.patch.filter ?? (draft.patch.filter = { type: 'lowpass', freq: BRIGHT_OPEN });
      if (f.Q === undefined) f.Q = 1;
      const vib = draft.patch.vibrato ?? (draft.patch.vibrato = {});
      if (vib.rate === undefined) vib.rate = 5;
      if (vib.depth === undefined) vib.depth = 0;
    }

    if (knobby) {
      modal.appendChild(waveformButtons());
      modal.append(section('amp env'), makeEnvGraph(draft.patch.envelope, onGraphInput));
      if (archetype === 'poly') {
        modal.append(section('filter', 'cutoff + reso'), makeFilterGraph(draft.patch.filter, onGraphInput));
        const mod = ['vibrato.rate', 'vibrato.depth'];
        if (draft.patch.oscillator?.shape === 'pulse') mod.unshift('oscillator.width');
        modal.append(...knobGroup('mod', mod));
      } else {   // mono: filter-envelope as knobs (the sweep graph is a later slice)
        modal.append(...knobGroup('filter', ['filterEnvelope.baseFrequency', 'filterEnvelope.octaves'], 'sweep'));
      }
      modal.append(...knobGroup('level', ['volume', 'trigger.velocity']));
    } else {
      // param sliders — ranges/scales straight from the registry (membrane/noise)
      for (const pid of ARCHETYPE_PARAMS[archetype] ?? []) {
        if (pid.startsWith('filter.') && !draft.patch.filter) continue;     // patch has no filter block
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
