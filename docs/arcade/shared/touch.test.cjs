// Regression test for Arcade.Touch.bind — run with `node touch.test.cjs`.
//
// Bug: on touch devices a single tap fires BOTH pointerdown AND pointerenter
// (MDN: on no-hover devices pointerenter fires "as a result of pointerdown",
// with buttons===1 for the whole contact). bind() calls onDown from both
// listeners, so a tap invoked onDown twice. Harmless for idempotent movement
// key-flags, but the initials screen's letter-next/advance mutate on every
// call — so each tap advanced two letters (A-C-E…) and slot/submit misfired.
//
// We load the REAL touch.js into a minimal DOM stub and assert a tap presses
// exactly once, while a slide from one button onto another still presses the
// destination once (the feature we must not break).

const fs = require('fs');
const path = require('path');
const vm = require('vm');

function makeButton() {
  const listeners = {};
  const captured = new Set();
  const btn = {
    dataset: {}, style: {},
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
      contains(c) { return this._s.has(c); },
    },
    setAttribute() {}, getAttribute() { return null; },
    hasPointerCapture(id) { return captured.has(id); },
    setPointerCapture(id) { captured.add(id); },
    releasePointerCapture(id) { captured.delete(id); },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    closest() { return null; },
    fire(type, props = {}) {
      const e = { type, target: btn, pointerId: 1, pointerType: 'touch',
                  preventDefault() {}, stopPropagation() {}, ...props };
      (listeners[type] || []).forEach(fn => fn(e));
    },
  };
  return btn;
}

// Load the real source into a sandbox where `window` is the global object.
const code = fs.readFileSync(path.join(__dirname, 'touch.js'), 'utf8');
const sandbox = {};
sandbox.window = sandbox;
sandbox.matchMedia = () => ({ matches: false });
sandbox.document = { addEventListener() {} };
vm.createContext(sandbox);
vm.runInContext(code, sandbox);
const bind = sandbox.Arcade.Touch.bind;

let failures = 0;
function check(label, got, want) {
  const ok = got === want;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: got ${got}, want ${want}`);
  if (!ok) failures++;
}

// --- Case 1: a single touch tap presses exactly once ------------------------
{
  const a = makeButton();
  let down = 0, up = 0;
  bind(a, () => down++, () => up++);
  // Real touch tap, per MDN ordering (enter fires alongside down, buttons=1):
  a.fire('pointerover',  { buttons: 1 });
  a.fire('pointerenter', { buttons: 1 });
  a.fire('pointerdown',  { buttons: 1 });
  a.fire('pointerup',    { buttons: 0 });
  a.fire('pointerout',   { buttons: 0 });
  a.fire('pointerleave', { buttons: 0 });
  check('tap -> onDown once', down, 1);
  check('tap -> onUp once',   up,   1);
}

// --- Case 2: sliding a held finger from B onto A presses A once -------------
//     (the slide feature must keep working after the fix)
{
  const a = makeButton(), b = makeButton();
  let aDown = 0, aUp = 0, bDown = 0, bUp = 0;
  bind(a, () => aDown++, () => aUp++);
  bind(b, () => bDown++, () => bUp++);
  // finger lands on B
  b.fire('pointerover',  { buttons: 1 });
  b.fire('pointerenter', { buttons: 1 });
  b.fire('pointerdown',  { buttons: 1 });
  // finger slides off B onto A while still held
  b.fire('pointerleave', { buttons: 1 });
  a.fire('pointerenter', { buttons: 1 });
  // finger lifts on A
  a.fire('pointerup',    { buttons: 0 });
  a.fire('pointerleave', { buttons: 0 });
  check('slide B->A presses B once', bDown, 1);
  check('slide B->A releases B once', bUp, 1);
  check('slide B->A presses A once',  aDown, 1);
  check('slide B->A releases A once', aUp, 1);
}

// --- Case 3: implicit capture grabbed at pointerdown is still released ------
//     even though pointerenter already fired onDown first (touch fires enter
//     before down, when capture isn't set yet). The release is what lets the
//     finger slide onto neighbouring buttons — it must not be skipped.
{
  const a = makeButton();
  let down = 0;
  bind(a, () => down++, () => {});
  a.fire('pointerenter', { buttons: 1 });   // onDown #1; no capture set yet
  a.setPointerCapture(1);                   // UA grabs implicit capture at pointerdown
  a.fire('pointerdown',  { buttons: 1 });   // must release capture, must NOT re-fire onDown
  check('implicit capture released on pointerdown', a.hasPointerCapture(1), false);
  check('pointerdown after enter does not re-fire onDown', down, 1);
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
