import { stepsPerBar, beatStarts } from '../engine/meter.js';
import { drumVoiceAudible, laneAudible, snapMidi, inScale, scalePitchClasses } from '../engine/song.js';
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
    rollOut: g('--roll-bg-out'),
    ctone:   g('--roll-ctone'),
    ink:     g('--ink'),
    dim:     g('--dim'),
    faint:   g('--faint'),
  };
  return _tc;
}
export function invalidateThemeColors() { _tc = null; }

const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

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

// Bass note range: two octaves roughly centred on bass register.
const BASS_LO = 28;   // E1
const BASS_HI = 51;   // Eb3  (covers typical bass lines well)
const BASS_ROWS = BASS_HI - BASS_LO + 1;

export function makeViz(host, song, eng) {
  let view = 'drums';
  let lastStepInBar = 0;
  let lastTarget = null;            // last onStep target payload (playback position)
  // Drum editor: which bars of the pattern the next cell-edit applies to.
  // The grid SHOWS the primary (lowest-index) selected bar; a cell click computes
  // on/off from that bar then SETs it across every selected bar.
  let editBars = new Set([0]);
  function primaryBar() { return Math.min(...editBars); }
  // Scope state
  let scopeSource = 'master';
  let scopeRafId = null;
  // Per-step playhead cache — populated by build(); cleared on rebuild.
  // drums: { [voiceKey]: HTMLElement[] }  (one shown bar; cell index = step within bar)
  // blocks: HTMLElement[][] indexed by absStep across all rendered bars
  let _drumVcCache = {};       // { kick: [c0, c1, ...], snare: [...], ... }
  let _blocksColCache = [];    // [absStep] → [cell0 (midi=hi), cell1, ... ]
  let _lastDrumNowStep = null; // last step index with .now for drum grid, or null
  let _lastBlocksAbsStep = -1; // last absStep with .now for blocks grid

  // The groove the EDIT pattern picks for lane L → { name, bars }. May be null
  // (lane with no groove); callers fall back to a single empty bar.
  function editGroove(L) { return eng.getEditGroove(L.id); }
  // Editable bar count for lane L = the groove's own length (≥1).
  function grooveLen(L) {
    const G = editGroove(L);
    return G && G.bars.length ? G.bars.length : 1;
  }
  // Per-bar data array for lane L (the groove's bars), padded to a single empty
  // bar when the groove is missing so the editor renders gracefully.
  function laneBars(L) {
    const G = editGroove(L);
    if (G && G.bars.length) return G.bars;
    return [L.type === 'drums' ? {} : []];
  }
  // The sounding bar mapped into the editor's groove (which cycles), or -1 when
  // another pattern is sounding. The editor shows the groove, so the pattern-
  // relative sounding bar wraps by the groove's length.
  function soundingGrooveBar(L) {
    if (!lastTarget || lastTarget.patternIdx !== eng.getEditPatternIndex()) return -1;
    return lastTarget.barInPattern % grooveLen(L);
  }
  // Playhead abs-step inside the editor (groove-relative), or -1 when another
  // pattern is sounding.
  function editPlayheadAbsStep(spb, L) {
    const sb = soundingGrooveBar(L);
    return sb < 0 ? -1 : sb * spb + lastStepInBar;
  }

  // Piano ⇄ Blocks toggle state (persisted across reloads).
  let rollMode = (() => {
    try { return localStorage.getItem('gb-rollmode') || 'piano'; } catch (_) { return 'piano'; }
  })();

  // Snap-to-scale state (melody only; persisted; default ON).
  let snapOn = (() => {
    try { return localStorage.getItem('gb-snap') !== '0'; } catch (_) { return true; }
  })();

  // Current edit target lane (set by editLane(id)).
  // Falls back to laneByType for the initial state.
  let _targetLane = null;
  function getTargetLane() {
    // Prefer the explicitly-set target; fall back gracefully.
    if (_targetLane) return _targetLane;
    return laneByType(song.lanes, view === 'bass' ? 'bass' : view === 'melody' ? 'melody' : 'drums');
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
    const L = getTargetLane();
    const BARS = grooveLen(L);
    const totalSteps = BARS * spb;
    const kbW = ROLL_KB, gW = W - kbW;
    const rh = H / ROLL_ROWS;

    const tc = themeColors();

    // Key-aware tinting: dim out-of-scale rows; glow each bar's chord tones.
    // No key → no tint (the keyboard reads neutral, like before).
    const key = eng.getKey();
    const scalePcs = key ? scalePitchClasses(key) : null;
    // Chord tones come from the EDIT pattern's own chords (cycling per bar).
    const chords = eng.getPatternChords(eng.getEditPatternIndex()) ?? [];

    // Draw pitch rows (keyboard column + grid background).
    for (let mm = ROLL_LO; mm <= ROLL_HI; mm++) {
      const y = (ROLL_HI - mm) * rh;
      const deg = ((mm % 12) + 12) % 12;
      const blk = BLACK_DEGREES.has(deg);
      // Out-of-scale rows wash dimmer; in-scale rows keep the normal bg.
      const oos = scalePcs && !scalePcs.has(deg);
      const bg = oos ? tc.rollOut : (blk ? tc.rollBlk : tc.rollBg);
      // Keyboard column.
      ctx.fillStyle = bg;
      ctx.fillRect(0, y, kbW, rh - 0.5);
      // Grid cell background.
      ctx.fillStyle = bg;
      ctx.fillRect(kbW, y, gW, rh - 0.5);
      // C label.
      if (deg === 0) {
        ctx.fillStyle = tc.faint;
        ctx.font = '8px monospace';
        ctx.fillText('C' + (Math.floor(mm / 12) - 1), 3, y + rh - 2);
      }
    }

    // Chord-tone glow: for each editor bar, brighten rows whose pitch-class is in
    // that bar's chord, within the bar's x-range. The chord for editor bar b is
    // the pattern's chords[b % len] — well-defined now that chords live on the
    // pattern alongside the groove.
    if (chords.length) {
      for (let b = 0; b < BARS; b++) {
        const chord = chords[b % chords.length];
        if (!chord) continue;
        const toneNotes = (chord.voicing || []).concat(chord.root ? [chord.root] : []);
        const tonePcs = new Set(toneNotes.map(n => ((noteToMidi(n) % 12) + 12) % 12));
        if (!tonePcs.size) continue;
        const x0 = kbW + (b * spb) / totalSteps * gW;
        const x1 = kbW + ((b + 1) * spb) / totalSteps * gW;
        ctx.fillStyle = tc.ctone;
        for (let mm = ROLL_LO; mm <= ROLL_HI; mm++) {
          if (!tonePcs.has(((mm % 12) + 12) % 12)) continue;
          const y = (ROLL_HI - mm) * rh;
          ctx.fillRect(x0, y, x1 - x0, rh - 0.5);
        }
      }
    }

    // Bar gridlines.
    for (let bar = 0; bar <= BARS; bar++) {
      const x = kbW + (bar * spb) / totalSteps * gW;
      ctx.strokeStyle = tc.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
      ctx.stroke();
    }

    // Note blocks.
    const bars = laneBars(L);
    for (let bi = 0; bi < bars.length; bi++) {
      const barNotes = bars[bi] || [];
      for (const [st, noteName, dur] of barNotes) {
        if (Array.isArray(noteName)) continue;   // chord lanes not shown in roll
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
    const L = getTargetLane();
    const totalSteps = grooveLen(L) * spb;
    const gW = cv.width - ROLL_KB;

    const absStep = Math.floor((cx - ROLL_KB) / gW * totalSteps);
    if (absStep < 0 || absStep >= totalSteps) return;

    let midi = ROLL_HI - Math.floor(cy / cv.height * ROLL_ROWS);
    if (midi < ROLL_LO || midi > ROLL_HI) return;

    // Snap to the song's key (melody only; on by default, persisted).
    const key = eng.getKey();
    if (snapOn && key) midi = snapMidi(midi, key);

    const noteName = NMG[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);

    const bar = Math.floor(absStep / spb);   // groove-relative
    const st = absStep % spb;
    eng.toggleNote(L.id, bar, st, noteName, 2);

    drawRoll(editPlayheadAbsStep(spb, L));
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
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
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
    // Two-pass glow instead of ctx.shadowBlur: a 60fps per-pixel gaussian on a
    // 1024-point stroke was saturating the main thread and starving Tone's
    // scheduler (events fired >1s late). A wide translucent pass under a bright
    // core reads as a glow at a tiny fraction of the cost. Path reused — no rebuild.
    ctx.globalAlpha = 0.22;
    ctx.lineWidth = 7;
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.lineWidth = 2.5;
    ctx.stroke();
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

    // Key-aware tinting (read-only bass): dim out-of-scale rows. No key → neutral.
    const key = eng.getKey();
    const scalePcs = key ? scalePitchClasses(key) : null;

    // Draw pitch rows.
    for (let mm = BASS_LO; mm <= BASS_HI; mm++) {
      const y = (BASS_HI - mm) * rh;
      const deg = ((mm % 12) + 12) % 12;
      const blk = BLACK_DEGREES.has(deg);
      const oos = scalePcs && !scalePcs.has(deg);
      const bg = oos ? tc.rollOut : (blk ? tc.rollBlk : tc.rollBg);
      ctx.fillStyle = bg;
      ctx.fillRect(0, y, kbW, rh - 0.5);
      ctx.fillStyle = bg;
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

    // Bass notes for the shown bar (explicit data; read-only).
    const L = getTargetLane();
    const bars = laneBars(L);
    const soundingBar = soundingGrooveBar(L);   // groove-relative, or -1
    const editing = soundingBar >= 0;
    const showBar = editing ? soundingBar : 0;
    const notes = bars[showBar] || [];

    // Chord-tone glow for the shown bar — the edit pattern's chords[bar % len].
    const chords = eng.getPatternChords(eng.getEditPatternIndex()) ?? [];
    const chord = chords.length ? chords[showBar % chords.length] : null;
    if (chord) {
      const toneNotes = (chord.voicing || []).concat(chord.root ? [chord.root] : []);
      const tonePcs = new Set(toneNotes.map(n => ((noteToMidi(n) % 12) + 12) % 12));
      ctx.fillStyle = tc.ctone;
      for (let mm = BASS_LO; mm <= BASS_HI; mm++) {
        if (!tonePcs.has(((mm % 12) + 12) % 12)) continue;
        const y = (BASS_HI - mm) * rh;
        ctx.fillRect(kbW, y, gW, rh - 0.5);
      }
    }

    // Draw note blocks.
    ctx.fillStyle = tc.note;
    for (const [st, noteName, dur] of notes) {
      if (Array.isArray(noteName)) continue;
      const midi = noteToMidi(noteName);
      if (midi < BASS_LO || midi > BASS_HI) continue;
      const x = kbW + (st / spb) * gW;
      const w = Math.max(3, ((dur || 2) / spb) * gW - 1);
      const y = (BASS_HI - midi) * rh;
      ctx.fillRect(x + 1, y + 1, w - 1, rh - 2);
    }

    // Playhead — only when the sounding pattern is the edited one.
    if (editing) {
      const px = kbW + (stepInBar / spb) * gW;
      ctx.strokeStyle = tc.playhead;
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, H); ctx.stroke();
    }
  }

  // "editing: <groove name>" label — names the groove the editor mutates and
  // warns that shared grooves change everywhere. Empty when the lane has none.
  function edLabelHTML(L) {
    const G = editGroove(L);
    if (!G) return '';
    return `<div class="ed-lbl">editing: ${esc(G.name)}</div>`;
  }

  // ─── Roll-mode toggle bar (melody + bass only) ───────────────────────────
  // Returns an HTML string for the segmented Piano/Blocks toggle.
  // `barCtrlLane` (optional): when given an editable lane, append the groove-
  // length selector into the toggle bar (melody only; bass is read-only).
  function rollModeToggleHTML(barCtrlLane = null, showSnap = false) {
    const pa = rollMode === 'piano'  ? ' rm-on' : '';
    const ba = rollMode === 'blocks' ? ' rm-on' : '';
    // Snap toggle shown for melody only, and only when the song has a key.
    const snapBtn = (showSnap && eng.getKey())
      ? `<button class="snap-btn${snapOn ? ' on' : ''}" data-snap title="Snap edits to the song's key">⊞ snap</button>`
      : '';
    return `<div class="roll-mode-bar">`
      + `<span class="roll-mode-lbl">VIEW</span>`
      + `<button class="roll-mode-btn${pa}" data-rm="piano">Piano</button>`
      + `<button class="roll-mode-btn${ba}" data-rm="blocks">Blocks</button>`
      + (barCtrlLane ? barCountControlsHTML(barCtrlLane) : '')
      + snapBtn
      + `</div>`;
  }

  // Groove-length selector for the lane's groove. Groove lengths are powers of
  // two — pick one directly (1/2/4/8 bars), like a hardware sequencer. The
  // current length is marked `on`. Reuses the .bsel look via .glen-btn.
  function barCountControlsHTML(L) {
    const len = grooveLen(L);
    const btns = [1, 2, 4, 8]
      .map(n => `<button class="glen-btn${n === len ? ' on' : ''}" data-glen="${n}">${n}</button>`)
      .join('');
    return `<span class="glen"><span class="glen-lbl">bars</span>${btns}</span>`;
  }
  // Wire the length selector inside host after build() injects it. Full rebuild
  // on change so the stepper count + clamped editBars repaint correctly.
  function wireBarCountControls(L) {
    host.querySelectorAll('.glen-btn').forEach(btn => {
      btn.onclick = () => {
        if (eng.setGrooveBars(L.id, +btn.dataset.glen) !== null) {
          build();
          paint(lastStepInBar);
        }
      };
    });
  }

  // Wire the toggle buttons inside host after build() injects them.
  function wireRollModeToggle() {
    host.querySelectorAll('.roll-mode-btn').forEach(btn => {
      btn.onclick = () => {
        rollMode = btn.dataset.rm;
        try { localStorage.setItem('gb-rollmode', rollMode); } catch (_) {}
        build();
        paint(lastStepInBar);
      };
    });
    const snapBtn = host.querySelector('.snap-btn');
    if (snapBtn) snapBtn.onclick = () => {
      snapOn = !snapOn;
      try { localStorage.setItem('gb-snap', snapOn ? '1' : '0'); } catch (_) {}
      snapBtn.classList.toggle('on', snapOn);
    };
  }

  // ─── Blocks grid (pitch × step DOM grid) ─────────────────────────────────
  // Shared by melody (editable) and bass (read-only).

  // Pitch range + label helpers.
  function blocksRange(laneView) {
    return laneView === 'bass'
      ? { lo: BASS_LO, hi: BASS_HI, rows: BASS_ROWS }
      : { lo: ROLL_LO, hi: ROLL_HI, rows: ROLL_ROWS };
  }

  // Return the label for a midi pitch row (e.g. "C4"), or '' if none.
  function pitchLabel(midi) {
    const deg = ((midi % 12) + 12) % 12;
    if (deg === 0) return 'C' + (Math.floor(midi / 12) - 1);
    return '';
  }

  // Build the full DOM for a blocks grid and inject into host.
  // `laneView` is 'melody' or 'bass'.
  function buildBlocksGrid(laneView) {
    const { lo, hi } = blocksRange(laneView);
    const spb = stepsPerBar(song.meter);
    const L = getTargetLane();
    const BARS = grooveLen(L);
    const totalSteps = BARS * spb;
    const beats = beatStarts(song.meter);
    const beatSet = new Set(beats);
    const beatsArr = beats;
    function beatIndexOf(step) {
      let idx = 0;
      for (let b = 0; b < beatsArr.length; b++) {
        if (step >= beatsArr[b]) idx = b;
      }
      return idx;
    }

    // Header row: label spacer + one hcell per absolute step.
    let headerRow = '<div class="bg-row bg-head-row"><div class="bg-lbl"></div>';
    for (let absStep = 0; absStep < totalSteps; absStep++) {
      const stepInBar = absStep % spb;
      const beatClass = beatSet.has(stepInBar) ? ' beat' : '';
      const downClass = stepInBar === 0 ? ' downbeat' : '';
      // Show bar number at bar boundary.
      const barLabel = (stepInBar === 0) ? (Math.floor(absStep / spb) + 1) : '';
      headerRow += `<div class="bg-hcell${beatClass}${downClass}">${barLabel}</div>`;
    }
    headerRow += '</div>';

    let html = rollModeToggleHTML(laneView === 'melody' ? L : null, laneView === 'melody');
    html += edLabelHTML(L);
    html += `<div class="bg-scroll"><div class="bg-grid" data-lv="${laneView}">`;
    html += headerRow;

    // Key-aware tinting data: out-of-scale rows (.oos) + per-bar chord tones
    // (.ctone). No key → no tint. Chord per editor bar = the edit pattern's
    // chords[b % len].
    const key = eng.getKey();
    const scalePcs = key ? scalePitchClasses(key) : null;
    const chords = eng.getPatternChords(eng.getEditPatternIndex()) ?? [];
    const barTonePcs = [];   // [barIdx] → Set(pitchClass) | null
    for (let b = 0; b < BARS; b++) {
      const chord = chords.length ? chords[b % chords.length] : null;
      if (!chord) { barTonePcs[b] = null; continue; }
      const toneNotes = (chord.voicing || []).concat(chord.root ? [chord.root] : []);
      barTonePcs[b] = new Set(toneNotes.map(n => ((noteToMidi(n) % 12) + 12) % 12));
    }

    // One row per pitch, top = highest.
    for (let midi = hi; midi >= lo; midi--) {
      const deg = ((midi % 12) + 12) % 12;
      const blk = BLACK_DEGREES.has(deg);
      const lbl = pitchLabel(midi);
      const oos = scalePcs && !scalePcs.has(deg);
      const rowClass = (blk ? ' bg-blk' : '') + (oos ? ' oos' : '');
      let cells = `<div class="bg-lbl${rowClass}">${lbl}</div>`;
      for (let absStep = 0; absStep < totalSteps; absStep++) {
        const stepInBar = absStep % spb;
        const beatIdx  = beatIndexOf(stepInBar);
        const beatClass = beatSet.has(stepInBar) ? ' beat' : '';
        const altClass  = beatIdx % 2 === 1 ? ' bar-alt' : '';
        const downClass = stepInBar === 0 ? ' downbeat' : '';
        const barIdx = Math.floor(absStep / spb);
        const ctoneClass = barTonePcs[barIdx]?.has(deg) ? ' ctone' : '';
        cells += `<div class="vc${beatClass}${downClass}${altClass}${ctoneClass}" data-midi="${midi}" data-step="${absStep}"></div>`;
      }
      html += `<div class="bg-row${rowClass}">${cells}</div>`;
    }
    html += '</div></div>';
    host.innerHTML = html;
    wireRollModeToggle();
    if (laneView === 'melody') wireBarCountControls(L);
    // Cache .vc cells per absStep column for surgical per-step playhead toggle.
    _blocksColCache = [];
    host.querySelectorAll('.bg-grid .vc').forEach(cell => {
      const s = +cell.dataset.step;
      if (!_blocksColCache[s]) _blocksColCache[s] = [];
      _blocksColCache[s].push(cell);
    });
    paintBlocksGrid(laneView);

    if (laneView === 'melody') {
      // Wire clicks for melody editing.
      host.querySelectorAll('.bg-grid .vc').forEach(cell => {
        cell.onclick = () => {
          const midi = +cell.dataset.midi;
          const absStep = +cell.dataset.step;
          blocksEdit(midi, absStep);
        };
      });
    }
    // Bass: no clicks (read-only).
  }

  // Repaint the blocks grid cells to reflect current note data + playhead.
  function paintBlocksGrid(laneView) {
    const grid = host.querySelector('.bg-grid');
    if (!grid) return;
    const spb = stepsPerBar(song.meter);
    const L = getTargetLane();
    const BARS = grooveLen(L);
    // Playhead abs-step, hidden (-1) when another pattern is sounding.
    const playheadAbsStep = editPlayheadAbsStep(spb, L);

    // Build a Set of "midi:absStep" strings for O(1) lookup, from explicit data.
    const hitSet = new Set();
    const bars = laneBars(L);
    for (let bi = 0; bi < BARS; bi++) {
      const barNotes = bars[bi] || [];
      for (const [st, noteName] of barNotes) {
        if (Array.isArray(noteName)) continue;
        const midi = noteToMidi(noteName);
        hitSet.add(midi + ':' + (bi * spb + st));
      }
    }

    host.querySelectorAll('.bg-grid .vc').forEach(cell => {
      const midi = +cell.dataset.midi;
      const absStep = +cell.dataset.step;
      const isHit = hitSet.has(midi + ':' + absStep);
      const isNow = absStep === playheadAbsStep;
      cell.classList.toggle('hit', isHit);
      cell.classList.toggle('now', isNow);
    });
  }

  // Edit handler for melody blocks mode (mirrors rollClick semantics).
  function blocksEdit(midi, absStep) {
    const spb = stepsPerBar(song.meter);
    const bar = Math.floor(absStep / spb);
    const st = absStep % spb;

    if (midi < ROLL_LO || midi > ROLL_HI) return;

    // Snap to the song's key (melody only; on by default, persisted).
    const key = eng.getKey();
    if (snapOn && key) midi = snapMidi(midi, key);

    const noteName = NMG[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);

    const L = getTargetLane();
    eng.toggleNote(L.id, bar, st, noteName, 2);

    paintBlocksGrid('melody');
  }

  // Update the bar-stepper button classes: `on` for selected (edit) bars,
  // `playing` for the sounding bar — only when the sounding pattern is the
  // edited one. Cheap (≤4 buttons); reused by build/paint/setStep.
  function paintBarsel() {
    const sounding = soundingGrooveBar(getTargetLane());   // groove-relative, or -1
    host.querySelectorAll('.bsel[data-b]').forEach(btn => {
      const b = +btn.dataset.b;
      btn.classList.toggle('on', editBars.has(b));
      btn.classList.toggle('playing', b === sounding);
    });
  }

  function build() {
    // Clear per-step playhead caches — DOM is about to be rebuilt.
    _drumVcCache = {}; _lastDrumNowStep = null;
    _blocksColCache = []; _lastBlocksAbsStep = -1;
    // Drop edit selections beyond the groove's current length; never empty.
    const _bars = grooveLen(getTargetLane());
    for (const b of [...editBars]) if (b >= _bars) editBars.delete(b);
    if (editBars.size === 0) editBars.add(0);
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
      const L = getTargetLane();
      const BARS = grooveLen(L);
      let html = edLabelHTML(L);
      // Bar stepper — render whenever the lane has a groove (even 1 bar), since
      // it now also hosts the groove-length selector.
      if (editGroove(L)) {
        html += `<div class="barsel"><span class="barsel-lbl">bar</span>`;
        for (let b = 0; b < BARS; b++) html += `<button class="bsel" data-b="${b}">${b + 1}</button>`;
        html += barCountControlsHTML(L);
        html += `</div>`;
      }
      html += buildBeatHeader(spb);
      // ONE bar tall: 5 voice rows for the shown (primary) bar.
      html += DROWS.map(([k, l]) =>
        `<div class="vrow" data-k="${k}"><span class="vl"><span class="vl-lbl">${l}</span></span>${cells(spb)}` +
        `<span class="vr"><button class="dvm" data-voice="${k}" title="mute ${l}">M</button><button class="dvs" data-voice="${k}" title="solo ${l}">S</button></span>`
        + `</div>`).join('');
      host.innerHTML = html;

      // Stepper: toggle membership (never deselect the last one), then repaint.
      host.querySelectorAll('.bsel[data-b]').forEach(btn => {
        btn.onclick = () => {
          const b = +btn.dataset.b;
          if (editBars.has(b)) { if (editBars.size > 1) editBars.delete(b); }
          else editBars.add(b);
          paintBarsel();
          paint(lastStepInBar);   // primary bar may have changed → re-render hits
        };
      });
      wireBarCountControls(L);

      // Cell click: compute desired on/off from the SHOWN (primary) bar, then
      // SET that state across every selected bar.
      host.querySelectorAll('.vrow').forEach(row => {
        const k = row.dataset.k;
        [...row.querySelectorAll('.vc')].forEach((c, i) => c.onclick = () => {
          const shown = laneBars(L)[primaryBar()] || {};
          const on = k === 'tom'
            ? !(shown.tom && shown.tom.some(x => x[0] === i))
            : !(shown[k] && shown[k].includes(i));
          for (const b of editBars) eng.setDrumStep(L.id, k, b, i, on);
          paint(lastStepInBar);
        });
      });

      host.querySelectorAll('.dvm').forEach(btn => {
        btn.onclick = e => { e.stopPropagation(); eng.toggleDrumMute(btn.dataset.voice); paint(lastStepInBar); };
      });
      host.querySelectorAll('.dvs').forEach(btn => {
        btn.onclick = e => { e.stopPropagation(); eng.toggleDrumSolo(btn.dataset.voice); paint(lastStepInBar); };
      });

      // Cache: _drumVcCache[voice] = [cells] for the fast playhead path.
      _drumVcCache = {};
      _lastDrumNowStep = null;
      host.querySelectorAll('.vrow').forEach(row => {
        _drumVcCache[row.dataset.k] = [...row.querySelectorAll('.vc')];
      });
      paintBarsel();
      paint(lastStepInBar);   // canvas/blocks views draw inside build; drums needs its hits painted too
    } else if (view === 'melody') {
      if (rollMode === 'blocks') {
        buildBlocksGrid('melody');
      } else {
        // Melody view: canvas piano-roll.
        const mL = getTargetLane();
        host.innerHTML = rollModeToggleHTML(mL, true) + edLabelHTML(mL) + '<canvas id="mroll"></canvas>';
        wireRollModeToggle();
        wireBarCountControls(mL);
        const cv = host.querySelector('#mroll');
        cv.width = host.clientWidth || 680;
        cv.height = 170;
        cv.onclick = rollClick;
        drawRoll(-1);
      }
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
      if (rollMode === 'blocks') {
        buildBlocksGrid('bass');
      } else {
        host.innerHTML = rollModeToggleHTML() + edLabelHTML(getTargetLane()) + '<canvas id="broll"></canvas>';
        wireRollModeToggle();
        const cv = host.querySelector('#broll');
        cv.width = host.clientWidth || 680;
        cv.height = 160;
        drawBassRoll(lastStepInBar);
      }
    }
  }

  function paint(stepInBar) {
    lastStepInBar = stepInBar;

    if (view === 'drums') {
      const L = getTargetLane();
      const bars = laneBars(L);
      const pBar = primaryBar();
      const pat = bars[pBar] || {};
      // .now visible only when the sounding (groove-relative) bar === the shown
      // (primary) bar.
      const nowHere = soundingGrooveBar(L) === pBar;
      const laneOK = laneAudible(eng.getLanes(), L);
      host.querySelectorAll('.vrow').forEach(row => {
        const k = row.dataset.k;
        const audible = laneOK && drumVoiceAudible(L, k);
        row.classList.toggle('silenced', !audible);
        const mBtn = row.querySelector('.dvm');
        const sBtn = row.querySelector('.dvs');
        if (mBtn) mBtn.classList.toggle('muted', !!(L.voiceMute || {})[k]);
        if (sBtn) sBtn.classList.toggle('soloed', !!(L.voiceSolo || {})[k]);
        row.querySelectorAll('.vc').forEach((c, i) => {
          const on = k === 'tom'
            ? !!(pat.tom && pat.tom.some(x => x[0] === i))
            : !!(pat[k] && pat[k].includes(i));
          c.classList.toggle('hit', on);
          c.classList.toggle('now', nowHere && i === stepInBar);
        });
      });
      paintBarsel();
    } else if (view === 'melody') {
      if (rollMode === 'blocks') {
        paintBlocksGrid('melody');
      } else {
        // Melody view: redraw the piano-roll canvas with current playhead.
        const spb = stepsPerBar(song.meter);
        drawRoll(editPlayheadAbsStep(spb, getTargetLane()));
      }
    } else if (view === 'bass') {
      if (rollMode === 'blocks') {
        paintBlocksGrid('bass');
      } else {
        drawBassRoll(stepInBar);
      }
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
      editBars = new Set([0]);     // fresh lane/pattern → edit bar 1
      const typeToView = { drums: 'drums', melody: 'melody', bass: 'bass' };
      const nextView = typeToView[lane.type] || 'drums';
      stopScopeLoop();
      view = nextView;
      build();
    },
    setStep({ stepInBar, target }) {
      lastTarget = target;
      lastStepInBar = stepInBar;
      if (view === 'drums') {
        // Fast path: only move the .now highlight across the single shown bar.
        // Visible only when the SOUNDING (groove-relative) bar === the shown
        // (primary) bar.
        const visible = soundingGrooveBar(getTargetLane()) === primaryBar();
        const next = visible ? stepInBar : null;
        if (next !== _lastDrumNowStep) {
          if (_lastDrumNowStep !== null) {
            for (const cells of Object.values(_drumVcCache)) cells[_lastDrumNowStep]?.classList.remove('now');
          }
          if (next !== null) {
            for (const cells of Object.values(_drumVcCache)) cells[next]?.classList.add('now');
          }
          _lastDrumNowStep = next;
        }
        paintBarsel();   // cheap (≤4 buttons): refresh the ▸ sounding-bar indicator
      } else if (view === 'melody' || view === 'bass') {
        if (rollMode === 'blocks') {
          // Fast path: only flip the .now column in the blocks grid.
          // Hide the playhead when another pattern is sounding.
          const spb = stepsPerBar(song.meter);
          const newAbs = editPlayheadAbsStep(spb, getTargetLane());
          if (newAbs !== _lastBlocksAbsStep) {
            if (_lastBlocksAbsStep >= 0 && _blocksColCache[_lastBlocksAbsStep]) {
              for (const c of _blocksColCache[_lastBlocksAbsStep]) c.classList.remove('now');
            }
            if (newAbs >= 0 && _blocksColCache[newAbs]) {
              for (const c of _blocksColCache[newAbs]) c.classList.add('now');
            }
            _lastBlocksAbsStep = newAbs;
          }
        } else {
          // Canvas views: redraw playhead line only (cheap full canvas redraw).
          paint(stepInBar);
        }
      }
      // Scope view: rAF loop handles it — nothing to do here.
    },
    invalidateThemeColors() {
      invalidateThemeColors();
      // Rebuild the current view so canvas draws pick up new colours immediately.
      if (view !== 'scope') stopScopeLoop();
      build();
    },
    // Stop this viz's rAF loops. Called before mount() replaces `viz` on a song
    // switch — otherwise an old scope loop keeps spinning forever (one leaked
    // requestAnimationFrame per switch-while-scope-open).
    dispose() {
      stopScopeLoop();
    },
  };
}
