// ui/filter-graph.js — lowpass response curve with one cutoff/resonance handle
// (x = cutoff, y = resonance). Mutates the passed `filter` object's freq + Q in
// place and calls onInput after each change. Math lives in ./curve-math.js.
import { FILT_GEOM, filterHandle, freqFromX, qFromY } from './curve-math.js';

const NS = 'http://www.w3.org/2000/svg';
const el = (t, a = {}) => { const e = document.createElementNS(NS, t); for (const k in a) e.setAttribute(k, a[k]); return e; };

const W = 300, H = 52, G = FILT_GEOM;

/** makeFilterGraph(filter, onInput) → DOM element. `filter` = draft.patch.filter. */
export function makeFilterGraph(filter, onInput) {
  const wrap = document.createElement('div');
  wrap.className = 'ie-graph';
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'ie-graph-svg' });
  const axis = el('line', { x1: 0, y1: G.bottom, x2: W, y2: G.bottom, class: 'ie-axis' });
  const line = el('path', { class: 'ie-stroke' });
  const handle = el('circle', { r: 3.5, class: 'ie-handle' });
  svg.append(axis, line, handle);
  wrap.appendChild(svg);

  function redraw() {
    const h = filterHandle(filter, G);
    const hx = Math.max(G.x0, Math.min(G.x1, h.x));
    const pass = G.base;                                   // flat passband level
    const peak = h.y;                                      // resonance height
    const fall = G.bottom - 2;                             // rolled-off floor
    const kneeL = Math.max(G.x0, hx - 22);
    // flat passband → resonant peak at cutoff → roll off. When the cutoff sits
    // near the right edge (an open/transparent filter) there's no room to roll
    // off, so the curve just stays flat to the edge — a clean "nothing filtered"
    // line instead of a crammed kink running off-screen.
    line.setAttribute('d', hx > G.x1 - 26
      ? `M${G.x0},${pass} L${kneeL},${pass} Q${hx - 6},${pass} ${hx},${peak} L${G.x1},${peak}`
      : `M${G.x0},${pass} L${kneeL},${pass} Q${hx - 6},${pass} ${hx},${peak} ` +
        `Q${hx + 10},${peak} ${(hx + G.x1) / 2},${(peak + fall) / 2} L${G.x1},${fall}`);
    handle.setAttribute('cx', hx); handle.setAttribute('cy', h.y);
  }
  const toSvg = ev => {
    const r = svg.getBoundingClientRect();
    return { x: (ev.clientX - r.left) * (W / r.width), y: (ev.clientY - r.top) * (H / r.height) };
  };
  handle.addEventListener('pointerdown', ev => {
    ev.preventDefault(); ev.stopPropagation();
    const move = e => {
      const p = toSvg(e);
      filter.freq = freqFromX(p.x, G);
      filter.Q = qFromY(p.y, G);
      redraw(); onInput?.();
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  });

  redraw();
  return wrap;
}
