// Tests for Arcade.Engine — run with `node engine.test.cjs`.
// Loads the real shared/engine.js into a DOM stub, then checks canvas.configure
// (DPR cap + clamp + backing-store sizing + transform reset + returned facts),
// rectsOverlap (strict AABB), rand.tileHash (stable PRNG), and draw.circle
// (integer scanline spans).

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const sandbox = { console };
sandbox.window = sandbox;
sandbox.devicePixelRatio = 1;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, 'engine.js'), 'utf8'), sandbox);
const E = sandbox.Arcade.Engine;

let failures = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  if (!ok) failures++;
}
function checkTrue(label, cond) { check(label, !!cond, true); }

// ---- mock canvas + 2D context --------------------------------------------
function makeCanvas(cssW, cssH) {
  const ctx = {
    _transform: null,
    _rects: [],
    fillStyle: '',
    setTransform(a, b, c, d, e, f) { this._transform = [a, b, c, d, e, f]; },
    fillRect(x, y, w, h) { this._rects.push([x, y, w, h]); },
  };
  return {
    width: 0,
    height: 0,
    getBoundingClientRect() { return { width: cssW, height: cssH }; },
    getContext() { return ctx; },
  };
}

// ---- canvas.configure -----------------------------------------------------
// maxDpr omitted => dpr 1 even on a high-density device.
sandbox.devicePixelRatio = 2;
let c = makeCanvas(800, 600);
let s = E.canvas.configure(c);
check('maxDpr omitted => dpr 1', s.dpr, 1);
check('omitted: backing width = css*1', c.width, 800);
check('omitted: backing height = css*1', c.height, 600);

// devicePixelRatio 3 + maxDpr 2 => dpr 2, backing = css*2.
sandbox.devicePixelRatio = 3;
c = makeCanvas(800, 600);
s = E.canvas.configure(c, { maxDpr: 2 });
check('dpr capped at maxDpr', s.dpr, 2);
check('backing width = css*dpr', c.width, 1600);
check('backing height = css*dpr', c.height, 1200);
check('transform reset to (dpr,0,0,dpr,0,0)', c.getContext()._transform, [2, 0, 0, 2, 0, 0]);
check('returns the five facts + ctx', [s.cssWidth, s.cssHeight, s.dpr, s.pixelWidth, s.pixelHeight, !!s.ctx], [800, 600, 2, 1600, 1200, true]);

// invalid maxDpr values are clamped to 1.
sandbox.devicePixelRatio = 2;
for (const bad of [0, null, NaN, -2]) {
  const cc = makeCanvas(100, 100);
  const ss = E.canvas.configure(cc, { maxDpr: bad });
  check(`invalid maxDpr ${String(bad)} => dpr 1`, ss.dpr, 1);
}

// ---- rectsOverlap (strict AABB) ------------------------------------------
check('overlapping rects => true', E.rectsOverlap(0, 0, 10, 10, 5, 5, 10, 10), true);
check('disjoint rects => false', E.rectsOverlap(0, 0, 10, 10, 20, 20, 5, 5), false);
check('edge-touching => false (strict)', E.rectsOverlap(0, 0, 10, 10, 10, 0, 10, 10), false);

// ---- rand.tileHash --------------------------------------------------------
check('tileHash deterministic', E.rand.tileHash(7), E.rand.tileHash(7));
checkTrue('tileHash in [0,1)', E.rand.tileHash(7) >= 0 && E.rand.tileHash(7) < 1);
checkTrue('tileHash varies by index', E.rand.tileHash(1) !== E.rand.tileHash(2));
checkTrue('tileHash(0) known value ~0.2655', Math.abs(E.rand.tileHash(0) - 0.2655) < 1e-3);

// ---- draw.circle (integer scanlines) -------------------------------------
const dctx = makeCanvas(10, 10).getContext();
E.draw.circle(dctx, 10, 10, 2);
// Poles (y = ±r) round to w=0 → zero-width (no-op) rects; expected here to pin
// the exact scanline output of the source algorithm (kept verbatim for parity).
check('draw.circle scanline spans (r=2 at 10,10)', dctx._rects,
  [[10, 8, 0, 1], [8, 9, 4, 1], [8, 10, 4, 1], [8, 11, 4, 1], [10, 12, 0, 1]]);

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
