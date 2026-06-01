import { createEngine } from '../engine/index.js';
import { kids } from '../songs/kids.js';
import { makeViz } from './viz.js';

const eng = createEngine(); eng.load(kids);
const song = eng.getSong();
const LANES = ['drums','bass','chords','melody'];
const chordModes = ['pad','arp','stab'];
const options = lane => lane === 'chords' ? chordModes : Object.keys(song.lanes[lane].pool);

function renderStrips() {
  const host = document.getElementById('strips');
  host.innerHTML = LANES.map(lane => {
    const opts = options(lane).map(n => `<option${n===song.lanes[lane].selection?' selected':''}>${n}</option>`).join('');
    return `<div class="lane"><span class="name">${lane}</span>
      <select data-lane="${lane}">${opts}</select>
      <button class="mute" data-lane="${lane}">mute</button></div>`;
  }).join('');
  host.querySelectorAll('select').forEach(s => s.onchange = e => eng.setLane(e.target.dataset.lane, e.target.value));
  host.querySelectorAll('.mute').forEach(b => b.onclick = () => {
    const m = eng.toggleMute(b.dataset.lane); b.classList.toggle('on', m); b.textContent = m ? 'muted' : 'mute';
  });
}
document.getElementById('play').onclick = async function() {
  if (this.classList.contains('on')) { eng.stop(); this.classList.remove('on'); this.textContent='▶ play'; }
  else { await eng.play(); this.classList.add('on'); this.textContent='⏹ stop'; }
};
document.getElementById('bpm').oninput = e => { eng.setTempo(+e.target.value); document.getElementById('bpmv').textContent = e.target.value; };
renderStrips();
const viz = makeViz(document.getElementById('viz'), song);
eng.onStep(({absStep, bar, stepInBar}) => viz.setStep(absStep, bar, stepInBar));
document.querySelectorAll('[data-view]').forEach(b => b.onclick = () => {
  document.querySelectorAll('[data-view]').forEach(x=>x.classList.toggle('on', x===b));
  viz.setView(b.dataset.view);
});
