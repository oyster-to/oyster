// Shared GAME OVER / GAME COMPLETE overlay state — show/hide, grace window,
// and the "first post-grace key opens initials, next one restarts" gate.
//
// Canonicalises the Invaders pendingInitials model. Space Jumper previously
// used a setTimeout that auto-opened initials after the grace; the new model
// waits for the user's NEXT keypress, which is what players expect (a held
// key at the moment of death doesn't blow past the prompt accidentally).
//
// Each game still owns its own endRun() function — it computes win/loss,
// picks the grace duration, decides whether the score qualifies for initials,
// then calls Arcade.EndOverlay.show({ ... }) with those decisions. The
// module owns the DOM (#gameover + #go-title + #go-score-val + #go-hiscore
// + #go-prompt) and the timing state.
//
// Usage:
//
//   Arcade.EndOverlay.mount();                  // defaults to standard DOM
//   // ...on game over:
//   Arcade.EndOverlay.show({
//     score,
//     title:     win ? 'GAME COMPLETE' : 'GAME OVER',
//     win,                                       // applies .is-win class
//     hiscore:   Arcade.Leaderboard.getHighScore(),
//     graceMs:   1200,
//     qualifies: Arcade.Leaderboard.qualifies(score),
//   });
//   // ...in restart listeners:
//   if (!Arcade.EndOverlay.acceptsInput()) return;
//   if (Arcade.EndOverlay.consumePending()) { Arcade.Initials.open(); return; }
//   // else: dismiss + start new run
//   Arcade.EndOverlay.hide();
//   startRun();

(function () {
  const DEFAULTS = {
    rootSelector:    '#gameover',
    titleSelector:   '#go-title',
    scoreSelector:   '#go-score-val',
    hiscoreSelector: '#go-hiscore',
    promptSelector:  '#go-prompt',
    visibleClass:    'is-visible',
    hiscoreFormat:   (hs) => `HIGH ${String(hs.score).padStart(4, '0')} ${hs.initials || '---'}`,
  };

  let opts = null;
  let inputAllowedAt = 0;
  let pendingInitials = false;
  // Title classes the module has applied this show() — removed in hide().
  let appliedTitleClass = '';

  function mount(o) {
    opts = Object.assign({}, DEFAULTS, o || {});
  }
  function ensure() {
    if (!opts) opts = Object.assign({}, DEFAULTS);
  }

  function show({
    score = 0,
    hiscore = null,         // { score, initials } | null
    title = 'GAME OVER',
    titleClass = '',        // e.g. 'is-win' or 'is-loss' (or '' for none)
    graceMs = 1200,
    qualifies = false,
    hiscoreText = null,     // optional override — bypasses default formatter
  } = {}) {
    ensure();
    const ov       = document.querySelector(opts.rootSelector);
    const titleEl  = document.querySelector(opts.titleSelector);
    const scoreEl  = document.querySelector(opts.scoreSelector);
    const hiEl     = document.querySelector(opts.hiscoreSelector);
    const promptEl = document.querySelector(opts.promptSelector);
    if (!ov) return;
    if (titleEl) {
      titleEl.textContent = title;
      // Remove the previously-applied title class first so toggling between
      // .is-win and .is-loss across runs doesn't accumulate stale classes.
      if (appliedTitleClass) titleEl.classList.remove(appliedTitleClass);
      if (titleClass) titleEl.classList.add(titleClass);
      appliedTitleClass = titleClass || '';
    }
    if (scoreEl) scoreEl.textContent = score;
    if (hiEl) {
      hiEl.textContent = hiscoreText != null
        ? hiscoreText
        : (hiscore ? opts.hiscoreFormat(hiscore) : '');
    }
    if (promptEl) promptEl.hidden = false;
    ov.classList.add(opts.visibleClass);
    ov.setAttribute('aria-hidden', 'false');
    inputAllowedAt = performance.now() + (graceMs || 0);
    pendingInitials = !!qualifies;
  }

  function hide() {
    ensure();
    const ov      = document.querySelector(opts.rootSelector);
    const titleEl = document.querySelector(opts.titleSelector);
    const promptEl = document.querySelector(opts.promptSelector);
    if (ov) {
      ov.classList.remove(opts.visibleClass);
      ov.setAttribute('aria-hidden', 'true');
    }
    if (titleEl && appliedTitleClass) {
      titleEl.classList.remove(appliedTitleClass);
      appliedTitleClass = '';
    }
    if (promptEl) promptEl.hidden = false;
    inputAllowedAt = 0;
    pendingInitials = false;
  }

  function isVisible() {
    ensure();
    const ov = document.querySelector(opts.rootSelector);
    return ov ? ov.classList.contains(opts.visibleClass) : false;
  }

  // True once the grace window has elapsed AND the overlay is at least
  // armed (inputAllowedAt > 0). Returns false outright if show() hasn't
  // been called yet this run.
  function acceptsInput() {
    return inputAllowedAt > 0 && performance.now() >= inputAllowedAt;
  }

  // Returns true exactly ONCE per show() if qualifies was true. Game's
  // restart listener routes to initials entry on a true return, restart
  // otherwise.
  function consumePending() {
    if (!pendingInitials) return false;
    pendingInitials = false;
    return true;
  }

  // Extend the grace window — used after Arcade.Initials.onSubmit to give
  // the player a beat before their next keypress restarts the game.
  function extendGrace(ms) {
    inputAllowedAt = performance.now() + (ms || 0);
  }

  // Re-mark pendingInitials — useful if the game wants to defer initials
  // until after a custom celebration / cutscene resolves.
  function setPendingInitials(v) {
    pendingInitials = !!v;
  }

  window.Arcade = window.Arcade || {};
  window.Arcade.EndOverlay = {
    mount, show, hide, isVisible,
    acceptsInput, consumePending, extendGrace, setPendingInitials,
  };
})();
