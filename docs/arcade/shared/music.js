// Shared BGM control for the arcade games. One track plays at a time; play()
// pauses + resets the others. Survives the iOS autoplay block: a play() the
// browser rejects is remembered and retried by retryPending() (call it from the
// splash's first-gesture unlockAudio hook).
//
// CONVENTION: a "bgm track" is any <audio> whose id starts with "bgm" — the same
// prefix pause.js uses for the MUSIC volume slider. New tracks MUST be named
// bgm / bgm-* to be managed by this module (and by the slider).
//
// Arcade.Music OWNS:         which bgm track is active; pausing + resetting the
//                            other bgm tracks; retrying an autoplay-blocked
//                            play() after a user gesture.
// Arcade.Music does NOT own: SFX (Arcade.Audio); the pause overlay UI; the
//                            global music-slider policy; crossfades.
//
// Volume: { gain } is a track's per-track BASE level. When pause.js is present
// the effective volume is (MUSIC slider × gain), re-applied on slider changes
// so the slider stays sticky across track switches; with no pause.js it's just
// gain. Pass NO gain (invaders) to let the slider own the volume outright.
//
// current() returns the track we last asked to play. After an autoplay block it
// may name a track that is pending (not yet audible) until retryPending() runs —
// it is "selected", not "guaranteed playing".
//
// Usage:
//   Arcade.Music.play('bgm-theme', { gain: 0.4 });   // title theme
//   Arcade.Music.play('bgm', { gain: 0.35 });        // level music
//   Arcade.Music.pause();                            // pause current (no reset)
//   Arcade.Music.stop();                             // pause + reset ALL bgm tracks
//   Arcade.Music.retryPending();                     // retry an autoplay-blocked play (iOS gesture)
//
// play() also accepts { loop, restart }. loop defaults to the element's authored
// <audio loop> attribute — pass loop:true/false only to override it (so a track
// authored without `loop`, e.g. a one-shot win jingle, is NOT forced to loop).
// restart defaults true; pass restart:false to resume from the current position.

(function () {
  const SELECTOR = 'audio[id^="bgm"]';
  let currentId = null;    // id of the track we last asked to play
  let pendingId = null;    // a play() the browser rejected, awaiting retryPending()
  let currentGain = null;  // current track's base gain, for re-composing on slider change
  let subscribed = false;  // hooked into pause.js's onToggle yet?

  function bgmEls() {
    try { return Array.prototype.slice.call(document.querySelectorAll(SELECTOR)); }
    catch (_) { return []; }
  }

  // Effective volume = the player's MUSIC slider (pause.js; 1 if absent) × the
  // track's base gain — keeps the per-track mix AND lets the slider stay sticky.
  function musicVol() {
    try {
      if (window.Arcade && Arcade.Pause && Arcade.Pause.getMusicVolume) return Arcade.Pause.getMusicVolume();
    } catch (_) {}
    return 1;
  }
  // Re-apply the current track's volume when the slider moves. pause.js fires
  // onToggle AFTER it writes <audio>.volume, so this composes on top and wins.
  function reapply() {
    if (currentGain == null || !currentId) return;
    const a = document.getElementById(currentId);
    if (a) { try { a.volume = musicVol() * currentGain; } catch (_) {} }
  }
  function ensureSubscribed() {
    if (subscribed) return;
    try {
      if (!(window.Arcade && Arcade.Pause && Arcade.Pause.onToggle)) return;
      Arcade.Pause.onToggle(reapply);   // slider moves → re-compose
      // pause.js runs applyMusicVolume() on DOMContentLoaded WITHOUT firing
      // onToggle, which would clobber a composed volume set by a play() during
      // parse (embedded immediate-title). Re-apply once after that init —
      // registered here (after pause.js's own DCL listener) so ours runs last.
      if (document.readyState === 'loading' && document.addEventListener) {
        document.addEventListener('DOMContentLoaded', reapply, { once: true });
      }
      subscribed = true;
    } catch (_) {}
  }

  // Start one element. gain null => leave volume as-is. restart false => keep
  // currentTime (used by retryPending()). A rejected play() (autoplay block)
  // marks the track pending for the next retryPending().
  function start(a, id, gain, loop, restart) {
    try {
      if (loop != null) a.loop = loop;   // undefined => respect the authored <audio loop>
      if (gain != null) a.volume = musicVol() * gain;   // compose with the MUSIC slider
      if (restart) a.currentTime = 0;
      const p = a.play();
      if (p && typeof p.catch === 'function') p.catch(() => { pendingId = id; });
    } catch (_) { pendingId = id; }
  }

  function play(id, opts) {
    opts = opts || {};
    ensureSubscribed();
    const restart = opts.restart !== false;  // default true
    const target = document.getElementById(id);
    if (!target) return;
    bgmEls().forEach(a => {
      if (a === target) return;
      try { a.pause(); if (restart) a.currentTime = 0; } catch (_) {}
    });
    currentId = id;
    currentGain = opts.gain == null ? null : opts.gain;
    pendingId = null;
    start(target, id, opts.gain, opts.loop, restart);   // opts.loop undefined => keep authored loop
  }

  function pause() {
    if (!currentId) return;
    const a = document.getElementById(currentId);
    if (a) { try { a.pause(); } catch (_) {} }
  }

  // Stop ALL bgm tracks (not just current) — robust against a stray track left
  // playing by legacy code or a race — then reset and clear selection.
  function stop() {
    bgmEls().forEach(a => { try { a.pause(); a.currentTime = 0; } catch (_) {} });
    currentId = null;
    pendingId = null;
    currentGain = null;
  }

  function retryPending() {
    if (!pendingId) return;
    const id = pendingId;
    pendingId = null;
    const a = document.getElementById(id);
    if (a) start(a, id, null, undefined, false);   // retry: keep volume, loop + position
  }

  function current() { return currentId; }

  window.Arcade = window.Arcade || {};
  window.Arcade.Music = { play, pause, stop, retryPending, current };
})();
