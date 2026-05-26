// Shared leaderboard client for the arcade games. Scoped per-game via the
// `game` key passed to init() — corresponds to the worker's GAMES allowlist
// (see infra/leaderboard-worker/src/worker.ts).
//
// Local mirror in localStorage is the source of truth for `qualifies()` so
// the game can decide in-memory whether to prompt for initials without a
// round-trip. Cloud (the Cloudflare Worker) is the canonical store and is
// refreshed asynchronously on init and after a successful submit.
//
// Usage:
//   Arcade.Leaderboard.init({ game: 'space-jumper', max: 10 });
//   Arcade.Leaderboard.refresh();           // fire-and-forget, updates mirror
//   if (Arcade.Leaderboard.qualifies(score)) ...
//   const r = await Arcade.Leaderboard.submit(score, 'ABC');

(function () {
  const LB_API = '/api/leaderboard';
  const LB_API_START = '/api/leaderboard/start';

  let game = null;
  let MAX = 10;
  let LB_KEY = null;

  // One token per session, refreshed lazily. The worker TTL is 1 hour; we
  // mint on demand and trust its expiry rather than tracking it precisely.
  let _playToken = null;
  let _playTokenExp = 0;

  function init(opts) {
    game = (opts && opts.game) || null;
    MAX = (opts && opts.max) || 10;
    LB_KEY = game ? `oyster-arcade-leaderboard-${game}` : null;
  }

  function read() {
    if (!LB_KEY) return [];
    try {
      const s = localStorage.getItem(LB_KEY);
      if (!s) return [];
      const arr = JSON.parse(s);
      return Array.isArray(arr) ? arr.slice(0, MAX) : [];
    } catch (_) { return []; }
  }

  function write(list) {
    if (!LB_KEY) return;
    try { localStorage.setItem(LB_KEY, JSON.stringify(list.slice(0, MAX))); } catch (_) {}
  }

  async function refresh() {
    if (!game) return read();
    try {
      const r = await fetch(`${LB_API}?game=${encodeURIComponent(game)}`);
      if (!r.ok) return read();
      const j = await r.json();
      if (Array.isArray(j.list)) {
        write(j.list);
        return j.list;
      }
    } catch (_) {}
    return read();
  }

  function qualifies(score) {
    if (!Number.isFinite(score) || score <= 0) return false;
    const list = read();
    if (list.length < MAX) return true;
    return score > list[list.length - 1].score;
  }

  function getHighScore() {
    const list = read();
    return list.length ? list[0] : null;
  }

  async function ensurePlayToken() {
    const now = Date.now();
    if (_playToken && _playTokenExp > now + 60_000) return _playToken;
    try {
      const r = await fetch(LB_API_START, { method: 'GET' });
      if (!r.ok) return null;
      const j = await r.json();
      if (typeof j.token !== 'string') return null;
      _playToken = j.token;
      _playTokenExp = typeof j.expires_at === 'number' ? j.expires_at : 0;
      return _playToken;
    } catch (_) { return null; }
  }

  async function submit(score, initials) {
    if (!game) return { ok: false, error: 'not_initialised' };
    // Optimistic local insert — runs synchronously before the cloud round-trip
    // so the player sees their score (and the UI can highlight it) the instant
    // the board paints, instead of waiting on / depending on the network. The
    // cloud stays the source of truth: a successful submit overwrites the mirror
    // with the canonical list below, and refresh() reconciles on next load.
    const optimistic = read();
    optimistic.push({ score, initials, created_at: Date.now() });
    optimistic.sort((a, b) => b.score - a.score);
    write(optimistic.slice(0, MAX));

    const token = await ensurePlayToken();
    if (!token) return { ok: false, error: 'no_token' };
    try {
      const r = await fetch(LB_API, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ game, score, initials, token }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok && Array.isArray(j.list)) {
        write(j.list);
        return { ok: true, list: j.list };
      }
      // Token expired during the session: invalidate so the next call mints fresh.
      if (j && j.error === 'invalid_token') { _playToken = null; _playTokenExp = 0; }
      return { ok: false, error: (j && j.error) || `http_${r.status}` };
    } catch (_) { return { ok: false, error: 'network' }; }
  }

  // -------------------------------------------------------------------------
  // Splash painters — fold the duplicated DOM build code from each game's
  // paintSplashHiScore + paintLeaderboard into the shared module.
  // -------------------------------------------------------------------------

  // Paints the splash's "HIGH SCORE 0000 ABC" row from the current top entry.
  // When hideWhenEmpty is true, the row element (if a rowSelector was given)
  // gets its `hidden` attribute set to true on an empty board — otherwise the
  // row stays visible and paints "0" / "---" placeholders.
  function paintHiScoreRow(opts) {
    opts = opts || {};
    const pad = opts.pad || 4;
    const val = opts.valueSelector    && document.querySelector(opts.valueSelector);
    const ini = opts.initialsSelector && document.querySelector(opts.initialsSelector);
    const row = opts.rowSelector      && document.querySelector(opts.rowSelector);
    if (!val || !ini) return;
    const top = getHighScore();
    if (!top && opts.hideWhenEmpty) {
      if (row) row.hidden = true;
      return;
    }
    if (row) row.hidden = false;
    val.textContent = String(top ? top.score : 0).padStart(pad, '0');
    ini.textContent = (top && top.initials) || '---';
  }

  // Paints the top-N list into the splash's <ol id="lb-list">. Builds each
  // entry via document.createElement so user-supplied initials can't be
  // interpreted as HTML. Optional lb-since column for games that want a
  // humanised timestamp (Rocket Ship uses this — passes its own
  // sinceFormatter).
  function paintList(opts) {
    opts = opts || {};
    const ol = opts.listSelector && document.querySelector(opts.listSelector);
    if (!ol) return;
    const pad       = opts.pad || 4;
    const emptyText = opts.emptyText || 'NO SCORES YET — BE THE FIRST';
    const showSince = !!opts.showSince;
    const fmtSince  = opts.sinceFormatter || (() => '');
    // Match the grid to whether we render the since cell (CSS .has-since adds
    // the 4th column) so both 3- and 4-column games lay out correctly.
    ol.classList.toggle('has-since', showSince);
    const list = read();
    ol.textContent = '';
    if (!list.length) {
      const li = document.createElement('li');
      const span = document.createElement('span');
      span.className = 'lb-empty';
      span.textContent = emptyText;
      li.appendChild(span);
      ol.appendChild(li);
      return;
    }
    // Optional { score, initials } to flag as the player's just-entered row —
    // the matching <li> gets an `is-you` class for the game to style/animate.
    // Only the FIRST match is flagged: duplicate score+initials entries are
    // common, and highlighting several rows would be confusing.
    const hl = opts.highlight || null;
    let highlighted = false;
    list.forEach((e, i) => {
      const li = document.createElement('li');
      if (!highlighted && hl && e.score === hl.score && (e.initials || '') === (hl.initials || '')) {
        li.classList.add('is-you');
        highlighted = true;
      }
      const cols = [
        ['lb-rank',     String(i + 1).padStart(2, '0') + '.'],
        ['lb-initials', e.initials || '---'],
        ['lb-score',    String(e.score).padStart(pad, '0')],
      ];
      if (showSince) cols.push(['lb-since', fmtSince(e.created_at)]);
      for (const [cls, text] of cols) {
        const span = document.createElement('span');
        span.className = cls;
        span.textContent = text;
        li.appendChild(span);
      }
      ol.appendChild(li);
    });
  }

  window.Arcade = window.Arcade || {};
  window.Arcade.Leaderboard = {
    init, read, refresh, qualifies, getHighScore, submit,
    paintHiScoreRow, paintList,
  };
})();
