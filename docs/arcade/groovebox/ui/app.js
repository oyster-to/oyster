import { createEngine } from '../engine/index.js';
import { kids } from '../songs/kids.js';
import { makeViz } from './viz.js';
import { makeKnob } from './knob.js';

const eng = createEngine(); eng.load(kids);
const song = eng.getSong();
const LANES = ['drums','bass','chords','melody'];
const chordModes = ['pad','arp','stab'];
const options = lane => lane === 'chords' ? chordModes : Object.keys(song.lanes[lane].pool);

const TONES = ['pulse','square','sawtooth','fatsawtooth','triangle','sine'];
function renderStrips() {
  const host = document.getElementById('strips');
  host.innerHTML = LANES.map(lane => {
    const opts = options(lane).map(n => `<option${n===song.lanes[lane].selection?' selected':''}>${n}</option>`).join('');
    const tone = lane === 'melody'
      ? `<select data-tone>${TONES.map(t=>`<option value="${t}"${t==='pulse'?' selected':''}>${t==='fatsawtooth'?'fat saw':t}</option>`).join('')}</select>`
      : '';
    return `<div class="lane" data-lane="${lane}"><span class="name">${lane}</span>
      <div class="mctl"><select data-lane="${lane}">${opts}</select>${tone}</div>
      <button class="mute" data-lane="${lane}">mute</button></div>`;
  }).join('');
  host.querySelectorAll('select[data-lane]').forEach(s => s.onchange = e => eng.setLane(e.target.dataset.lane, e.target.value));
  host.querySelectorAll('select[data-tone]').forEach(s => s.onchange = e => eng.setTone(e.target.value));
  host.querySelectorAll('.mute').forEach(b => b.onclick = () => {
    const m = eng.toggleMute(b.dataset.lane); b.classList.toggle('on', m); b.textContent = m ? 'muted' : 'mute';
  });
  // Append FX knobs to each lane row (before the mute button)
  host.querySelectorAll('.lane').forEach(row => {
    const lane = row.dataset.lane;
    const knobs = document.createElement('div');
    knobs.className = 'knobs';
    knobs.appendChild(makeKnob({ label: 'cut',  value: 0.5, onChange: v => eng.setLaneFX(lane, 'cut',   v) }));
    knobs.appendChild(makeKnob({ label: 'drv',  value: 0, onChange: v => eng.setLaneFX(lane, 'drive', v) }));
    knobs.appendChild(makeKnob({ label: 'dly',  value: 0, onChange: v => eng.setLaneFX(lane, 'delay', v) }));
    row.querySelector('.mute').before(knobs);
  });
}
document.getElementById('play').onclick = async function() {
  if (this.classList.contains('on')) { eng.stop(); this.classList.remove('on'); this.textContent='▶ play'; }
  else { await eng.play(); this.classList.add('on'); this.textContent='⏹ stop'; }
};
document.getElementById('bpm').oninput = e => { eng.setTempo(+e.target.value); document.getElementById('bpmv').textContent = e.target.value; };
renderStrips();
const viz = makeViz(document.getElementById('viz'), song, eng);
eng.onStep(({absStep, bar, stepInBar}) => viz.setStep(absStep, bar, stepInBar));
document.querySelectorAll('[data-view]').forEach(b => b.onclick = () => {
  document.querySelectorAll('[data-view]').forEach(x=>x.classList.toggle('on', x===b));
  viz.setView(b.dataset.view);
});
