import { createEngine } from '../engine/index.js';
import { laneAudible } from '../engine/song.js';
import { kids } from '../songs/kids.js';
import { makeViz } from './viz.js';
import { makeKnob } from './knob.js';

const eng = createEngine(); eng.load(kids);
const song = eng.getSong();
const LANES = ['drums','bass','chords','melody'];
const chordModes = ['pad','arp','stab'];
const options = lane => lane === 'chords' ? chordModes : Object.keys(song.lanes[lane].pool);

const TONES = ['pulse','square','sawtooth','fatsawtooth','triangle','sine'];

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
    knobs.appendChild(makeKnob({ label: 'cut',  value: 0.5, onChange: v => eng.setLaneFX(lane, 'cut',   v) }));
    knobs.appendChild(makeKnob({ label: 'drv',  value: 0, onChange: v => eng.setLaneFX(lane, 'drive', v) }));
    knobs.appendChild(makeKnob({ label: 'dly',  value: 0, onChange: v => eng.setLaneFX(lane, 'delay', v) }));
    knobs.appendChild(makeKnob({ label: 'cru',  value: 0, onChange: v => eng.setLaneFX(lane, 'crush', v) }));
    row.querySelector('.msgroup').before(knobs);
  });
  refreshStates();
}

document.getElementById('play').onclick = async function() {
  if (this.classList.contains('on')) { eng.stop(); this.classList.remove('on'); this.textContent='▶ play'; }
  else { await eng.play(); this.classList.add('on'); this.textContent='⏹ stop'; }
};
document.getElementById('bpm').oninput = e => { eng.setTempo(+e.target.value); document.getElementById('bpmv').textContent = e.target.value; };
renderStrips();
const masterHost = document.getElementById('master');
const mwrap = document.createElement('div'); mwrap.className = 'masterfx';
mwrap.innerHTML = '<span class="mlbl">MASTER</span>';
const mk = document.createElement('div'); mk.className = 'knobs';
mk.appendChild(makeKnob({ label:'verb', value:0, onChange: v => eng.setMasterFX('reverb', v) }));
mk.appendChild(makeKnob({ label:'comp', value:0, onChange: v => eng.setMasterFX('comp', v) }));
mwrap.appendChild(mk); masterHost.appendChild(mwrap);
const viz = makeViz(document.getElementById('viz'), song, eng);
eng.onStep(({absStep, bar, stepInBar}) => viz.setStep(absStep, bar, stepInBar));
document.querySelectorAll('[data-view]').forEach(b => b.onclick = () => {
  document.querySelectorAll('[data-view]').forEach(x=>x.classList.toggle('on', x===b));
  viz.setView(b.dataset.view);
});
