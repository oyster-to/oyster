// ui/env-graph.js — draggable ADSR envelope. Three handles (A · D/S · R) over an
// SVG outline. Mutates the passed `env` object in place and calls onInput after
// each change (so the editor can live-preview + refresh SAVE), matching the
// slider rows. Pure param↔geometry math lives in ./curve-math.js.
import {
  ENV_GEOM, envHandles, envPath, attackFromX, decayFromX, sustainFromY, releaseFromX,
} from './curve-math.js';

const NS = 'http://www.w3.org/2000/svg';
const el = (t, a = {}) => { const e = document.createElementNS(NS, t); for (const k in a) e.setAttribute(k, a[k]); return e; };

const W = 300, H = 80, G = ENV_GEOM;

/** makeEnvGraph(env, onInput) → DOM element. `env` = draft.patch.envelope. */
export function makeEnvGraph(env, onInput) {
  const wrap = document.createElement('div');
  wrap.className = 'ie-graph';
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'ie-graph-svg' });
  const axis = el('line', { x1: 0, y1: G.bottom, x2: W, y2: G.bottom, class: 'ie-axis' });
  const fill = el('path', { class: 'ie-fill' });
  const line = el('path', { class: 'ie-stroke' });
  const hA = el('circle', { r: 3.5, class: 'ie-handle' });
  const hDS = el('circle', { r: 3.5, class: 'ie-handle' });
  const hR = el('circle', { r: 3.5, class: 'ie-handle' });
  svg.append(axis, fill, line, hA, hDS, hR);
  wrap.appendChild(svg);

  function redraw() {
    const h = envHandles(env, G);
    const d = envPath(env, G);
    line.setAttribute('d', d);
    fill.setAttribute('d', `${d} L${G.x0},${G.bottom} Z`);
    hA.setAttribute('cx', h.a.x);   hA.setAttribute('cy', h.a.y);
    hDS.setAttribute('cx', h.ds.x); hDS.setAttribute('cy', h.ds.y);
    hR.setAttribute('cx', h.r.x);   hR.setAttribute('cy', h.r.y);
  }
  const toSvg = ev => {
    const r = svg.getBoundingClientRect();
    return { x: (ev.clientX - r.left) * (W / r.width), y: (ev.clientY - r.top) * (H / r.height) };
  };
  const drag = which => ev => {
    ev.preventDefault(); ev.stopPropagation();
    const move = e => {
      const p = toSvg(e);
      if (which === 'a') env.attack = attackFromX(p.x, G);
      else if (which === 'ds') { env.decay = decayFromX(p.x, env, G); env.sustain = sustainFromY(p.y, G); }
      else env.release = releaseFromX(p.x, env, G);
      redraw(); onInput?.();
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };
  hA.addEventListener('pointerdown', drag('a'));
  hDS.addEventListener('pointerdown', drag('ds'));
  hR.addEventListener('pointerdown', drag('r'));

  redraw();
  return wrap;
}
