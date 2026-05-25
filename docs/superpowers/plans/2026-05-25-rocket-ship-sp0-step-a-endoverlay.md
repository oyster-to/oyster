# Rocket Ship SP-0 · Step A — adopt `Arcade.EndOverlay` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Rocket Ship's bespoke game-over overlay driver with the shared `Arcade.EndOverlay`, preserving the celebration-before-initials flow for a new #1.

**Architecture:** `docs/rocket-ship.html` already has the standard `#gameover` DOM that `Arcade.EndOverlay` expects, and already drives game-over via a single IIFE plus a `window.__rocketShowGameOver` hook called from `triggerGameOver()`. This swaps the overlay's show/hide/grace/hiscore-text bookkeeping to `Arcade.EndOverlay` while the game keeps ownership of `pendingScore`, the `isNewBest` decision, the celebration, and when to open initials.

**Tech Stack:** Plain browser JS (no build step). The change is single-file. There is **no headless test** for this DOM/iframe flow — verification is a manual browser smoke-test of the three game-over paths; the existing `touch`/`splash` headless suites just confirm nothing else broke.

**Spec:** `docs/superpowers/specs/2026-05-25-rocket-ship-framework-adoption-design.md` (Step A). This is the first of four independent PRs (A → B → C → D); B/C/D are out of scope here.

**Branch:** `rocket-ship-adopt` (worktree; already on top of `main` with FW-0).

---

## File Structure

- **Modify** `docs/rocket-ship.html` only:
  - the shared-script include block (~734–739): add `end-overlay.js`
  - the game-over IIFE (~1710–1801): rewrite to drive `Arcade.EndOverlay`

`triggerGameOver()` (~1123–1156) and `showCelebration()` (~1565–1592) are **not** changed — they already call `window.__rocketShowGameOver(score)` / accept an `onAdvance` callback, which is the seam we keep.

---

### Task 1: Adopt `Arcade.EndOverlay` for the game-over overlay

**Files:**
- Modify: `docs/rocket-ship.html` (include block ~734–739; game-over IIFE ~1710–1801)

- [ ] **Step 1: Add the `end-overlay.js` include**

Find:
```html
<script src="arcade/shared/initials.js"></script>
<script src="arcade/shared/iframe-host.js"></script>
```
Replace with:
```html
<script src="arcade/shared/initials.js"></script>
<script src="arcade/shared/end-overlay.js"></script>
<script src="arcade/shared/iframe-host.js"></script>
```

- [ ] **Step 2: Rewrite the game-over IIFE to drive `Arcade.EndOverlay`**

This is the whole `(function () { … })();` block that starts with `const ov = document.getElementById('gameover');` (~line 1710) and ends just before the closing `</script>` (~1801).

Find (the current bespoke driver):
```js
(function () {
  const ov = document.getElementById('gameover');
  if (!ov) return;
  const initialsBox   = document.getElementById('go-initials');
  const promptEl      = document.getElementById('go-prompt');
  const hiscoreLineEl = document.getElementById('go-hiscore');

  let pendingScore = 0;

  // Initials state machine + listeners are owned by shared/initials.js.
  // Rocket Ship uses ▲ as the SELECT button during initials. onSubmit kicks
  // back into attract-mode after writing the score.
  Arcade.Initials.mount({
    fireButton: '#tc-thrust',
    fireLabel:  { idle: '▲', select: '✓' },
    onSubmit: (initials) => {
      addToLeaderboard(pendingScore, initials);
      ov.classList.remove('is-visible');
      Arcade.Splash.enterAttract();
    },
  });

  function isNewBest(score) {
    const list = readLeaderboard();
    if (!list.length) return score > 0;
    return score > list[0].score;   // strictly beat current top
  }
  function showGameOverWith(score) {
    pendingScore = score;
    const beat = qualifiesForLeaderboard(score);
    // New #1 → flag goes up first; initials prompt appears on dismissal.
    if (beat && isNewBest(score)) {
      showCelebration(() => paintGameOverOverlay(true));
    } else {
      paintGameOverOverlay(beat);
    }
  }
  function paintGameOverOverlay(beat) {
    ov.classList.add('is-visible');
    const hs = getHighScore();
    if (beat) {
      hiscoreLineEl.textContent = `RANK ON THE LEADERBOARD — TOP ${LB_SIZE}`;
      Arcade.Initials.open();
    } else {
      hiscoreLineEl.textContent = `HIGH SCORE ${String(hs.score).padStart(3,'0')} ${hs.initials}`;
      initialsBox.hidden = true;
      promptEl.hidden    = false;
    }
  }

  // Expose for triggerGameOver -> setTimeout fade-in
  window.__rocketShowGameOver = showGameOverWith;

  // Touch routing for the game-over overlay. Returns true if the action was
  // consumed so the touch-button bindings know to suppress their game
  // (rotate/thrust) side-effects. ◀/▶ cycle the active letter, ▲ advances /
  // saves on the last slot — handled by Arcade.Initials.action() while
  // entering initials, dismiss-to-attract-mode otherwise.
  window.__rocketGameOverTouch = function (action) {
    if (!ov.classList.contains('is-visible')) return false;
    if (Arcade.Initials.isActive()) {
      Arcade.Initials.action(action);
      return true;
    }
    // Non-initials game-over: any touch button dismisses.
    ov.classList.remove('is-visible');
    Arcade.Splash.enterAttract();
    return true;
  };

  // Click on the gameover overlay dismisses when not entering initials.
  // Direct-on-element click is reliable on iOS inside iframes where the
  // older window.touchstart pattern was flaky. Initials entry uses the
  // dedicated on-screen buttons instead (handled by shared/initials.js).
  ov.addEventListener('click', () => {
    if (!ov.classList.contains('is-visible')) return;
    if (Arcade.Initials.isActive()) return;
    ov.classList.remove('is-visible');
    Arcade.Splash.enterAttract();
  });

  // Non-initials dismiss path — shared/initials.js handles the keyboard
  // while it's active, so we only handle the "no initials, any key
  // dismisses to attract mode" case here.
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') return;
    if (!ov.classList.contains('is-visible')) return;
    if (Arcade.Initials.isActive()) return;
    ov.classList.remove('is-visible');
    Arcade.Splash.enterAttract();
  });
})();
```

Replace with (drives `Arcade.EndOverlay`; celebration + initials timing unchanged):
```js
(function () {
  const ov = document.getElementById('gameover');
  if (!ov) return;

  let pendingScore = 0;

  // The overlay's show/hide, the input grace window, and the score/hi-score
  // text are owned by shared/end-overlay.js (its default selectors match this
  // page's #gameover / #go-* DOM). The game still decides WHEN to celebrate,
  // open initials, or just prompt.
  Arcade.EndOverlay.mount();

  // Initials state machine + listeners are owned by shared/initials.js.
  // Rocket Ship uses ▲ as the SELECT button during initials. onSubmit writes
  // the score, hides the overlay, and kicks back into attract-mode.
  Arcade.Initials.mount({
    fireButton: '#tc-thrust',
    fireLabel:  { idle: '▲', select: '✓' },
    onSubmit: (initials) => {
      addToLeaderboard(pendingScore, initials);
      Arcade.EndOverlay.hide();
      Arcade.Splash.enterAttract();
    },
  });

  function isNewBest(score) {
    const list = readLeaderboard();
    if (!list.length) return score > 0;
    return score > list[0].score;   // strictly beat current top
  }

  // Show the overlay for the just-ended run. Rocket Ship's hi-score line is
  // bespoke in both branches, so pass it explicitly. A qualifying score opens
  // initials immediately (Rocket Ship's long-standing behaviour — no "press a
  // key to enter initials" step); Initials.open() hides the prompt and shows
  // the slots. graceMs makes a held death-key no longer blow past the overlay.
  function showOverlay(beat) {
    const hs = getHighScore();
    const hiscoreText = beat
      ? `RANK ON THE LEADERBOARD — TOP ${LB_SIZE}`
      : `HIGH SCORE ${String(hs.score).padStart(3, '0')} ${hs.initials}`;
    Arcade.EndOverlay.show({ score: pendingScore, qualifies: beat, hiscoreText, graceMs: 600 });
    if (beat) Arcade.Initials.open();
    else      Arcade.Initials.close();   // ensure the slots are hidden / prompt shown
  }
  function showGameOverWith(score) {
    pendingScore = score;
    const beat = qualifiesForLeaderboard(score);
    // New #1 → flag goes up first; overlay + initials appear on its dismissal.
    if (beat && isNewBest(score)) showCelebration(() => showOverlay(true));
    else                          showOverlay(beat);
  }

  // Expose for triggerGameOver -> setTimeout fade-in
  window.__rocketShowGameOver = showGameOverWith;

  // Dismiss the overlay (back to attract) when NOT entering initials, and only
  // once the grace window has elapsed. shared/initials.js owns the keyboard
  // while initials is active.
  function dismiss() {
    if (!Arcade.EndOverlay.isVisible()) return;
    if (!Arcade.EndOverlay.acceptsInput()) return;   // grace window
    if (Arcade.Initials.isActive()) return;
    Arcade.EndOverlay.hide();
    Arcade.Splash.enterAttract();
  }

  // Touch routing for the on-screen buttons during game-over. Returns true if
  // consumed so the touch bindings suppress their game (rotate/thrust) side
  // effects. ◀/▶/▲ drive initials while active; otherwise any button dismisses.
  window.__rocketGameOverTouch = function (action) {
    if (!Arcade.EndOverlay.isVisible()) return false;
    if (Arcade.Initials.isActive()) { Arcade.Initials.action(action); return true; }
    dismiss();
    return true;
  };

  // Direct-on-element click is reliable on iOS inside iframes where the older
  // window.touchstart pattern was flaky.
  ov.addEventListener('click', dismiss);
  window.addEventListener('keydown', (e) => { if (e.key !== 'Escape') dismiss(); });
})();
```

- [ ] **Step 3: Static checks**

Run from the worktree root (`~/Dev/oyster.worktrees/rocket-ship-adopt`):
```bash
grep -n 'shared/end-overlay.js' docs/rocket-ship.html        # expect 1 match, in the include block
grep -nE "ov\.classList\.(add|remove)\('is-visible'\)|paintGameOverOverlay|initialsBox|hiscoreLineEl" docs/rocket-ship.html   # expect NO matches (bespoke driver gone)
grep -n "Arcade.EndOverlay" docs/rocket-ship.html            # expect mount(), show(), hide(), isVisible(), acceptsInput()
node docs/arcade/shared/touch.test.cjs && node docs/arcade/shared/splash.test.cjs   # both ALL PASS (unaffected)
```
Confirm `end-overlay.js` loads **before** the game-over IIFE (include is at ~738; the IIFE is far below). Confirm `triggerGameOver` (~1123) and `showCelebration` (~1565) were NOT modified.

- [ ] **Step 4: Manual browser smoke-test (human) — the real verification**

This DOM/iframe flow has no automated test. Serve the worktree and exercise **all three game-over paths**:
```bash
python3 -m http.server --directory ~/Dev/oyster.worktrees/rocket-ship-adopt/docs 8000
# open http://localhost:8000/rocket-ship.html
```
- **No-qualify** (score that doesn't make the top 10): overlay shows after the crash, hi-score line reads `HIGH SCORE NNN III`, the prompt is shown, the initials slots are hidden; a key/tap (after the brief grace) returns to attract.
- **Qualifies, not #1** (top-10 but not first): overlay shows `RANK ON THE LEADERBOARD — TOP 10`, initials slots appear immediately; ↑↓/←→/Enter (and ◀/▶/▲ on touch) step + save; saving returns to attract with the score recorded.
- **New #1**: the celebration flag flies first; dismissing it shows the overlay + initials; saving records the score and returns to attract.
- **Grace check:** holding a key through the moment of death does **not** instantly blow past the overlay.
- The original son-found bug must stay fixed: letter stepping works and the **last** letter can be entered/saved.

- [ ] **Step 5: Commit**

```bash
git add docs/rocket-ship.html
git commit -m "arcade(rocket-ship): game-over via shared Arcade.EndOverlay"
```

---

## Notes / risks

- **No `end-overlay.js` change expected.** Adopting it here in a celebration-first game is a test of API completeness; the `show()` + `acceptsInput()` + immediate `Initials.open()` paths cover Rocket Ship without needing `consumePending`/`setPendingInitials`. If a genuine gap appears, fix it as a small additive change to `end-overlay.js` and note it — do not contort the game.
- **`Initials.close()` on the no-qualify path** replaces the old explicit `initialsBox.hidden = true`, guaranteeing the slots are hidden and the prompt shown even if a prior run left them visible. Verify in the manual test (play a qualifying run, then a non-qualifying run — slots must not linger).
- **Touch dismiss now respects the grace window** (it didn't before). This is the intended, consistent behaviour; confirm a too-fast tap right at death doesn't skip the overlay.
- Scope: do **not** touch CSS, pause, BGM, or `triggerGameOver`/`showCelebration` — those are Steps B/C/D and separate concerns.
