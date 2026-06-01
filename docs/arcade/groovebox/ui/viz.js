import { stepsPerBar, beatStarts } from '../engine/meter.js';
import { resolveDrumPattern, hasDrumHit, drumVoiceAudible, laneAudible, chordAt } from '../engine/song.js';
import { laneByType } from '../engine/lanes.js';

// ─── Canvas theme colour cache ────────────────────────────────────────────────
// Canvas ctx.fillStyle/strokeStyle cannot read CSS vars, so we resolve them
// once from getComputedStyle and cache. Call invalidateThemeColors() on theme
// change to force a fresh read on the next draw.
let _tc = null;
function themeColors() {
  if (_tc) return _tc;
  const cs = getComputedStyle(document.documentElement);
  const g = n => cs.getPropertyValue(n).trim() || '#888';
  _tc = {
    acc:     g('--acc'),
    scope:   g('--scope'),
    note:    g('--roll-note'),
    grid:    g('--grid-line'),
    playhead:g('--playhead'),
    rollBg:  g('--roll-bg'),
    rollBlk: g('--roll-bg-blk'),
    ink:     g('--ink'),
    dim:     g('--dim'),
    faint:   g('--faint'),
  };
  return _tc;
}
export function invalidateThemeColors() { _tc = null; }

const DROWS = [['kick','Kick'],['snare','Snare'],['hat','HH'],['tom','Tom'],['crash','Crash']];

// Piano-roll helpers (ported from prototype).
const NMG = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
function noteToMidi(n) {
  const m = n.match(/^([A-G])(#|b)?(-?\d)$/);
  if (!m) return 60;
  const b = {C:0,D:2,E:4,F:5,G:7,A:9,B:11}[m[1]] + (m[2]==='#' ? 1 : m[2]==='b' ? -1 : 0);
  return (parseInt(m[3]) + 1) * 12 + b;
}
const ROLL_KB = 30;           // keyboard column width in canvas pixels
const ROLL_LO = 57;           // A3
const ROLL_HI = 81;           // A5
const ROLL_ROWS = ROLL_HI - ROLL_LO + 1;
const BLACK_DEGREES = new Set([1, 3, 6, 8, 10]);  // semitones-mod-12 that are black keys

// Deep-clone a single 1-bar pattern object.
const clonePat = p => {
  const o = {};
  for (const k in p) o[k] = Array.isArray(p[k]) ? p[k].map(v => Array.isArray(v) ? v.slice() : v) : p[k];
  return o;
};

// Expand any pattern (single bar or array) to a 4-bar editable array.
const fork4 = src => [0,1,2,3].map(b => clonePat(Array.isArray(src) ? src[b % src.length] : src));

// Bass note range: two octaves roughly centred on bass register.
const BASS_LO = 28;   // E1
const BASS_HI = 51;   // Eb3  (covers typical bass lines well)
const BASS_ROWS = BASS_HI - BASS_LO + 1;

export function makeViz(host, song, eng) {
  let view = 'drums';
  let editBars = new Set([0]);
  let customLen = 4;
  let lastBar = 0, lastStepInBar = 0;
  // Scope state
  let scopeSource = 'master';
  let scopeRafId = null;

  // Current edit target lane (set by editLane(id)).
  // Falls back to laneByType for the initial state.
  let _targetLane = null;
  function getTargetLane() {
    // Prefer the explicitly-set target; fall back gracefully.
    if (_targetLane) return _targetLane;
    return laneByType(song.lanes, view === 'bass' ? 'bass' : view === 'melody' ? 'melody' : 'drums');
  }

  function primaryBar() { return Math.min(...editBars); }

  // Ensure pool.custom + pool._base exist (fork from current selection).
  function ensureCustom() {
    const L = getTargetLane();
    if (!L.pool.custom) {
      const src = L.pool[L.selection];
      L.pool.custom = fork4(src);
      L.pool._base  = fork4(src);
      customLen = L.cycleLen || 4;
      L.cycleLen = customLen;
      eng.setLane(L.id, 'custom');
    }
  }

  function drumEdit(k, step) {
    ensureCustom();
    const L = getTargetLane();
    const prim = L.pool.custom[primaryBar()];
    // Decide on/off from the primary (shown) bar.
    const on = k === 'tom'
      ? !(prim.tom && prim.tom.some(x => x[0] === step))
      : !(prim[k] && prim[k].includes(step));
    // Apply to every bar in editBars.
    editBars.forEach(b => {
      const p = L.pool.custom[b];
      if (k === 'tom') {
        p.tom = p.tom || [];
        const i = p.tom.findIndex(x => x[0] === step);
        if (on) { if (i < 0) p.tom.push([step, 3]); }
        else     { if (i >= 0) p.tom.splice(i, 1); }
      } else {
        p[k] = p[k] || [];
        const i = p[k].indexOf(step);
        if (on) { if (i < 0) p[k].push(step); }
        else     { if (i >= 0) p[k].splice(i, 1); }
      }
    });
    paint(lastBar, lastStepInBar);
  }

  function buildBarSelector() {
    const L = getTargetLane();
    // Compute playingBar from lastBar relative to current cycle.
    const cyc = L.selection === 'custom' ? customLen : 1;
    const playingBar = ((lastBar % cyc) + cyc) % cyc;

    let bb = '';
    for (let b = 0; b < customLen; b++) {
      const on = editBars.has(b) ? ' on' : '';
      const playing = (L.selection === 'custom' && b === playingBar) ? ' playing' : '';
      bb += `<button class="bsel${on}${playing}" data-b="${b}">${b + 1}</button>`;
    }
    const c2 = customLen === 2 ? ' on' : '';
    const c4 = customLen === 4 ? ' on' : '';
    return `<div class="barsel">`
      + `<span style="color:var(--acc)">edit</span>/<span style="color:var(--hot)">▸play</span> ${bb}`
      + ` <span style="margin-left:10px;opacity:.7">cycle</span>`
      + ` <button class="cyc${c2}" data-c="2">2</button>`
      + `<button class="cyc${c4}" data-c="4">4</button>`
      + ` <span style="opacity:.55;margin-left:8px"><span style="color:#9fb4d8">groove</span>·<span style="color:var(--warn)">added</span></span>`
      + `</div>`;
  }

  function buildBeatHeader(spb) {
    const beats = beatStarts(song.meter);
    const beatSet = new Set(beats);
    const beatNum = new Map(beats.map((s, i) => [s, i + 1]));
    const slots = Array.from({length: spb}, (_, i) => {
      if (beatSet.has(i)) return `<div class="vhcell beat">${beatNum.get(i)}</div>`;
      return `<div class="vhcell"></div>`;
    }).join('');
    return `<div class="vhead"><div class="vhl"></div>${slots}</div>`;
  }

  // ---- melody piano-roll ----

  function drawRoll(playheadAbsStep) {
    const cv = host.querySelector('#mroll');
    if (!cv) return;
    const ctx = cv.getContext('2d');
    const W = cv.width, H = cv.height;
    ctx.clearRect(0, 0, W, H);

    const spb = stepsPerBar(song.meter);
    const totalSteps = 4 * spb;
    const kbW = ROLL_KB, gW = W - kbW;
    const rh = H / ROLL_ROWS;

    const tc = themeColors();

    // Draw pitch rows (keyboard column + grid background).
    for (let mm = ROLL_LO; mm <= ROLL_HI; mm++) {
      const y = (ROLL_HI - mm) * rh;
      const deg = ((mm % 12) + 12) % 12;
      const blk = BLACK_DEGREES.has(deg);
      // Keyboard column — slightly darker than the roll bg.
      ctx.fillStyle = blk ? tc.rollBlk : tc.rollBg;
      ctx.fillRect(0, y, kbW, rh - 0.5);
      // Grid cell background.
      ctx.fillStyle = blk ? tc.rollBlk : tc.rollBg;
      ctx.fillRect(kbW, y, gW, rh - 0.5);
      // C label.
      if (deg === 0) {
        ctx.fillStyle = tc.faint;
        ctx.font = '8px monospace';
        ctx.fillText('C' + (Math.floor(mm / 12) - 1), 3, y + rh - 2);
      }
    }

    // Bar gridlines.
    for (let bar = 0; bar <= 4; bar++) {
      const x = kbW + (bar * spb) / totalSteps * gW;
      ctx.strokeStyle = tc.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
      ctx.stroke();
    }

    // Note blocks.
    const L = getTargetLane();
    const bars = L.pool[L.selection] || [];
    for (let bi = 0; bi < 4; bi++) {
      const barNotes = bars[bi] || [];
      for (const [st, noteName, dur] of barNotes) {
        const midi = noteToMidi(noteName);
        if (midi < ROLL_LO || midi > ROLL_HI) continue;
        const absStep = bi * spb + st;
        const x = kbW + absStep / totalSteps * gW;
        const w = Math.max(3, (dur || 2) / totalSteps * gW - 1);
        const y = (ROLL_HI - midi) * rh;
        ctx.fillStyle = tc.note;
        ctx.fillRect(x + 1, y + 1, w - 1, rh - 2);
      }
    }

    // Playhead.
    if (playheadAbsStep >= 0) {
      const px = kbW + playheadAbsStep / totalSteps * gW;
      ctx.strokeStyle = tc.playhead;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, H);
      ctx.stroke();
    }
  }

  function rollClick(e) {
    const cv = host.querySelector('#mroll');
    if (!cv) return;
    const rect = cv.getBoundingClientRect();
    const cx = (e.clientX - rect.left) / rect.width * cv.width;
    const cy = (e.clientY - rect.top) / rect.height * cv.height;
    if (cx < ROLL_KB) return;

    const spb = stepsPerBar(song.meter);
    const totalSteps = 4 * spb;
    const gW = cv.width - ROLL_KB;

    const absStep = Math.floor((cx - ROLL_KB) / gW * totalSteps);
    if (absStep < 0 || absStep >= totalSteps) return;

    const midi = ROLL_HI - Math.floor(cy / cv.height * ROLL_ROWS);
    if (midi < ROLL_LO || midi > ROLL_HI) return;

    const noteName = NMG[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);

    // Fork to custom if needed.
    const L = getTargetLane();
    if (L.selection !== 'custom') {
      const src = L.pool[L.selection] || [];
      L.pool.custom = src.map(b => b.map(n => n.slice()));
      eng.setLane(L.id, 'custom');
    }

    const bar = Math.floor(absStep / spb);
    const st = absStep % spb;
    const arr = L.pool.custom[bar] || (L.pool.custom[bar] = []);
    const i = arr.findIndex(x => x[0] === st);
    if (i >= 0 && arr[i][1] === noteName) {
      arr.splice(i, 1);                        // click same note → remove
    } else {
      if (i >= 0) arr.splice(i, 1);           // monophonic: remove any existing note at this step
      arr.push([st, noteName, 2]);
    }

    drawRoll(lastBar * spb + lastStepInBar);
  }

  // ---- scope oscilloscope ----

  function drawScope() {
    const cv = host.querySelector('#scope-canvas');
    if (!cv) return;
    const ctx = cv.getContext('2d');
    const W = cv.width, H = cv.height;
    ctx.clearRect(0, 0, W, H);
    const tc = themeColors();
    // Background.
    ctx.fillStyle = tc.rollBg;
    ctx.fillRect(0, 0, W, H);
    // Center line.
    ctx.shadowBlur = 0;
    ctx.strokeStyle = tc.grid;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, H / 2); ctx.lineTo(W, H / 2); ctx.stroke();

    const data = eng.getScope(scopeSource);
    // Bright glowing trace — resolved via themeColors() (not CSS vars, which canvas can't read).
    const GAIN = 1.6;                              // amplify so quiet signals still read
    ctx.lineWidth = 2.5;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.shadowColor = tc.scope;
    ctx.shadowBlur = 10;
    ctx.strokeStyle = tc.scope;
    ctx.beginPath();
    if (!data || data.length === 0) {
      // flat line when no audio yet
      ctx.moveTo(0, H / 2); ctx.lineTo(W, H / 2);
    } else {
      for (let i = 0; i < data.length; i++) {
        const x = (i / (data.length - 1)) * W;
        const v = Math.max(-1, Math.min(1, data[i] * GAIN));
        const y = (1 - (v + 1) / 2) * H;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
    }
    ctx.stroke();
    ctx.shadowBlur = 0;                            // reset so other draws don't glow
  }

  function startScopeLoop() {
    if (scopeRafId !== null) return;
    function loop() {
      drawScope();
      scopeRafId = requestAnimationFrame(loop);
    }
    scopeRafId = requestAnimationFrame(loop);
  }

  function stopScopeLoop() {
    if (scopeRafId !== null) { cancelAnimationFrame(scopeRafId); scopeRafId = null; }
  }

  // ---- bass note-row (read-only) ----

  function drawBassRoll(stepInBar) {
    const cv = host.querySelector('#broll');
    if (!cv) return;
    const ctx = cv.getContext('2d');
    const W = cv.width, H = cv.height;
    ctx.clearRect(0, 0, W, H);

    const spb = stepsPerBar(song.meter);
    const kbW = ROLL_KB;
    const gW = W - kbW;
    const rh = H / BASS_ROWS;

    const tc = themeColors();

    // Draw pitch rows.
    for (let mm = BASS_LO; mm <= BASS_HI; mm++) {
      const y = (BASS_HI - mm) * rh;
      const deg = ((mm % 12) + 12) % 12;
      const blk = BLACK_DEGREES.has(deg);
      ctx.fillStyle = blk ? tc.rollBlk : tc.rollBg;
      ctx.fillRect(0, y, kbW, rh - 0.5);
      ctx.fillStyle = blk ? tc.rollBlk : tc.rollBg;
      ctx.fillRect(kbW, y, gW, rh - 0.5);
      // Label E and B and octave roots (E = deg 4, B = deg 11, C = deg 0).
      if (deg === 0) {
        ctx.fillStyle = tc.faint;
        ctx.font = '8px monospace';
        ctx.fillText('C' + (Math.floor(mm / 12) - 1), 3, y + rh - 2);
      } else if (deg === 4) {
        ctx.fillStyle = tc.faint;
        ctx.font = '8px monospace';
        ctx.fillText('E' + (Math.floor(mm / 12) - 1), 3, y + rh - 2);
      }
    }

    // Beat gridlines.
    for (let s = 0; s <= spb; s++) {
      const x = kbW + (s / spb) * gW;
      ctx.strokeStyle = tc.grid;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    }

    // Resolve bass notes for current bar.
    const L = getTargetLane();
    const gen = L.pool[L.selection];
    let notes = [];
    if (typeof gen === 'function') {
      const chord = chordAt(song.harmony.progression, lastBar);
      try { notes = gen(lastBar, chord) || []; } catch (_) { notes = []; }
    }

    // Draw note blocks.
    ctx.fillStyle = tc.note;
    for (const [st, noteName, dur] of notes) {
      const midi = noteToMidi(noteName);
      if (midi < BASS_LO || midi > BASS_HI) continue;
      const x = kbW + (st / spb) * gW;
      const w = Math.max(3, ((dur || 2) / spb) * gW - 1);
      const y = (BASS_HI - midi) * rh;
      ctx.fillRect(x + 1, y + 1, w - 1, rh - 2);
    }

    // Playhead.
    const px = kbW + (stepInBar / spb) * gW;
    ctx.strokeStyle = tc.playhead;
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, H); ctx.stroke();
  }

  function build() {
    const spb = stepsPerBar(song.meter);
    const beats = new Set(beatStarts(song.meter));
    // Compute beat index for each step (which beat group it belongs to).
    // Used for alternating bar shading: odd beat-groups get `.bar-alt` tint
    // so the 4/4 | 3/4 | 6/8 structure reads clearly.
    const beatsArr = beatStarts(song.meter);
    function beatIndexOf(step) {
      let idx = 0;
      for (let b = 0; b < beatsArr.length; b++) {
        if (step >= beatsArr[b]) idx = b;
      }
      return idx;
    }
    const cells = n => Array.from({length:n}, (_,i) => {
      const beatIdx = beatIndexOf(i);
      const altClass = beatIdx % 2 === 1 ? ' bar-alt' : '';
      const beatClass = beats.has(i) ? ' beat' : '';
      const downbeatClass = i === 0 ? ' downbeat' : '';
      return `<div class="vc${beatClass}${downbeatClass}${altClass}"></div>`;
    }).join('');
    if (view === 'drums') {
      const barSel = buildBarSelector();
      host.innerHTML = barSel
        + buildBeatHeader(spb)
        + DROWS.map(([k,l]) => `<div class="vrow" data-k="${k}"><span class="vl"><span class="vl-lbl">${l}</span></span>${cells(spb)}<span class="vr"><button class="dvm" data-voice="${k}" title="mute ${l}">M</button><button class="dvs" data-voice="${k}" title="solo ${l}">S</button></span></div>`).join('');

      // Bar selector click handlers.
      host.querySelectorAll('.bsel').forEach(b => b.onclick = () => {
        const n = +b.dataset.b;
        if (editBars.has(n)) { if (editBars.size > 1) editBars.delete(n); }
        else editBars.add(n);
        build();
        paint(lastBar, lastStepInBar);
      });

      // Cycle length click handlers.
      host.querySelectorAll('.cyc').forEach(b => b.onclick = () => {
        customLen = +b.dataset.c;
        [...editBars].forEach(x => { if (x >= customLen) editBars.delete(x); });
        if (!editBars.size) editBars.add(0);
        // Update song lane cycleLen if we're in custom mode.
        const _DL = getTargetLane();
        if (_DL.selection === 'custom') _DL.cycleLen = customLen;
        build();
        paint(lastBar, lastStepInBar);
      });

      // Drum cell click handlers.
      host.querySelectorAll('.vrow').forEach(row => {
        const k = row.dataset.k;
        [...row.querySelectorAll('.vc')].forEach((c, i) => c.onclick = () => drumEdit(k, i));
      });

      // Per-voice mute/solo click handlers.
      host.querySelectorAll('.dvm').forEach(btn => {
        btn.onclick = e => { e.stopPropagation(); eng.toggleDrumMute(btn.dataset.voice); paint(lastBar, lastStepInBar); };
      });
      host.querySelectorAll('.dvs').forEach(btn => {
        btn.onclick = e => { e.stopPropagation(); eng.toggleDrumSolo(btn.dataset.voice); paint(lastBar, lastStepInBar); };
      });
    } else if (view === 'melody') {
      // Melody view: canvas piano-roll.
      host.innerHTML = '<canvas id="mroll"></canvas>';
      const cv = host.querySelector('#mroll');
      cv.width = host.clientWidth || 680;
      cv.height = 170;
      cv.onclick = rollClick;
      drawRoll(-1);
    } else if (view === 'scope') {
      // Build source list: master + each lane (id as value, name as label).
      const laneSources = eng.getLanes().map(l => ({ value: l.id, label: l.name }));
      const SOURCES = [{ value: 'master', label: 'master' }, ...laneSources];
      const opts = SOURCES.map(s =>
        `<option value="${s.value}"${s.value === scopeSource ? ' selected' : ''}>${s.label}</option>`
      ).join('');
      host.innerHTML = `<div class="scope-bar"><label>source <select id="scope-src">${opts}</select></label></div>`
        + `<canvas id="scope-canvas"></canvas>`;
      const cv = host.querySelector('#scope-canvas');
      cv.width = host.clientWidth || 680;
      cv.height = 140;
      host.querySelector('#scope-src').onchange = e => { scopeSource = e.target.value; };
      startScopeLoop();
    } else if (view === 'bass') {
      host.innerHTML = '<canvas id="broll"></canvas>';
      const cv = host.querySelector('#broll');
      cv.width = host.clientWidth || 680;
      cv.height = 160;
      drawBassRoll(lastStepInBar);
    }
  }

  function paint(bar, stepInBar) {
    lastBar = bar;
    lastStepInBar = stepInBar;

    if (view === 'drums') {
      const L = getTargetLane();
      const isCustom = L.selection === 'custom';
      const pb = primaryBar();

      // Which bar to show: the primary edit bar.
      const pat = isCustom
        ? resolveDrumPattern(L.pool.custom, pb, customLen)
        : resolveDrumPattern(L.pool[L.selection], pb, L.cycleLen);
      const base = (isCustom && L.pool._base) ? L.pool._base[pb] : null;

      // The playing bar (for "now" highlight): show playhead only when it's on the shown bar.
      const cyc = isCustom ? customLen : (Array.isArray(L.pool[L.selection]) ? L.pool[L.selection].length : 1);
      const playingBar = ((bar % cyc) + cyc) % cyc;
      const headVisible = (playingBar === pb);

      const laneOK = laneAudible(eng.getLanes(), getTargetLane());   // whole-lane mute/solo
      host.querySelectorAll('.vrow').forEach(row => {
        const k = row.dataset.k;
        const audible = laneOK && drumVoiceAudible(getTargetLane(), k);
        row.classList.toggle('silenced', !audible);
        const mBtn = row.querySelector('.dvm');
        const sBtn = row.querySelector('.dvs');
        if (mBtn) mBtn.classList.toggle('muted', !!(L.voiceMute || {})[k]);
        if (sBtn) sBtn.classList.toggle('soloed', !!(L.voiceSolo || {})[k]);
        row.querySelectorAll('.vc').forEach((c, i) => {
          const on  = hasDrumHit(pat, k, i);
          const was = base ? hasDrumHit(base, k, i) : on;
          c.classList.toggle('hit',     on && was);
          c.classList.toggle('added',   on && !was);
          c.classList.toggle('removed', !on && was);
          c.classList.toggle('now', headVisible && i === stepInBar);
        });
      });

      // Update bar selector playing highlight.
      host.querySelectorAll('.bsel').forEach(b => {
        b.classList.toggle('playing', isCustom && +b.dataset.b === playingBar);
      });
    } else if (view === 'melody') {
      // Melody view: redraw the piano-roll canvas with current playhead.
      const spb = stepsPerBar(song.meter);
      drawRoll(bar * spb + stepInBar);
    } else if (view === 'bass') {
      drawBassRoll(stepInBar);
    }
    // Scope view is driven by its own rAF loop — no paint needed here.
  }

  build();
  return {
    setView(v) {
      if (v !== 'scope') stopScopeLoop();
      view = v;
      build();
    },
    // Focus a specific lane by id and open its type-appropriate editor.
    editLane(id) {
      const lanes = eng.getLanes();
      const lane = lanes.find(l => l.id === id);
      if (!lane) return;
      _targetLane = lane;
      // Reset bar selector state so the new lane starts clean.
      editBars = new Set([0]);
      customLen = lane.cycleLen || 4;
      const typeToView = { drums: 'drums', melody: 'melody', bass: 'bass' };
      const nextView = typeToView[lane.type] || 'drums';
      stopScopeLoop();
      view = nextView;
      build();
    },
    setStep(_abs, bar, stepInBar) { paint(bar, stepInBar); },
    invalidateThemeColors() {
      invalidateThemeColors();
      // Rebuild the current view so canvas draws pick up new colours immediately.
      if (view !== 'scope') stopScopeLoop();
      build();
    },
  };
}
