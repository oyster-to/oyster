import { stepsPerBar } from '../engine/meter.js';
import { resolveDrumPattern, hasDrumHit } from '../engine/song.js';

const DROWS = [['kick','Kick'],['snare','Snare'],['hat','HH'],['tom','Tom'],['crash','Crash']];

export function makeViz(host, song) {
  let view = 'drums';
  function build() {
    const spb = stepsPerBar(song.meter);
    const cells = n => Array.from({length:n}, (_,i)=>`<div class="vc${i%4===0?' beat':''}"></div>`).join('');
    if (view === 'drums')
      host.innerHTML = DROWS.map(([k,l])=>`<div class="vrow" data-k="${k}"><span class="vl">${l}</span>${cells(spb)}</div>`).join('');
    else
      host.innerHTML = `<div class="vrow" data-k="melody"><span class="vl">Notes</span>${cells(spb)}</div>`;
  }
  function paint(bar, stepInBar) {
    if (view === 'drums') {
      const L = song.lanes.drums;
      const pat = resolveDrumPattern(L.pool[L.selection], bar, L.cycleLen);
      host.querySelectorAll('.vrow').forEach(row => { const k = row.dataset.k;
        row.querySelectorAll('.vc').forEach((c,i)=>{ c.classList.toggle('hit', hasDrumHit(pat,k,i)); c.classList.toggle('now', i===stepInBar); }); });
    } else {
      const bars = song.lanes.melody.pool[song.lanes.melody.selection];
      const phrase = bars[bar % bars.length] || [];
      host.querySelectorAll('.vc').forEach((c,i)=>{ const h = phrase.find(x=>x[0]===i);
        c.classList.toggle('hit', !!h); c.textContent = h ? h[1].replace(/[0-9]/g,'') : ''; c.classList.toggle('now', i===stepInBar); });
    }
  }
  build();
  return { setView(v){ view = v; build(); }, setStep(_abs, bar, stepInBar){ paint(bar, stepInBar); } };
}
