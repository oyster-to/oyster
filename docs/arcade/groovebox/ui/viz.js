import { stepsPerBar } from '../engine/meter.js';
import { resolveDrumPattern, hasDrumHit } from '../engine/song.js';

const DROWS = [['kick','Kick'],['snare','Snare'],['hat','HH'],['tom','Tom'],['crash','Crash']];

// Deep-clone a single 1-bar pattern object.
const clonePat = p => {
  const o = {};
  for (const k in p) o[k] = Array.isArray(p[k]) ? p[k].map(v => Array.isArray(v) ? v.slice() : v) : p[k];
  return o;
};

// Expand any pattern (single bar or array) to a 4-bar editable array.
const fork4 = src => [0,1,2,3].map(b => clonePat(Array.isArray(src) ? src[b % src.length] : src));

export function makeViz(host, song, eng) {
  let view = 'drums';
  let editBars = new Set([0]);
  let customLen = 4;
  let lastBar = 0, lastStepInBar = 0;

  function primaryBar() { return Math.min(...editBars); }

  // Ensure pool.custom + pool._base exist (fork from current selection).
  function ensureCustom() {
    const L = song.lanes.drums;
    if (!L.pool.custom) {
      const src = L.pool[L.selection];
      L.pool.custom = fork4(src);
      L.pool._base  = fork4(src);
      customLen = L.cycleLen || 4;
      L.cycleLen = customLen;
      eng.setLane('drums', 'custom');
    }
  }

  function drumEdit(k, step) {
    ensureCustom();
    const L = song.lanes.drums;
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
    const L = song.lanes.drums;
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

  function build() {
    const spb = stepsPerBar(song.meter);
    const cells = n => Array.from({length:n}, (_,i) => `<div class="vc${i%4===0?' beat':''}"></div>`).join('');
    if (view === 'drums') {
      const barSel = buildBarSelector();
      host.innerHTML = barSel
        + DROWS.map(([k,l]) => `<div class="vrow" data-k="${k}"><span class="vl">${l}</span>${cells(spb)}</div>`).join('');

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
        if (song.lanes.drums.selection === 'custom') song.lanes.drums.cycleLen = customLen;
        build();
        paint(lastBar, lastStepInBar);
      });

      // Drum cell click handlers.
      host.querySelectorAll('.vrow').forEach(row => {
        const k = row.dataset.k;
        [...row.querySelectorAll('.vc')].forEach((c, i) => c.onclick = () => drumEdit(k, i));
      });
    } else {
      host.innerHTML = `<div class="vrow" data-k="melody"><span class="vl">Notes</span>${cells(spb)}</div>`;
    }
  }

  function paint(bar, stepInBar) {
    lastBar = bar;
    lastStepInBar = stepInBar;

    if (view === 'drums') {
      const L = song.lanes.drums;
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

      host.querySelectorAll('.vrow').forEach(row => {
        const k = row.dataset.k;
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
    } else {
      const bars = song.lanes.melody.pool[song.lanes.melody.selection];
      const phrase = bars[bar % bars.length] || [];
      host.querySelectorAll('.vc').forEach((c, i) => {
        const h = phrase.find(x => x[0] === i);
        c.classList.toggle('hit', !!h);
        c.textContent = h ? h[1].replace(/[0-9]/g, '') : '';
        c.classList.toggle('now', i === stepInBar);
      });
    }
  }

  build();
  return {
    setView(v) { view = v; build(); },
    setStep(_abs, bar, stepInBar) { paint(bar, stepInBar); },
  };
}
