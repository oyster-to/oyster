// Shared touch-control helpers.
//
//   Arcade.Touch.bind(btn, onDown, onUp)
//     A standalone hold/tap button (jump, fire, thrust, launcher prev/next).
//
//   Arcade.Touch.movePad(leftBtn, rightBtn, onLeftDown, onLeftUp, onRightDown, onRightUp)
//     The in-game ◀▶ pair as one analog d-pad (see below).
//
// Both stop event bubbling so a press doesn't also fire the splash's global
// dismiss listener, and both flip the `.is-pressed` visual.

(function () {
  function isCoarse() {
    return !!(window.matchMedia && matchMedia('(pointer: coarse)').matches);
  }

  function initialsActive() {
    return !!(window.Arcade && window.Arcade.Initials &&
              window.Arcade.Initials.isActive && window.Arcade.Initials.isActive());
  }

  function bind(btn, onDown, onUp) {
    if (!btn) return;
    // One press = one onDown, one release = one onUp, and the press is
    // slip-proof: release fires ONLY on lift (pointerup) or cancel — never on
    // pointerleave — so sliding a finger off the edge keeps a held jump /
    // super-shot alive; only lifting ends it. We capture the pointer AND listen
    // for lift on `window`, matched by pointerId: capture usually keeps events
    // on the button, but the window listener guarantees release even if capture
    // didn't take (a finger lifted off the button can't leave the key stuck).
    // There's deliberately no pointerenter "slide onto me" path — that lived
    // here once and made a single touch tap fire twice (skip-a-letter /
    // skip-a-game). Adjacent ◀▶ sliding now lives in movePad().
    let pressed = false;
    let activeId = null;
    const up = e => {
      if (e && e.pointerId != null && activeId != null && e.pointerId !== activeId) return;
      if (e) e.preventDefault();
      if (!pressed) return;
      pressed = false;
      activeId = null;
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      btn.classList.remove('is-pressed');
      onUp();
    };
    const down = e => {
      if (pressed) return;
      pressed = true;
      if (e) {
        activeId = e.pointerId != null ? e.pointerId : null;
        e.preventDefault();
        if (e.pointerId != null && btn.setPointerCapture) {
          try { btn.setPointerCapture(e.pointerId); } catch (_) {}
        }
      }
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
      btn.classList.add('is-pressed');
      onDown();
    };
    btn.addEventListener('pointerdown', down);
    ['pointerdown', 'mousedown', 'touchstart'].forEach(ev => {
      btn.addEventListener(ev, e => e.stopPropagation(), { passive: false });
    });
  }

  // The ◀▶ movement pair as one analog d-pad. A press must START on ◀ or ▶;
  // the active direction then tracks which side of the line midway between the
  // two buttons the finger is on. So slipping off the outer edge keeps you
  // moving, crossing the midline flips direction, and only lifting stops you —
  // a stray tap elsewhere does nothing (we only attach pointerdown to the two
  // buttons). On the initials screen ◀▶ are a discrete letter-stepper, not a
  // joystick, so we fall back to a one-shot tap with no capture/tracking.
  //
  // The live gesture is tracked on `window` (not the buttons): the finger
  // roams off the buttons by design, so move/up must keep arriving regardless
  // of where it is or whether pointer capture took. The divider is measured
  // once per gesture — the buttons don't move mid-drag, so there's no need to
  // hit getBoundingClientRect() on every pointermove.
  function movePad(leftBtn, rightBtn, onLeftDown, onLeftUp, onRightDown, onRightUp) {
    if (!leftBtn || !rightBtn) return;
    let activeId = null;   // pointerId of the live gesture, or null
    let dir = null;        // 'left' | 'right' | null
    let divider = 0;       // cached midline x for the current gesture

    function setDir(next) {
      if (next === dir) return;
      if (dir === 'left')  { leftBtn.classList.remove('is-pressed');  onLeftUp(); }
      if (dir === 'right') { rightBtn.classList.remove('is-pressed'); onRightUp(); }
      dir = next;
      if (dir === 'left')  { leftBtn.classList.add('is-pressed');  onLeftDown(); }
      if (dir === 'right') { rightBtn.classList.add('is-pressed'); onRightDown(); }
    }

    function onMove(e) {
      if (activeId === null || e.pointerId !== activeId) return;
      setDir(e.clientX < divider ? 'left' : 'right');
    }
    function onUp(e) {
      if (activeId === null || e.pointerId !== activeId) return;
      activeId = null;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      setDir(null);
    }
    function onDown(e, startedOn) {
      e.preventDefault();
      e.stopPropagation();
      if (initialsActive()) {           // discrete letter step — no capture/track
        (startedOn === 'left' ? onLeftDown : onRightDown)();
        return;
      }
      if (activeId !== null) return;    // one finger drives the pad at a time
      activeId = e.pointerId;
      const el = startedOn === 'left' ? leftBtn : rightBtn;
      if (e.pointerId != null && el.setPointerCapture) {
        try { el.setPointerCapture(e.pointerId); } catch (_) {}
      }
      divider = (leftBtn.getBoundingClientRect().right +
                 rightBtn.getBoundingClientRect().left) / 2;
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
      setDir(e.clientX < divider ? 'left' : 'right');
    }

    leftBtn.addEventListener('pointerdown',  e => onDown(e, 'left'));
    rightBtn.addEventListener('pointerdown', e => onDown(e, 'right'));
    [leftBtn, rightBtn].forEach(b => {
      ['pointerdown', 'mousedown', 'touchstart'].forEach(ev => {
        b.addEventListener(ev, e => e.stopPropagation(), { passive: false });
      });
    });
  }

  // Page-level guard for all arcade games (every game loads this file): on TOUCH
  // devices only, kill the long-press menu — Android's "Copy / Web search /
  // Google Lens" popup — so a held thumb on the game (incl. its text) can't
  // trigger it. Gated to coarse pointers so desktop keeps its right-click menu.
  // Real links (e.g. the launcher's credit link) are exempted so their
  // long-press "open in new tab / copy link" still works. CSS (pixel-font.css)
  // handles selection/zoom/scroll.
  if (isCoarse()) {
    document.addEventListener('contextmenu', e => {
      if (!e.target.closest('a')) e.preventDefault();
    });
  }

  window.Arcade = window.Arcade || {};
  window.Arcade.Touch = { isCoarse, bind, movePad };
})();
