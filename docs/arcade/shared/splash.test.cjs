// Tests for Arcade.Splash.mount() lifecycle — run with `node splash.test.cjs`.
// Loads the real shared/splash.js into a minimal DOM stub and drives the
// boot → title → playing → attract → title transitions.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

function makeEl() {
  return {
    style: {}, _clicks: [],
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
      toggle(c, on) { if (on) this._s.add(c); else this._s.delete(c); },
      contains(c) { return this._s.has(c); },
    },
    addEventListener(t, fn) { if (t === 'click') this._clicks.push(fn); },
    click() { this._clicks.slice().forEach(fn => fn({ preventDefault() {} })); },
  };
}

const splashEl = makeEl(), tubeEl = makeEl(), bodyEl = makeEl(), docEl = makeEl();
const view0 = makeEl(), view1 = makeEl();

const winL = {};
function fireWin(type, props = {}) {
  const e = { type, preventDefault() {}, ...props };
  (winL[type] || []).slice().forEach(fn => fn(e));
}

const sandbox = {
  console,
  setTimeout, clearTimeout, setInterval, clearInterval,
  addEventListener:    (t, fn) => { (winL[t] = winL[t] || []).push(fn); },
  removeEventListener: (t, fn) => { if (winL[t]) winL[t] = winL[t].filter(f => f !== fn); },
  document: {
    body: bodyEl,
    documentElement: docEl,
    querySelector(sel) { return sel === '#splash' ? splashEl : sel === '.tube' ? tubeEl : null; },
    querySelectorAll() { return [view0, view1]; },
    addEventListener() {},
  },
};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, 'splash.js'), 'utf8'), sandbox);
const S = sandbox.Arcade.Splash;

const hits = { title: 0, play: 0, lb: 0, unlock: 0 };
let busy = false;
S.mount({
  cycleMs: 999999,   // keep the interval from firing during the test
  graceMs: 0,        // no transition grace — these checks fire input synchronously
  onTitle:  () => hits.title++,
  onPlay:   () => hits.play++,
  onLeaderboardShow: () => hits.lb++,
  unlockAudio: () => hits.unlock++,
  isBusy: () => busy,
});

let failures = 0;
function check(label, got, want) {
  const ok = got === want;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  if (!ok) failures++;
}

// boot (bootMs 0) resolves synchronously to title
check('boots straight to title', S.isTitle(), true);
check('not playing at title', S.isPlaying(), false);
check('onTitle fired on boot', hits.title, 1);
check('title view active', view0.classList.contains('is-active'), true);

// ESC must NOT dismiss
fireWin('keydown', { key: 'Escape' });
check('ESC does not start', S.isPlaying(), false);

// isBusy suppresses dismiss (e.g. initials open)
busy = true;
fireWin('keydown', { key: ' ' });
check('busy suppresses start', S.isPlaying(), false);
busy = false;

// a tap on the title card starts the game
fireWin('keydown', { key: ' ' });
check('title tap -> playing', S.isPlaying(), true);
check('onPlay fired', hits.play, 1);
check('unlockAudio fired on gesture', hits.unlock, 1);
check('splash hidden on play', splashEl.classList.contains('is-hidden'), true);
check('tube ready on play', tubeEl.classList.contains('is-ready'), true);

// game over -> attract: re-shows splash starting on the leaderboard view
S.enterAttract();
check('attract -> title phase', S.isTitle(), true);
check('attract -> not playing', S.isPlaying(), false);
check('attract starts on leaderboard view', view1.classList.contains('is-active'), true);
check('onLeaderboardShow fired in attract', hits.lb >= 1, true);
check('splash re-shown in attract', splashEl.classList.contains('is-hidden'), false);

// on the leaderboard view, a tap advances to the title card (does NOT start)
fireWin('keydown', { key: ' ' });
check('leaderboard tap -> title card (not playing)', S.isPlaying(), false);
check('advanced to title view', view0.classList.contains('is-active'), true);

// now on the title card, a tap starts a fresh game
fireWin('keydown', { key: ' ' });
check('title tap after attract -> playing', S.isPlaying(), true);

S.stopCycle();

// Grace window: the input that triggers a transition (and its paired
// touchstart→click) must NOT immediately dismiss the freshly-shown splash —
// otherwise saving initials bleeds straight into starting a new game.
// Fully reset listeners from the first mount before remounting: window
// listeners AND the per-view click handlers (else this mount duplicates them).
Object.keys(winL).forEach(k => delete winL[k]);
view0._clicks.length = 0; view1._clicks.length = 0;
S.mount({ cycleMs: 999999, graceMs: 10000, onTitle: () => {}, onPlay: () => {} });
fireWin('keydown', { key: ' ' });   // arrives within the grace window
check('grace: input right after a transition is ignored', S.isPlaying(), false);
S.stopCycle();

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
