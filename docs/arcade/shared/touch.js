// Shared touch-button binding helper.
//
// The game declares its own <button> elements (left/right/jump/thrust/…)
// and wires each up with Arcade.Touch.bind(btn, onDown, onUp). The helper
// handles the pointer events (down + up + cancel + leave), the visual
// `.is-pressed` flip, and stops bubbling so a tap on a button doesn't
// also fire the splash's global dismiss listener.

(function () {
  function isCoarse() {
    return !!(window.matchMedia && matchMedia('(pointer: coarse)').matches);
  }

  function bind(btn, onDown, onUp) {
    if (!btn) return;
    const down = e => {
      // Release the implicit pointer capture a touch grabs on touchstart —
      // without this the first button keeps receiving events for the whole
      // gesture, so sliding a thumb from ◀ onto ▶ never fires ▶'s events
      // (you'd have to lift and re-tap). Releasing it lets pointerenter/leave
      // fire on the other buttons as the finger slides across them.
      if (e && e.pointerId != null && btn.hasPointerCapture && btn.hasPointerCapture(e.pointerId)) {
        try { btn.releasePointerCapture(e.pointerId); } catch (_) {}
      }
      if (e) e.preventDefault();
      btn.classList.add('is-pressed');
      onDown();
    };
    const up   = e => { if (e) e.preventDefault(); btn.classList.remove('is-pressed'); onUp(); };
    btn.addEventListener('pointerdown', down);
    btn.addEventListener('pointerup', up);
    btn.addEventListener('pointercancel', up);
    btn.addEventListener('pointerleave', up);
    // Slide support: entering a button while a pointer is held down presses it.
    // `e.buttons` is non-zero only while a touch/click is active, so a passive
    // mouse hover won't trigger it.
    btn.addEventListener('pointerenter', e => { if (e.buttons) down(e); });
    ['pointerdown', 'mousedown', 'touchstart'].forEach(ev => {
      btn.addEventListener(ev, e => e.stopPropagation(), { passive: false });
    });
  }

  // Page-level guard for all arcade games (every game loads this file): on TOUCH
  // devices only, kill the long-press menu — Android's "Copy / Web search /
  // Google Lens" popup — so a held thumb during play can't trigger it. Gated to
  // coarse pointers so desktop keeps its normal right-click menu (the launcher
  // has links). CSS (pixel-font.css) handles selection/zoom/scroll.
  if (isCoarse()) {
    document.addEventListener('contextmenu', e => e.preventDefault());
  }

  window.Arcade = window.Arcade || {};
  window.Arcade.Touch = { isCoarse, bind };
})();
