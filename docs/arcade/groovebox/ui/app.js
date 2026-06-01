import { createEngine } from '../engine/index.js';
import { laneAudible } from '../engine/song.js';
import { kids } from '../songs/kids.js';
import { risingSun } from '../songs/rising-sun.js';
import { electricFeel } from '../songs/electric-feel.js';
import { heartbeats } from '../songs/heartbeats.js';
import { digitalLove } from '../songs/digital-love.js';
import { memoryReboot } from '../songs/memory-reboot.js';
import { makeViz } from './viz.js';
import { makeKnob } from './knob.js';

const eng = createEngine();
const LANES = ['drums','bass','chords','melody'];
const chordModes = ['pad','arp','stab'];
const TONES = ['pulse','square','sawtooth','fatsawtooth','triangle','sine'];

const SONGS = { kids, 'rising-sun': risingSun, 'electric-feel': electricFeel, heartbeats, 'digital-love': digitalLove, 'memory-reboot': memoryReboot };

// Module-level refs — reassigned by mount() on every song switch.
let song;
let viz;

function options(lane) {
  return lane === 'chords' ? chordModes : Object.keys(song.lanes[lane].pool);
}

function refreshStates() {
  const host = document.getElementById('strips');
  for (const lane of LANES) {
    const row = host.querySelector(`.lane[data-lane="${lane}"]`);
    if (!row) continue;
    row.querySelector(`.mute[data-lane="${lane}"]`).classList.toggle('muted', !!song.lanes[lane].muted);
    row.querySelector(`.solo[data-lane="${lane}"]`).classList.toggle('soloed', !!song.lanes[lane].soloed);
    row.classList.toggle('silenced', !laneAudible(song, lane));
  }
}

// ─── Per-lane level meter rAF loop ───────────────────────────────────────────
let _meterRafId = null;

function startMeterLoop() {
  if (_meterRafId !== null) return;   // already running — don't stack
  function tick() {
    const host = document.getElementById('strips');
    if (host) {
      for (const lane of LANES) {
        const fill = host.querySelector(`.lane[data-lane="${lane}"] .lvl-fill`);
        if (fill) fill.style.height = (eng.getLevel(lane) * 100) + '%';
      }
    }
    // Master L/R stereo meters
    const masterHost = document.getElementById('master');
    if (masterHost) {
      const [l, r] = eng.getMasterLevel();
      const fills = masterHost.querySelectorAll('.lvl-stereo .lvl-fill');
      if (fills[0]) fills[0].style.height = (l * 100) + '%';
      if (fills[1]) fills[1].style.height = (r * 100) + '%';
    }
    _meterRafId = requestAnimationFrame(tick);
  }
  _meterRafId = requestAnimationFrame(tick);
}

function stopMeterLoop() {
  if (_meterRafId !== null) { cancelAnimationFrame(_meterRafId); _meterRafId = null; }
  // Zero out fills when stopped
  const host = document.getElementById('strips');
  if (host) {
    for (const lane of LANES) {
      const fill = host.querySelector(`.lane[data-lane="${lane}"] .lvl-fill`);
      if (fill) fill.style.height = '0%';
    }
  }
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

function renderStrips() {
  const host = document.getElementById('strips');
  host.innerHTML = LANES.map(lane => {
    const opts = options(lane).map(n => `<option${n===song.lanes[lane].selection?' selected':''}>${n}</option>`).join('');
    const tone = lane === 'melody'
      ? `<select data-tone>${TONES.map(t=>`<option value="${t}"${t==='pulse'?' selected':''}>${t==='fatsawtooth'?'fat saw':t}</option>`).join('')}</select>`
      : '';
    // Grid columns: name | pattern-select | meter | MIX | TONE | FX | M/S
    return `<div class="lane" data-lane="${lane}">
      <span class="name">${lane}</span>
      <div class="mctl"><select data-lane="${lane}">${opts}</select>${tone}</div>
      <div class="lvl"><div class="lvl-fill"></div></div>
      <div class="msgroup">
        <button class="mute" data-lane="${lane}" aria-label="mute ${lane}" title="Mute">M</button>
        <button class="solo" data-lane="${lane}" aria-label="solo ${lane}" title="Solo">S</button>
      </div>
    </div>`;
  }).join('');
  host.querySelectorAll('select[data-lane]').forEach(s => s.onchange = e => eng.setLane(e.target.dataset.lane, e.target.value));
  host.querySelectorAll('select[data-tone]').forEach(s => s.onchange = e => eng.setTone(e.target.value));
  host.querySelectorAll('.mute').forEach(b => b.onclick = () => {
    eng.toggleMute(b.dataset.lane);
    refreshStates();
  });
  host.querySelectorAll('.solo').forEach(b => b.onclick = () => {
    eng.toggleSolo(b.dataset.lane);
    refreshStates();
  });
  // Build grouped knobs and insert before the M/S group
  host.querySelectorAll('.lane').forEach(row => {
    const lane = row.dataset.lane;
    const msgroup = row.querySelector('.msgroup');

    const mixGrp = makeKgroup('MIX', [
      { label: 'vol', value: 1.0, onChange: v => eng.setLaneFX(lane, 'vol',   v) },
      { label: 'pan', value: 0.5, onChange: v => eng.setLaneFX(lane, 'pan',   v) },
    ]);
    const toneGrp = makeKgroup('TONE', [
      { label: 'cut', value: 0.5, onChange: v => eng.setLaneFX(lane, 'cut',   v) },
      { label: 'drv', value: 0,   onChange: v => eng.setLaneFX(lane, 'drive', v) },
    ]);
    const fxGrp = makeKgroup('FX', [
      { label: 'dly', value: 0,   onChange: v => eng.setLaneFX(lane, 'delay',  v) },
      { label: 'cru', value: 0,   onChange: v => eng.setLaneFX(lane, 'crush',  v) },
      { label: 'vrb', value: 0,   onChange: v => eng.setLaneFX(lane, 'reverb', v) },
      { label: 'cmp', value: 0,   onChange: v => eng.setLaneFX(lane, 'comp',   v) },
    ]);

    msgroup.before(mixGrp, toneGrp, fxGrp);
  });
  refreshStates();
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
    { label: 'vol', value: 1.0, onChange: v => eng.setMasterFX('vol',   v) },
    { label: 'bal', value: 0.5, onChange: v => eng.setMasterFX('bal',   v) },
    { label: 'wid', value: 0.5, onChange: v => eng.setMasterFX('width', v) },
  ]);
  const toneGrp = makeKgroup('TONE', [
    { label: 'lo', value: 0.5, onChange: v => eng.setMasterFX('lo', v) },
    { label: 'hi', value: 0.5, onChange: v => eng.setMasterFX('hi', v) },
  ]);
  const fxGrp = makeKgroup('FX', [
    { label: 'vrb', value: 0, onChange: v => eng.setMasterFX('reverb', v) },
    { label: 'cmp', value: 0, onChange: v => eng.setMasterFX('comp',   v) },
  ]);
  mwrap.appendChild(mixGrp);
  mwrap.appendChild(toneGrp);
  mwrap.appendChild(fxGrp);

  masterHost.appendChild(mwrap);
}

// ─── Arrangement UI ──────────────────────────────────────────────────────────
// Section colors — cycle through a set for visual variety
const SECTION_COLORS = ['#54f0c8','#5aa9ff','#ffb054','#ff5b9e','#b98cff','#ffd24a','#7af0a0','#f08a54'];

function renderArrange() {
  const host = document.getElementById('arrange');
  if (!host) return;
  host.innerHTML = '';

  const currentMode = eng.getMode();

  // Header row
  const head = document.createElement('div');
  head.className = 'arrange-head';

  const lbl = document.createElement('span');
  lbl.className = 'albl';
  lbl.textContent = 'ARRANGEMENT';
  head.appendChild(lbl);

  const modeBtn = document.createElement('button');
  modeBtn.id = 'modeBtn';
  modeBtn.textContent = currentMode === 'song' ? 'Song' : 'Live';
  if (currentMode === 'song') modeBtn.classList.add('song');
  modeBtn.onclick = () => {
    const next = eng.getMode() === 'live' ? 'song' : 'live';
    eng.setMode(next);
    renderArrange();
  };
  head.appendChild(modeBtn);

  const captureBtn = document.createElement('button');
  captureBtn.textContent = '＋ capture scene';
  captureBtn.onclick = () => { eng.captureScene(); renderArrange(); };
  head.appendChild(captureBtn);

  const clearBtn = document.createElement('button');
  clearBtn.textContent = 'clear';
  clearBtn.onclick = () => { eng.clearArrangement(); renderArrange(); };
  head.appendChild(clearBtn);

  host.appendChild(head);

  // Timeline
  const timeline = document.createElement('div');
  timeline.className = 'timeline';
  const arrangement = eng.getSong().arrangement || [];
  arrangement.forEach((section, i) => {
    const cell = document.createElement('div');
    cell.className = 'tcell';
    cell.dataset.idx = i;
    const color = SECTION_COLORS[i % SECTION_COLORS.length];
    cell.style.background = color + '22';
    cell.style.borderColor = color + '66';
    const label = section.lanes && section.lanes.drums ? section.lanes.drums : String(i + 1);
    cell.innerHTML = `<span class="tcell-name">${label}</span>${section.fill ? '<span class="tcell-fill">+f</span>' : ''}`;
    timeline.appendChild(cell);
  });
  host.appendChild(timeline);
}

// ─── Reset FX to neutral (call before mount on song switch) ──────────────────
function resetFX() {
  for (const lane of LANES) {
    eng.setLaneFX(lane, 'cut',    0.5);
    eng.setLaneFX(lane, 'drive',  0);
    eng.setLaneFX(lane, 'delay',  0);
    eng.setLaneFX(lane, 'crush',  0);
    eng.setLaneFX(lane, 'vol',    1);
    eng.setLaneFX(lane, 'pan',    0.5);
    eng.setLaneFX(lane, 'reverb', 0);
    eng.setLaneFX(lane, 'comp',   0);
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
  renderArrange();
  viz = makeViz(document.getElementById('viz'), song, eng);
  // Reset tab buttons to Drums view.
  document.querySelectorAll('[data-view]').forEach(x => x.classList.toggle('on', x.dataset.view === 'drums'));
  viz.setView('drums');
}

// ─── Load a different song ────────────────────────────────────────────────────
function loadSong(key) {
  eng.stop();
  stopMeterLoop();
  const play = document.getElementById('play');
  play.classList.remove('on');
  play.textContent = '▶ play';
  eng.setMode('live');
  eng.load(SONGS[key]);
  const s = eng.getSong();
  const bpm = document.getElementById('bpm');
  bpm.value = s.bpm;
  document.getElementById('bpmv').textContent = s.bpm;
  eng.setTempo(s.bpm);
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
document.getElementById('songsel').onchange = e => loadSong(e.target.value);
document.getElementById('themesel').onchange = e => {
  const t = e.target.value;
  if (t === 'dark') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  localStorage.setItem('gb-theme', t);
  // Invalidate canvas colour cache + repaint active view with new colours.
  viz.invalidateThemeColors?.();
};

// ─── Tab buttons (registered once; reference module-level viz) ───────────────
document.querySelectorAll('[data-view]').forEach(b => b.onclick = () => {
  document.querySelectorAll('[data-view]').forEach(x => x.classList.toggle('on', x === b));
  viz.setView(b.dataset.view);
});

// ─── Step callback (registered once; closes over module-level song/viz) ──────
eng.onStep(({absStep, bar, stepInBar, fill, mode, songIndex, queue}) => {
  viz.setStep(absStep, bar, stepInBar);
  const fillsHost = document.getElementById('fills');
  if (fillsHost) {
    fillsHost.querySelectorAll('.fillbtn').forEach(btn => {
      btn.classList.toggle('firing', btn.dataset.fill === fill);
    });
    renderChain(queue);
  }
  // Timeline highlight
  const timeline = document.querySelector('.timeline');
  if (timeline) {
    timeline.querySelectorAll('.tcell').forEach(cell => cell.classList.remove('on'));
    if (mode === 'song' && songIndex >= 0) {
      const active = timeline.querySelector(`.tcell[data-idx="${songIndex}"]`);
      if (active) active.classList.add('on');
    }
  }
  // Sync lane selects in song mode
  if (mode === 'song') {
    const strips = document.getElementById('strips');
    if (strips) {
      LANES.forEach(lane => {
        const sel = strips.querySelector(`select[data-lane="${lane}"]`);
        if (sel && sel.value !== song.lanes[lane].selection) sel.value = song.lanes[lane].selection;
      });
    }
    refreshStates();
  }
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

// ─── Initial load ─────────────────────────────────────────────────────────────
eng.load(kids);
const initialSong = eng.getSong();
document.getElementById('bpm').value = initialSong.bpm;
document.getElementById('bpmv').textContent = initialSong.bpm;
eng.setTempo(initialSong.bpm);
mount();
