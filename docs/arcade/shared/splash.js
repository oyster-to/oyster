// Shared SPLASH controller — view-cycler + full attract-mode lifecycle.
//
// Two layers:
//
//   1. startCycle()/stopCycle() — the low-level title↔leaderboard auto-cycler
//      (toggle .is-active across .splash-view elements on an interval). Kept
//      for games that only want the marquee and drive their own start/restart.
//
//   2. mount() — the full cabinet lifecycle: booting → title → playing →
//      attract → title … It owns the cycle, the "tap to start" dismiss, the
//      per-view click handling (leaderboard view → advance to title; title →
//      start), and re-entry to attract mode after a game. Each game configures
//      it declaratively and supplies a few hooks; the bespoke ~150-line splash
//      controllers in the games collapse to one mount() call.
//
//   Arcade.Splash.mount({
//     splash: '#splash', tube: '.tube', views: '#splash .splash-view',
//     titleIndex: 0, leaderboardIndex: 1, cycleMs: 5500, bootMs: 0,
//     onTitle()           { /* title music on, game music off */ },
//     onPlay()            { /* game music on, resetRun(), go live */ },
//     onLeaderboardShow() { /* repaint the leaderboard list */ },
//     unlockAudio()       { /* iOS: first title gesture unlocks audio */ },
//     isBusy: () => Arcade.Initials.isActive(),   // suppress dismiss
//   });
//   // ...on game-over / after initials submit:
//   Arcade.Splash.enterAttract();
//   // ...in the game loop:
//   if (!Arcade.Splash.isPlaying()) return;   // freeze world on title/attract

(function () {
  let cycleTimer = null;

  // ---- Low-level cycler (also used internally by the lifecycle) -------------
  function startCycle(opts) {
    opts = opts || {};
    stopCycle();
    const sel        = opts.viewsSelector || '#splash .splash-view';
    const intervalMs = opts.intervalMs    || 5500;
    const onShow     = typeof opts.onShow === 'function' ? opts.onShow : null;
    const views = document.querySelectorAll(sel);
    if (!views.length) return;
    let idx = opts.startIndex || 0;
    const show = () => {
      views.forEach((v, i) => v.classList.toggle('is-active', i === idx));
      if (onShow) { try { onShow(views[idx], idx); } catch (e) { console.warn('Arcade.Splash onShow threw:', e); } }
    };
    show();
    cycleTimer = setInterval(() => { idx = (idx + 1) % views.length; show(); }, intervalMs);
  }
  function stopCycle() { if (cycleTimer) { clearInterval(cycleTimer); cycleTimer = null; } }
  function isCycling() { return cycleTimer !== null; }

  // ---- Lifecycle controller -------------------------------------------------
  let cfg = null;
  let phase = 'booting';   // 'booting' | 'title' | 'playing'
  let views = [];
  let viewIdx = 0;

  const q = sel => (sel ? document.querySelector(sel) : null);
  const safe = fn => { if (typeof fn === 'function') { try { fn(); } catch (e) { console.warn('Arcade.Splash hook threw:', e); } } };

  function setView(i) {
    if (!views.length) return;
    viewIdx = i;
    views.forEach((v, k) => v.classList.toggle('is-active', k === i));
    if (i === cfg.leaderboardIndex) safe(cfg.onLeaderboardShow);
  }
  function cycleFrom(startIdx) {
    stopCycle();
    setView(startIdx);
    cycleTimer = setInterval(() => setView((viewIdx + 1) % views.length), cfg.cycleMs);
  }

  function enterTitle(startIdx) {
    phase = 'title';
    const splash = q(cfg.splash), tube = q(cfg.tube), boot = q(cfg.boot);
    if (splash) splash.classList.remove('is-hidden');
    if (tube)   tube.classList.remove('is-ready');
    document.body.classList.remove('is-ingame');
    if (boot) boot.style.display = 'none';
    cycleFrom(startIdx);
    safe(cfg.onTitle);
  }
  function enterPlay() {
    phase = 'playing';
    stopCycle();
    const splash = q(cfg.splash), tube = q(cfg.tube);
    if (splash) splash.classList.add('is-hidden');
    if (tube)   tube.classList.add('is-ready');
    document.body.classList.add('is-ingame');
    safe(cfg.onPlay);
  }
  // A key/tap while the splash is up: on the leaderboard view, advance to the
  // title card (and freeze the cycle — the player is in control now); on the
  // title card, start the game.
  function tryDismiss() {
    if (phase !== 'title') return;
    if (cfg.isBusy && cfg.isBusy()) return;
    safe(cfg.unlockAudio);
    if (views.length > 1 && viewIdx === cfg.leaderboardIndex) {
      stopCycle();
      setView(cfg.titleIndex);
      return;
    }
    enterPlay();
  }

  function mount(opts) {
    cfg = Object.assign({
      splash: '#splash', tube: '.tube', views: '#splash .splash-view',
      boot: null, titleIndex: 0, leaderboardIndex: 1, cycleMs: 5500, bootMs: 0,
      ignore: null,   // CSS selector for taps that must NOT start (e.g. sound toggles)
      onTitle: null, onPlay: null, onLeaderboardShow: null, unlockAudio: null, isBusy: null,
    }, opts || {});
    views = Array.prototype.slice.call(document.querySelectorAll(cfg.views));
    phase = 'booting';

    // A pointer tap dismisses unless it landed on an opted-out control (sound
    // toggle, etc.). Keyboard can't hit those, so keydown dismisses freely.
    const onPointer = e => {
      if (cfg.ignore && e && e.target && e.target.closest && e.target.closest(cfg.ignore)) return;
      tryDismiss();
    };
    window.addEventListener('keydown', e => { if (e.key === 'Escape') return; tryDismiss(); });
    window.addEventListener('mousedown', onPointer);
    window.addEventListener('touchstart', onPointer, { passive: true });
    // Per-view click: window touch can be flaky inside an iframe on iOS, and a
    // .splash-view only has pointer-events while .is-active, so this fires for
    // the visible view only.
    views.forEach(v => v.addEventListener('click', tryDismiss));

    // Boot → title. When embedded in the arcade cabinet the boot art is hidden
    // via CSS, so go straight to title (otherwise early taps are ignored). A
    // zero delay resolves synchronously so the title is interactive at once.
    const embedded = document.documentElement.classList.contains('is-arcade-embedded');
    const delay = embedded ? 0 : (cfg.bootMs || 0);
    if (delay <= 0) enterTitle(cfg.titleIndex);
    else setTimeout(() => { if (phase === 'booting') enterTitle(cfg.titleIndex); }, delay);
  }

  // Re-show the splash after a game — start on the leaderboard so the player
  // sees the score, then cycle back to the title card.
  function enterAttract() {
    if (!cfg) return;
    enterTitle(cfg.leaderboardIndex);
  }

  window.Arcade = window.Arcade || {};
  window.Arcade.Splash = {
    startCycle, stopCycle, isCycling,
    mount, enterAttract,
    isPlaying: () => phase === 'playing',
    isTitle:   () => phase === 'title',
    start:     () => { if (phase === 'title') enterPlay(); },
  };
})();
