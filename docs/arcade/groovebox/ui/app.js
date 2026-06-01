import { createEngine } from '../engine/index.js';
import { laneAudible } from '../engine/song.js';
import { kids } from '../songs/kids.js';
import { risingSun } from '../songs/rising-sun.js';
import { blueDanube } from '../songs/blue-danube.js';
import { makeViz } from './viz.js';
import { makeKnob } from './knob.js';

const eng = createEngine();
const LANES = ['drums','bass','chords','melody'];
const chordModes = ['pad','arp','stab'];
const TONES = ['pulse','square','sawtooth','fatsawtooth','triangle','sine'];

const SONGS = { kids, 'rising-sun': risingSun, 'blue-danube': blueDanube };

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

function renderStrips() {
  const host = document.getElementById('strips');
  host.innerHTML = LANES.map(lane => {
    const opts = options(lane).map(n => `<option${n===song.lanes[lane].selection?' selected':''}>${n}</option>`).join('');
    const tone = lane === 'melody'
      ? `<select data-tone>${TONES.map(t=>`<option value="${t}"${t==='pulse'?' selected':''}>${t==='fatsawtooth'?'fat saw':t}</option>`).join('')}</select>`
      : '';
    return `<div class="lane" data-lane="${lane}"><span class="name">${lane}</span>
      <div class="mctl"><select data-lane="${lane}">${opts}</select>${tone}</div>
      <div class="msgroup">
        <div class="ctrl"><button class="mute" data-lane="${lane}" aria-label="mute ${lane}" title="mute">M</button><span class="ctrl-lbl">mute</span></div>
        <div class="ctrl"><button class="solo" data-lane="${lane}" aria-label="solo ${lane}" title="solo">S</button><span class="ctrl-lbl">solo</span></div>
      </div></div>`;
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
  // Append FX knobs to each lane row (before the msgroup)
  host.querySelectorAll('.lane').forEach(row => {
    const lane = row.dataset.lane;
    const knobs = document.createElement('div');
    knobs.className = 'knobs';
    knobs.appendChild(makeKnob({ label: 'vol',  value: 1.0, onChange: v => eng.setLaneFX(lane, 'vol',    v) }));
    knobs.appendChild(makeKnob({ label: 'pan',  value: 0.5, onChange: v => eng.setLaneFX(lane, 'pan',    v) }));
    knobs.appendChild(makeKnob({ label: 'cut',  value: 0.5, onChange: v => eng.setLaneFX(lane, 'cut',    v) }));
    knobs.appendChild(makeKnob({ label: 'drv',  value: 0,   onChange: v => eng.setLaneFX(lane, 'drive',  v) }));
    knobs.appendChild(makeKnob({ label: 'dly',  value: 0,   onChange: v => eng.setLaneFX(lane, 'delay',  v) }));
    knobs.appendChild(makeKnob({ label: 'cru',  value: 0,   onChange: v => eng.setLaneFX(lane, 'crush',  v) }));
    knobs.appendChild(makeKnob({ label: 'vrb',  value: 0,   onChange: v => eng.setLaneFX(lane, 'reverb', v) }));
    knobs.appendChild(makeKnob({ label: 'cmp',  value: 0,   onChange: v => eng.setLaneFX(lane, 'comp',   v) }));
    row.querySelector('.msgroup').before(knobs);
  });
  refreshStates();
}

// ─── Fills row ───────────────────────────────────────────────────────────────
let armedFill = null;
function renderFills() {
  const host = document.getElementById('fills');
  if (!host || !song.fills) return;
  host.innerHTML = '';
  const row = document.createElement('div');
  row.className = 'fillsrow';
  const lbl = document.createElement('span');
  lbl.className = 'flbl';
  lbl.textContent = 'FILLS';
  row.appendChild(lbl);
  for (const name of Object.keys(song.fills)) {
    const btn = document.createElement('button');
    btn.className = 'fillbtn';
    btn.textContent = name;
    btn.dataset.fill = name;
    btn.onclick = () => {
      armedFill = name;
      eng.triggerFill(name);
      host.querySelectorAll('.fillbtn').forEach(b => b.classList.toggle('armed', b === btn));
    };
    row.appendChild(btn);
  }
  host.appendChild(row);
}

// ─── Master FX ───────────────────────────────────────────────────────────────
function renderMaster() {
  const masterHost = document.getElementById('master');
  masterHost.innerHTML = '';
  const mwrap = document.createElement('div'); mwrap.className = 'masterfx';
  mwrap.innerHTML = '<span class="mlbl">MASTER</span>';
  const mk = document.createElement('div'); mk.className = 'knobs';
  mk.appendChild(makeKnob({ label:'verb', value:0, onChange: v => eng.setMasterFX('reverb', v) }));
  mk.appendChild(makeKnob({ label:'comp', value:0, onChange: v => eng.setMasterFX('comp', v) }));
  mwrap.appendChild(mk); masterHost.appendChild(mwrap);
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
  eng.setMasterFX('reverb', 0);
  eng.setMasterFX('comp', 0);
}

// ─── Mount: (re)build all per-song UI ────────────────────────────────────────
function mount() {
  song = eng.getSong();
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
  if (this.classList.contains('on')) { eng.stop(); this.classList.remove('on'); this.textContent='▶ play'; }
  else { await eng.play(); this.classList.add('on'); this.textContent='⏹ stop'; }
};
document.getElementById('bpm').oninput = e => { eng.setTempo(+e.target.value); document.getElementById('bpmv').textContent = e.target.value; };
document.getElementById('songsel').onchange = e => loadSong(e.target.value);

// ─── Tab buttons (registered once; reference module-level viz) ───────────────
document.querySelectorAll('[data-view]').forEach(b => b.onclick = () => {
  document.querySelectorAll('[data-view]').forEach(x => x.classList.toggle('on', x === b));
  viz.setView(b.dataset.view);
});

// ─── Step callback (registered once; closes over module-level song/viz) ──────
eng.onStep(({absStep, bar, stepInBar, fill, mode, songIndex}) => {
  viz.setStep(absStep, bar, stepInBar);
  const fillsHost = document.getElementById('fills');
  if (fillsHost) {
    fillsHost.querySelectorAll('.fillbtn').forEach(btn => {
      const isFiring = btn.dataset.fill === fill;
      btn.classList.toggle('firing', isFiring);
      if (isFiring) btn.classList.remove('armed');
    });
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

// ─── Initial load ─────────────────────────────────────────────────────────────
eng.load(kids);
const initialSong = eng.getSong();
document.getElementById('bpm').value = initialSong.bpm;
document.getElementById('bpmv').textContent = initialSong.bpm;
eng.setTempo(initialSong.bpm);
mount();
