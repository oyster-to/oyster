// Shared SPLASH-view auto-cycler.
//
// Most arcade games' splash screens cycle between two or more "views"
// (e.g. title-card ↔ leaderboard) every few seconds for marquee effect.
// The cycler is the same in every game: query a NodeList of .splash-view
// elements, toggle .is-active around the active index on an interval,
// and let the game decide what to repaint when a particular view comes
// into focus (e.g. refresh the leaderboard list).
//
// Usage (each game):
//   <link rel="stylesheet" href="../shared/splash.css">    // .splash-view rules
//   <script src="../shared/splash.js"></script>
//
//   Arcade.Splash.startCycle({
//     viewsSelector: '#splash .splash-view',
//     intervalMs:    5500,
//     onShow(view, idx) {
//       if (view.classList.contains('leaderboard')) paintLeaderboard();
//     },
//   });
//
//   // ...when the player launches a run:
//   Arcade.Splash.stopCycle();
//
// Calling startCycle() again automatically stops any prior interval, so
// it's safe to invoke unconditionally on splash mount.

(function () {
  let cycleTimer = null;

  function startCycle(opts) {
    opts = opts || {};
    stopCycle();
    const sel        = opts.viewsSelector || '#splash .splash-view';
    const intervalMs = opts.intervalMs    || 5500;
    const onShow     = typeof opts.onShow === 'function' ? opts.onShow : null;
    const views = document.querySelectorAll(sel);
    if (!views.length) return;
    // Force view[0] active immediately so the module works regardless of
    // whether the HTML pre-marked any view — and so a stopCycle + new
    // startCycle reliably resets to the first view.
    let idx = 0;
    views.forEach((v, i) => v.classList.toggle('is-active', i === idx));
    if (onShow) {
      try { onShow(views[idx], idx); } catch (e) { console.warn('Arcade.Splash onShow threw:', e); }
    }
    cycleTimer = setInterval(() => {
      idx = (idx + 1) % views.length;
      views.forEach((v, i) => v.classList.toggle('is-active', i === idx));
      if (onShow) {
        try { onShow(views[idx], idx); } catch (e) { console.warn('Arcade.Splash onShow threw:', e); }
      }
    }, intervalMs);
  }

  function stopCycle() {
    if (cycleTimer) { clearInterval(cycleTimer); cycleTimer = null; }
  }

  function isCycling() { return cycleTimer !== null; }

  window.Arcade = window.Arcade || {};
  window.Arcade.Splash = { startCycle, stopCycle, isCycling };
})();
