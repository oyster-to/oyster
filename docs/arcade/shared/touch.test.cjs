// Regression tests for shared/touch.js — run with `node touch.test.cjs`.
//
// Loads the REAL module into a minimal DOM stub and drives pointer events.
//
// bind():    standalone buttons (jump/fire/thrust, launcher prev/next).
//            One press = one onDown, one release = one onUp. Slip-proof:
//            releases only on lift/cancel (NOT pointerleave). The live press is
//            tracked on `window` (matched by pointerId) so it releases even if
//            pointer capture didn't take. No pointerenter "slide" path (that
//            caused a tap to double-fire — A-C-E / skip-a-game).
// movePad(): the in-game ◀▶ pair. Press must start on a button; the active
//            direction follows which side of the line midway between the two
//            buttons the finger is on (divider measured once per gesture). Slip
//            off the outer edge → keep going; cross the midline → switch; lift →
//            stop. The gesture is tracked on `window` so the finger can roam off
//            the buttons. On the initials screen it's a discrete one-letter tap.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Window-level event registry (movePad / bind track live gestures on window).
let winListeners = {};
function clearWin() { winListeners = {}; }
function fireWindow(type, props = {}) {
  const e = { type, preventDefault() {}, stopPropagation() {},
              pointerId: 1, pointerType: 'touch', ...props };
  (winListeners[type] || []).slice().forEach(fn => fn(e));
}

function makeButton(rect) {
  const listeners = {};
  const captured = new Set();
  const btn = {
    _rect: rect || { left: 0, right: 80, top: 0, bottom: 80, width: 80, height: 80 },
    _rectCalls: 0,
    _captureThrows: false,
    dataset: {}, style: {},
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
      contains(c) { return this._s.has(c); },
    },
    setAttribute() {}, getAttribute() { return null; },
    getBoundingClientRect() { this._rectCalls++; return this._rect; },
    hasPointerCapture(id) { return captured.has(id); },
    setPointerCapture(id) { if (this._captureThrows) throw new Error('no capture'); captured.add(id); },
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

// Load the real source; `window` is the global object.
const code = fs.readFileSync(path.join(__dirname, 'touch.js'), 'utf8');
const sandbox = {};
sandbox.window = sandbox;
sandbox.matchMedia = () => ({ matches: false });
sandbox.document = { addEventListener() {} };
sandbox.addEventListener    = (t, fn) => { (winListeners[t] = winListeners[t] || []).push(fn); };
sandbox.removeEventListener = (t, fn) => { if (winListeners[t]) winListeners[t] = winListeners[t].filter(f => f !== fn); };
vm.createContext(sandbox);
vm.runInContext(code, sandbox);
const { bind, movePad } = sandbox.Arcade.Touch;

// Toggleable initials stub that movePad consults for discrete mode.
let initialsActive = false;
sandbox.Arcade.Initials = { isActive: () => initialsActive };

let failures = 0;
function check(label, got, want) {
  const ok = got === want;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  if (!ok) failures++;
}

// ============================ bind() ============================

// Case 1: a single tap presses and releases exactly once (release via window).
{
  clearWin();
  const a = makeButton();
  let down = 0, up = 0;
  bind(a, () => down++, () => up++);
  a.fire('pointerenter', { buttons: 1 });  // pre-down enter must NOT press (slide removed)
  a.fire('pointerdown',  { buttons: 1 });
  fireWindow('pointerup', { pointerId: 1 });
  check('bind tap -> onDown once', down, 1);
  check('bind tap -> onUp once',   up,   1);
}

// Case 2: slip-proof — leaving the button does NOT release; only lifting does.
{
  clearWin();
  const a = makeButton();
  let down = 0, up = 0;
  bind(a, () => down++, () => up++);
  a.fire('pointerdown',  { buttons: 1 });
  a.fire('pointerleave', { buttons: 1 });  // no longer wired — must be a no-op
  check('bind slip-off keeps it held (onUp not yet)', up, 0);
  fireWindow('pointerup', { pointerId: 1 });
  check('bind lift releases once', up, 1);
  check('bind held the whole time (onDown once)', down, 1);
}

// Case 3: a lone pointerenter with buttons held must NOT press (no slide path).
{
  clearWin();
  const a = makeButton();
  let down = 0;
  bind(a, () => down++, () => {});
  a.fire('pointerenter', { buttons: 1 });
  check('bind pointerenter alone does not press', down, 0);
}

// Case 4: press captures the pointer (so lift/cancel usually come back here).
{
  clearWin();
  const a = makeButton();
  bind(a, () => {}, () => {});
  a.fire('pointerdown', { buttons: 1, pointerId: 7 });
  check('bind captures pointer on press', a.hasPointerCapture(7), true);
}

// Case 5: capture FAILS (unsupported / throws) — release still fires via the
// window listener when the finger lifts off the button. And a different
// pointer's lift must not release this one.
{
  clearWin();
  const a = makeButton();
  a._captureThrows = true;
  let up = 0;
  bind(a, () => {}, () => up++);
  a.fire('pointerdown', { pointerId: 1 });
  fireWindow('pointerup', { pointerId: 2 });   // someone else's finger
  check('bind: other pointer lift does not release', up, 0);
  fireWindow('pointerup', { pointerId: 1 });   // our finger, lifted off the button
  check('bind: window lift releases even without capture', up, 1);
}

// ============================ movePad() ============================
// left  = [0..80], right = [96..176]  ->  divider at (80+96)/2 = 88

function makePad() {
  const left  = makeButton({ left: 0,  right: 80,  top: 0, bottom: 80, width: 80, height: 80 });
  const right = makeButton({ left: 96, right: 176, top: 0, bottom: 80, width: 80, height: 80 });
  const c = { lDown: 0, lUp: 0, rDown: 0, rUp: 0 };
  movePad(left, right,
    () => c.lDown++, () => c.lUp++,
    () => c.rDown++, () => c.rUp++);
  return { left, right, c };
}

// Case 6: slip off the outer edge of ▶ keeps moving right (the reported bug).
{
  clearWin(); initialsActive = false;
  const { right, c } = makePad();
  right.fire('pointerdown', { clientX: 130 });   // press right
  fireWindow('pointermove', { clientX: 300 });   // slid way off to the right
  check('movePad slip-off stays right (rDown once)', c.rDown, 1);
  check('movePad slip-off did NOT release', c.rUp, 0);
  fireWindow('pointerup',   { clientX: 300 });
  check('movePad lift releases right', c.rUp, 1);
  check('movePad never pressed left', c.lDown, 0);
}

// Case 7: crossing the midline switches direction; lift releases.
{
  clearWin(); initialsActive = false;
  const { right, c } = makePad();
  right.fire('pointerdown', { clientX: 130 });   // right
  fireWindow('pointermove', { clientX: 40  });   // cross to left half
  check('cross -> released right', c.rUp, 1);
  check('cross -> pressed left',   c.lDown, 1);
  fireWindow('pointermove', { clientX: 130 });   // cross back to right
  check('cross back -> released left', c.lUp, 1);
  check('cross back -> pressed right', c.rDown, 2);
  fireWindow('pointerup',   { clientX: 130 });
  check('lift releases right (total rUp 2)', c.rUp, 2);
}

// Case 8: gameplay press captures the pointer.
{
  clearWin(); initialsActive = false;
  const { right } = makePad();
  right.fire('pointerdown', { clientX: 130, pointerId: 3 });
  check('movePad captures pointer in gameplay', right.hasPointerCapture(3), true);
  fireWindow('pointerup', { pointerId: 3 });
}

// Case 9: on the initials screen ◀▶ are discrete taps — no capture, no zone.
{
  clearWin(); initialsActive = true;
  const { left, c } = makePad();
  left.fire('pointerdown', { clientX: 40, pointerId: 9 });
  fireWindow('pointermove', { clientX: 300, pointerId: 9 });  // would-be zone move: ignored
  fireWindow('pointerup',   { clientX: 300, pointerId: 9 });
  check('initials: one tap = one letter step', c.lDown, 1);
  check('initials: no zone tracking on move', c.rDown, 0);
  check('initials: no capture', left.hasPointerCapture(9), false);
  initialsActive = false;
}

// Case 10: a direction held when you die (screen flips to initials) must STILL
// release on lift — else the key sticks into the next game.
{
  clearWin(); initialsActive = false;
  const { right, c } = makePad();
  right.fire('pointerdown', { clientX: 130 });   // holding right in gameplay
  check('held-right pressed', c.rDown, 1);
  initialsActive = true;                          // died -> initials opened, finger still down
  fireWindow('pointerup', { clientX: 130 });      // finger lifts
  check('release fires even though initials now active', c.rUp, 1);
  initialsActive = false;
}

// Case 11: the divider is measured once per gesture, not on every pointermove
// (no getBoundingClientRect layout read in the hot path).
{
  clearWin(); initialsActive = false;
  const { left, right } = makePad();
  left._rectCalls = 0; right._rectCalls = 0;
  right.fire('pointerdown', { clientX: 130 });
  fireWindow('pointermove', { clientX: 140 });
  fireWindow('pointermove', { clientX: 60  });
  fireWindow('pointermove', { clientX: 150 });
  check('divider rect read once per gesture (left)',  left._rectCalls,  1);
  check('divider rect read once per gesture (right)', right._rectCalls, 1);
  fireWindow('pointerup', { clientX: 150 });
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
