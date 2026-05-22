// Shared INITIALS entry state machine.
//
// Lifts the verbatim duplicated state machine + listeners that lived in
// invaders/, space-jumper/ and rocket-ship/. The module owns the keyboard +
// touch listeners while active; the game gates its OWN restart listeners on
// Arcade.Initials.isActive().
//
// Reuses the per-game game-over overlay DOM. Default selectors match the
// pattern shared by all three games (#go-initials with .go-slot cells +
// #go-prompt). Each .go-slot must have a data-slot="N" attribute.
//
// Usage:
//
//   Arcade.Initials.mount({
//     onSubmit: (initials) => {
//       Arcade.Leaderboard.submit(score, initials).then(...);
//       // game-specific UI: "SCORE SAVED · ABC", restart grace, etc.
//     },
//     fireButton: '#tc-fire',                          // optional
//     fireLabel:  { idle: 'FIRE', select: 'SELECT' },  // optional
//   });
//   // ...on game-over if score qualifies:
//   Arcade.Initials.open();
//   // ...in your restart listeners:
//   if (Arcade.Initials.isActive()) return;

(function () {
  // Punctuation before digits — matches Rocket Ship's original convention,
  // standardised across all three games via the DRY framework pass. Trailing
  // ♥ (U+2665), ★ (U+2605) and ♠ (U+2660) for personality — Press Start 2P
  // ships all three glyphs in the pixel-art style. Worker INITIALS_RE was
  // widened to match.
  const DEFAULT_CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ.-♥★♠0123456789';
  const DEFAULTS = {
    slotsSelector:     '#go-initials .go-slot',
    containerSelector: '#go-initials',
    promptSelector:    '#go-prompt',
    slots:    3,
    charset:  DEFAULT_CHARSET,
    fireButton: null,                                   // CSS selector, e.g. '#tc-fire'
    fireLabel:  { idle: 'FIRE', select: 'SELECT' },
    extraKeys:  null,    // { 'letter-prev': ['w','W'], … } — additional key → action bindings
    onSubmit:   () => {},
  };

  let opts = null;
  let active = false;
  let slotIdx = 0;
  let letterIdx = [];

  function setFireLabel(mode) {
    if (!opts || !opts.fireButton) return;
    const btn = document.querySelector(opts.fireButton);
    if (!btn) return;
    const isSel = mode === 'select';
    btn.textContent = isSel ? opts.fireLabel.select : opts.fireLabel.idle;
    btn.setAttribute('aria-label', isSel ? 'Select / advance' : opts.fireLabel.idle);
  }

  function paint() {
    if (!opts) return;
    const slots = document.querySelectorAll(opts.slotsSelector);
    slots.forEach((s, i) => {
      s.textContent = opts.charset[letterIdx[i]];
      s.classList.toggle('is-active', i === slotIdx);
    });
  }

  function show()  { const el = opts.containerSelector && document.querySelector(opts.containerSelector); if (el) el.hidden = false; }
  function hide()  { const el = opts.containerSelector && document.querySelector(opts.containerSelector); if (el) el.hidden = true; }
  function showPrompt() { const el = opts.promptSelector && document.querySelector(opts.promptSelector); if (el) el.hidden = false; }
  function hidePrompt() { const el = opts.promptSelector && document.querySelector(opts.promptSelector); if (el) el.hidden = true; }

  function open() {
    if (!opts) throw new Error('Arcade.Initials.open() before mount()');
    active = true;
    slotIdx = 0;
    letterIdx = new Array(opts.slots).fill(0);
    hidePrompt();
    show();
    setFireLabel('select');
    paint();
  }

  function close() {
    active = false;
    setFireLabel('idle');
    hide();
    showPrompt();
  }

  function submit() {
    const initials = letterIdx.map(i => opts.charset[i]).join('');
    active = false;
    setFireLabel('idle');
    hide();
    showPrompt();
    try { opts.onSubmit(initials); } catch (e) { console.warn('Arcade.Initials onSubmit threw:', e); }
  }

  // Action machine — name ∈ 'letter-prev' | 'letter-next' | 'slot-prev' | 'slot-next' | 'advance'.
  function action(name) {
    if (!active) return false;
    const N = opts.charset.length;
    const last = opts.slots - 1;
    if (name === 'letter-prev') {
      letterIdx[slotIdx] = (letterIdx[slotIdx] - 1 + N) % N;
    } else if (name === 'letter-next') {
      letterIdx[slotIdx] = (letterIdx[slotIdx] + 1) % N;
    } else if (name === 'slot-prev') {
      slotIdx = Math.max(0, slotIdx - 1);
    } else if (name === 'slot-next' || name === 'advance') {
      if (slotIdx < last) slotIdx++;
      else { submit(); return true; }
    }
    paint();
    return true;
  }

  function wireKeyboard() {
    window.addEventListener('keydown', e => {
      if (!active) return;
      let act = null;
      if      (e.key === 'ArrowUp')    act = 'letter-prev';
      else if (e.key === 'ArrowDown')  act = 'letter-next';
      else if (e.key === 'ArrowLeft')  act = 'slot-prev';
      else if (e.key === 'ArrowRight') act = 'slot-next';
      else if (e.key === 'Enter' || e.key === ' ') act = 'advance';
      // Game-supplied extra bindings (e.g. Space Jumper maps W/S to letter prev/next).
      else if (opts.extraKeys) {
        for (const [a, keys] of Object.entries(opts.extraKeys)) {
          if (keys.includes(e.key)) { act = a; break; }
        }
      }
      else if (e.key.length === 1) {
        // Type-a-letter shortcut — jump to the typed char + auto-advance.
        const c = e.key.toUpperCase();
        const idx = opts.charset.indexOf(c);
        if (idx >= 0) {
          letterIdx[slotIdx] = idx;
          if (slotIdx < opts.slots - 1) { slotIdx++; paint(); }
          else { paint(); submit(); }
          e.preventDefault(); e.stopPropagation();
          return;
        }
      }
      if (act) { action(act); e.preventDefault(); e.stopPropagation(); }
    });
  }

  function wireTouch() {
    const container = opts.containerSelector && document.querySelector(opts.containerSelector);
    if (!container) return;
    // Tap-a-slot — jump to that slot.
    const slots = document.querySelectorAll(opts.slotsSelector);
    slots.forEach(s => {
      s.style.cursor = 'pointer';
      s.addEventListener('click', e => {
        if (!active) return;
        const idx = parseInt(s.dataset.slot, 10);
        if (Number.isInteger(idx) && idx >= 0 && idx < opts.slots) {
          slotIdx = idx;
          paint();
        }
        e.stopPropagation();
      });
    });
    // Horizontal-drag — cycle the current slot's letter (~40 px per letter).
    let dragStartX = 0, dragStartLetter = 0, dragging = false;
    container.addEventListener('pointerdown', e => {
      if (!active) return;
      if (e.target && e.target.classList && e.target.classList.contains('go-slot')) return;
      dragStartX = e.clientX;
      dragStartLetter = letterIdx[slotIdx];
      dragging = true;
      try { container.setPointerCapture(e.pointerId); } catch (_) {}
    });
    container.addEventListener('pointermove', e => {
      if (!dragging || !active) return;
      const N = opts.charset.length;
      const step = Math.round((e.clientX - dragStartX) / 40);
      const newLetter = ((dragStartLetter + step) % N + N) % N;
      if (newLetter !== letterIdx[slotIdx]) {
        letterIdx[slotIdx] = newLetter;
        paint();
      }
    });
    const endDrag = () => { dragging = false; };
    container.addEventListener('pointerup', endDrag);
    container.addEventListener('pointercancel', endDrag);
  }

  function mount(o) {
    if (opts) {
      // Idempotent: re-mounting just updates options.
      opts = Object.assign({}, opts, o || {});
      if (o && o.fireLabel) opts.fireLabel = Object.assign({}, opts.fireLabel, o.fireLabel);
      return;
    }
    opts = Object.assign({}, DEFAULTS, o || {});
    opts.fireLabel = Object.assign({}, DEFAULTS.fireLabel, (o && o.fireLabel) || {});
    letterIdx = new Array(opts.slots).fill(0);
    wireKeyboard();
    wireTouch();
  }

  window.Arcade = window.Arcade || {};
  window.Arcade.Initials = {
    mount, open, close,
    isActive: () => active,
    action,                 // exposed so games can route on-screen FIRE/SELECT/◀▶ buttons
  };
})();
