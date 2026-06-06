// Punch preset editor (v3.5) — ✎ on a pad opens a modal editing that slot's
// preset as a deep-cloned draft. TEST auditions the unsaved draft (playing
// only); SAVE validates → setPunchPresets → localStorage. Spec:
// project-notes/oyster/po20/2026-06-08-punch-editor-v3.5-spec.md
import { MODULE_PARAMS, scaleValue } from '../engine/punch.js';
import { DEFAULT_PRESETS, validatePreset } from '../engine/punch-presets.js';

// Labels/format only — ranges and scale come from MODULE_PARAMS (single truth).
export const PARAM_UI = {
  'crusher.wet':        { label: 'Bit crush',     fmt: v => v.toFixed(2) },
  'filter.freq':        { label: 'Filter cutoff', fmt: v => v >= 1000 ? (v / 1000).toFixed(1) + 'k' : String(Math.round(v)) },
  'filter.Q':           { label: 'Resonance',     fmt: v => v.toFixed(1) },
  'delay.wet':          { label: 'Echo',          fmt: v => v.toFixed(2) },
  'delay.feedback':     { label: 'Echo feedback', fmt: v => v.toFixed(2) },
  'gate.depth':         { label: 'Gate',          fmt: v => v.toFixed(2) },
  'transport.tapeStop': { label: 'Tape stop',     fmt: v => v.toFixed(2) },
};

const UNITS = ['steps', 'beats', 'bars'];
const UNIT_MAX = { steps: 8, beats: 8, bars: 4 };
const QUANTIZE = [['immediate', 'instant'], ['bar', 'next bar'], ['pattern', 'pattern start']];
const GATE_DIVISIONS = ['1/8', '1/16', '1/32'];

// ── pure helpers (unit-tested) ────────────────────────────────────────────────
export function draftFromPreset(preset) {
  return JSON.parse(JSON.stringify(preset));
}

// Slider position (0..1) ↔ param value, interpolated in the param's own scale.
export function paramPos(id, value) {
  const r = MODULE_PARAMS[id];
  if (r.scale === 'log') return Math.log(value / r.min) / Math.log(r.max / r.min);
  return (value - r.min) / (r.max - r.min);
}
export function paramValue(id, pos) {
  const r = MODULE_PARAMS[id];
  return scaleValue(r.min, r.max, Math.max(0, Math.min(1, pos)), r.scale);
}

export function availableParams(draft) {
  const used = new Set(draft.automations.map(a => `${a.module}.${a.param}`));
  return Object.keys(MODULE_PARAMS).filter(id => !used.has(id));
}

export function defaultAutomation(id) {
  const [module, param] = id.split('.');
  const r = MODULE_PARAMS[id];
  const a = {
    module, param, from: 'neutral',
    to: paramValue(id, 0.6),
    engage:  { ramp: { unit: 'steps', value: 0.5 } },
    release: { ramp: { unit: 'steps', value: 0.5 } },
  };
  if (id === 'gate.depth') a.division = '1/16';
  if (r.scale === 'log') a.to = Math.round(a.to);
  return a;
}

export function isPunchEditorOpen() {
  return !!document.getElementById('punch-editor-backdrop');
}

// ── modal ─────────────────────────────────────────────────────────────────────
// openPunchEditor({ slot, eng, onSaved }) — builds the modal, manages the
// draft, persists on SAVE. onSaved() re-renders the pads.
export function openPunchEditor({ slot, eng, onSaved }) {
  if (isPunchEditorOpen()) return;
  let draft = draftFromPreset(eng.getPunchPresets()[slot]);
  let previewHeld = false;
  let _saveBtn = null;
  function refreshSave() { if (_saveBtn) _saveBtn.disabled = !validatePreset(draft); }

  const backdrop = document.createElement('div');
  backdrop.id = 'punch-editor-backdrop';
  const modal = document.createElement('div');
  modal.id = 'punch-editor';
  backdrop.appendChild(modal);

  function stopPreview() {
    if (previewHeld) { eng.punchPreview(draft, false); previewHeld = false; }
  }
  function close() {
    stopPreview();
    backdrop.remove();
    document.removeEventListener('keydown', onKey, true);
  }
  function onKey(e) {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
  }
  document.addEventListener('keydown', onKey, true);
  backdrop.addEventListener('pointerdown', e => { if (e.target === backdrop) close(); });

  function save() {
    if (!validatePreset(draft)) return;
    draft.name = (draft.name || 'PAD').toUpperCase().slice(0, 12);
    const five = eng.getPunchPresets().map((p, i) => (i === slot ? draft : p));
    eng.setPunchPresets(five);
    localStorage.setItem('gb-punch-presets', JSON.stringify(eng.getPunchPresets()));
    close();
    onSaved?.();
  }

  function render() {
    const valid = validatePreset(draft);
    const playing = eng.isPlaying();
    modal.innerHTML = '';

    // Header: name input + key badge + TEST
    const hd = document.createElement('div');
    hd.className = 'pe-hd';
    const name = document.createElement('input');
    name.className = 'pe-name';
    name.maxLength = 12;
    name.value = draft.name;
    name.oninput = () => { draft.name = name.value; };
    const badge = document.createElement('span');
    badge.className = 'pe-badge';
    badge.textContent = `key ${draft.key} · slot ${slot + 1} of 5`;
    const test = document.createElement('button');
    test.className = 'pe-test' + (playing ? '' : ' idle');
    test.innerHTML = 'TEST<small>hold to hear</small>';
    test.addEventListener('pointerdown', e => {
      e.preventDefault(); test.setPointerCapture(e.pointerId);
      if (!eng.isPlaying()) {            // live check — not the render-time snapshot
        test.classList.add('idle');
        test.innerHTML = 'TEST<small>press ▶ first</small>';
        return;
      }
      test.classList.remove('idle');
      test.innerHTML = 'TEST<small>hold to hear</small>';
      if (validatePreset(draft)) { eng.punchPreview(draft, true); previewHeld = true; }
    });
    const off = () => stopPreview();
    test.addEventListener('pointerup', off);
    test.addEventListener('pointercancel', off);
    hd.append(name, badge, test);
    modal.appendChild(hd);

    // Effect rows
    draft.automations.forEach((a, idx) => {
      const id = `${a.module}.${a.param}`;
      const reg = MODULE_PARAMS[id];
      const ui = PARAM_UI[id] || { label: id, fmt: v => String(v) };
      const fx = document.createElement('div');
      fx.className = 'pe-fx';
      const fxhd = document.createElement('div');
      fxhd.className = 'pe-fxhd';
      fxhd.innerHTML = `<span class="pe-fxname">${ui.label}</span>`;
      const rm = document.createElement('button');
      rm.className = 'pe-rm';
      rm.textContent = '✕ remove';
      rm.onclick = () => { draft.automations.splice(idx, 1); render(); };
      fxhd.appendChild(rm);
      fx.appendChild(fxhd);

      // value slider (registry range, registry scale) — updates in place;
      // a full re-render here would destroy the slider mid-drag.
      fx.appendChild(sliderRow('amount', paramPos(id, a.to), ui.fmt(a.to), (pos, setVal) => {
        a.to = paramValue(id, pos);
        if (reg.scale === 'log') a.to = Math.round(a.to);
        setVal(ui.fmt(a.to));
        refreshSave();
      }));

      // gate division
      if (id === 'gate.depth') {
        const row = document.createElement('div');
        row.className = 'pe-row';
        row.append(label('chop'), select(GATE_DIVISIONS.map(d => [d, d]), a.division || '1/16', v => { a.division = v; }));
        fx.appendChild(row);
      }

      // ramps
      const PHASE_LABEL = { engage: 'fade in', release: 'fade out' };
      for (const phase of ['engage', 'release']) {
        const ramp = (a[phase] = a[phase] || { ramp: { unit: 'steps', value: 0.5 } }).ramp;
        const row = document.createElement('div');
        row.className = 'pe-row';
        const rl = label(PHASE_LABEL[phase]);
        rl.title = 'How long the effect takes to morph ' + (phase === 'engage' ? 'in after press' : 'away after release') + ' — steps are 16th-note grid cells (16/bar), beats are quarter notes';
        row.appendChild(rl);
        const rv = value(`${ramp.value}`);
        const s = slider(ramp.value / UNIT_MAX[ramp.unit], pos => {
          ramp.value = Math.round(pos * UNIT_MAX[ramp.unit] * 10) / 10;
          rv.textContent = `${ramp.value}`;
          refreshSave();
        });
        row.appendChild(s);
        row.appendChild(rv);
        const sel = select(UNITS.map(u => [u, u]), ramp.unit, v => { ramp.unit = v; ramp.value = Math.min(ramp.value, UNIT_MAX[v]); render(); });
        row.appendChild(sel);
        fx.appendChild(row);
      }
      modal.appendChild(fx);
    });

    // + add effect
    const avail = availableParams(draft);
    if (avail.length) {
      const addRow = document.createElement('div');
      addRow.className = 'pe-add';
      const sel = select([['', '＋ add effect'], ...avail.map(id => [id, PARAM_UI[id]?.label || id])], '', id => {
        if (id) { draft.automations.push(defaultAutomation(id)); render(); }
      });
      addRow.appendChild(sel);
      modal.appendChild(addRow);
    }

    // quantize
    const q = document.createElement('div');
    q.className = 'pe-row pe-q';
    const sl = label('snap · press');
    sl.title = 'WHEN the effect fires after pressing: instantly, on the next bar, or at pattern start (bar 1)';
    q.appendChild(sl);
    q.appendChild(select(QUANTIZE, draft.engageQuantize, v => { draft.engageQuantize = v; }));
    const rl2 = label('snap · release');
    rl2.title = 'WHEN the release takes effect after letting go';
    q.appendChild(rl2);
    q.appendChild(select(QUANTIZE, draft.releaseQuantize, v => { draft.releaseQuantize = v; }));
    modal.appendChild(q);

    // footer
    const ft = document.createElement('div');
    ft.className = 'pe-ft';
    const reset = document.createElement('button');
    reset.className = 'pe-reset';
    reset.textContent = 'reset to default';
    reset.onclick = () => { draft = draftFromPreset(DEFAULT_PRESETS[slot]); render(); };
    const cancel = document.createElement('button');
    cancel.className = 'pe-cancel';
    cancel.textContent = 'cancel';
    cancel.onclick = close;
    const saveBtn = document.createElement('button');
    saveBtn.className = 'pe-save';
    saveBtn.textContent = 'SAVE';
    saveBtn.disabled = !valid;
    saveBtn.onclick = save;
    _saveBtn = saveBtn;
    ft.append(reset, cancel, saveBtn);
    modal.appendChild(ft);
  }

  // small DOM builders
  function label(text) { const el = document.createElement('span'); el.className = 'pe-rl'; el.textContent = text; return el; }
  function value(text) { const el = document.createElement('span'); el.className = 'pe-val'; el.textContent = text; return el; }
  function slider(pos, onPos) {
    const el = document.createElement('input');
    el.type = 'range'; el.min = 0; el.max = 1000; el.value = Math.round(Math.max(0, Math.min(1, pos)) * 1000);
    el.className = 'pe-slider';
    el.oninput = () => onPos(el.valueAsNumber / 1000);
    return el;
  }
  function sliderRow(lbl, pos, val, onPos) {
    const row = document.createElement('div');
    row.className = 'pe-row';
    const v = value(val);
    row.append(label(lbl), slider(pos, p => onPos(p, t => { v.textContent = t; })), v);
    return row;
  }
  function select(pairs, current, onChange) {
    const el = document.createElement('select');
    el.className = 'pe-sel';
    for (const [v, text] of pairs) {
      const o = document.createElement('option');
      o.value = v; o.textContent = text; o.selected = v === current;
      el.appendChild(o);
    }
    el.onchange = () => onChange(el.value);
    return el;
  }

  render();
  document.body.appendChild(backdrop);
}
