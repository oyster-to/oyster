// Tests for Arcade.Music — run with `node music.test.cjs`.
// Loads the real shared/music.js into a DOM stub with fake <audio> elements,
// then checks the multiplexer (play one, pause+reset others), the { gain }
// volume, stop-all vs pause, and the iOS autoplay-block retry via retryPending().

const fs = require('fs');
const path = require('path');
const vm = require('vm');

function makeAudio(id) {
  return {
    id,
    paused: true,
    currentTime: 7,        // non-zero so a reset to 0 is observable
    volume: 1,
    loop: false,
    _blockPlay: false,     // true => play() rejects, simulating the iOS autoplay block
    _plays: 0,
    play() {
      this._plays++;
      if (this._blockPlay) return Promise.reject(new Error('autoplay blocked'));
      this.paused = false;
      return Promise.resolve();
    },
    pause() { this.paused = true; },
  };
}

const theme = makeAudio('bgm-theme');
const level = makeAudio('bgm');
const boss  = makeAudio('bgm-boss');
const byId  = { 'bgm-theme': theme, 'bgm': level, 'bgm-boss': boss };
const allBgm = [theme, level, boss];

const sandbox = {
  console,
  document: {
    getElementById(id) { return byId[id] || null; },
    // The module's only selector is audio[id^="bgm"] — every fake track matches.
    querySelectorAll(sel) { return sel.indexOf('bgm') >= 0 ? allBgm : []; },
  },
};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, 'music.js'), 'utf8'), sandbox);
const M = sandbox.Arcade.Music;

let failures = 0;
function check(label, got, want) {
  const ok = got === want;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  if (!ok) failures++;
}
const tick = () => Promise.resolve();   // flush one microtask round

(async () => {
  // play(): track plays, currentTime reset, gain applied, loops, current() set
  M.play('bgm-theme', { gain: 0.4 });
  check('theme playing', theme.paused, false);
  check('theme reset to 0', theme.currentTime, 0);
  check('theme gain applied', theme.volume, 0.4);
  check('theme loops by default', theme.loop, true);
  check('current() is theme', M.current(), 'bgm-theme');

  // switch: previous track pauses + resets, new one plays
  theme.currentTime = 9;
  M.play('bgm', { gain: 0.35 });
  check('theme paused on switch', theme.paused, true);
  check('theme reset on switch', theme.currentTime, 0);
  check('level playing', level.paused, false);
  check('level gain applied', level.volume, 0.35);
  check('current() is level', M.current(), 'bgm');

  // no gain => volume untouched (invaders model: pause.js owns volume)
  boss.volume = 0.9;
  M.play('bgm-boss');
  check('no-gain leaves volume untouched', boss.volume, 0.9);
  check('level paused when boss starts', level.paused, true);

  // play() with an unknown id is a safe no-op (early return; current() unchanged)
  const currentBefore = M.current();
  M.play('bgm-nonexistent');
  check('play unknown id does not change current()', M.current(), currentBefore);

  // stop(): pause + reset ALL bgm tracks (not just current), clear current()
  boss.currentTime = 4;
  level.paused = false; level.currentTime = 6;   // a stray track still playing
  M.stop();
  check('boss paused after stop', boss.paused, true);
  check('boss reset after stop', boss.currentTime, 0);
  check('stop() also stopped the stray track', level.paused, true);
  check('stop() reset the stray track', level.currentTime, 0);
  check('current() null after stop', M.current(), null);

  // pause(): pause current WITHOUT resetting
  M.play('bgm', { gain: 0.35 });
  level.currentTime = 12;
  M.pause();
  check('level paused after pause()', level.paused, true);
  check('pause() does not reset currentTime', level.currentTime, 12);

  // autoplay block: play() rejects, track stays paused, retryPending() retries
  theme._blockPlay = true;
  M.play('bgm-theme', { gain: 0.4 });
  await tick();   // let the rejected play()'s .catch run
  check('blocked play leaves track paused', theme.paused, true);
  check('current() still set after block', M.current(), 'bgm-theme');

  theme._blockPlay = false;        // gesture arrives; autoplay now allowed
  const playsBefore = theme._plays;
  M.retryPending();
  await tick();
  check('retryPending() retried the pending track', theme._plays, playsBefore + 1);
  check('retryPending() -> theme now playing', theme.paused, false);

  // retryPending() with nothing pending is a safe no-op
  const playsAfter = theme._plays;
  M.retryPending();
  check('retryPending with nothing pending does not replay', theme._plays, playsAfter);

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
})();
