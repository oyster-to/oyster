# Open Arcade — Contribution & Game Contract (design)

**Date:** 2026-06-28
**Status:** Design draft, rev 2 — incorporates external security review at the
"foundation-right" rigor level. Not yet an implementation spec.

> How *anyone* (a friend, a kid, a kid's AI agent) gets a game onto
> `arcade.oyster.to` — safely, with you in control of what runs on your domain.
>
> **Sibling doc:** [`arcade-framework-roadmap.md`](arcade-framework-roadmap.md)
> covers the *authoring substrate* — making it easy to *build* a game (cabinet
> chrome, sim contract, MP substrate). **This doc covers the *distribution*
> boundary** — how a *third-party* game gets *packaged, isolated, and listed*.
> They meet at "the game contract" but answer different questions:
> *"how do I write a game easily?"* vs *"how does my game get in, without
> being able to break the arcade?"*

---

## North star & the staircase

The end state (call it **self-serve**) is: a kid's agent runs one command, and a
sandboxed game appears on the live arcade with no human in the loop. We are
**not** building that first. We're building its *bones* now and keeping a manual
gate, so the journey is switches flipping — not rewrites.

The only throwaway piece is the PR/merge mechanism itself. Everything else —
the game contract, the `/install` guide, the sandbox, the data-driven registry —
is identical at every stage:

| Stage | Registry source | Add-a-game = | Gate | Game hosting (isolation is day-one) |
|---|---|---|---|---|
| **Now** | checked-in `games.json` | PR to `arcade-games` + manifest | **you merge** | per-game origin, immutable release |
| **Public-gated** | same | same (repo is public) | **you merge** | same |
| **Self-serve** | D1 table | `POST` bundle to upload API | auto-validate | same, bundle in R2 |

## Repo topology (decided)

Two boundaries get conflated — keep them distinct:

- **Governance / contribution boundary = the repo.** First-party code you can
  change vs third-party games outsiders PR — different repos.
- **Runtime isolation boundary = serving origin + response headers + iframe
  policy.** This — *not* the repo — is what actually stops a game touching the
  cabinet, and it must hold even for a game living in your own repo. (See §3.)

The repos:

```
oyster-to/oyster          first-party, trusted: cabinet chrome, shared/ framework,
                          groovebox, the deploy worker, the registry API, this contract
oyster-to/arcade-games    third-party, untrusted: one folder per contributed game
   (later, optional) oyster-to/arcade   extract chrome here only if it ever wants its own identity
```

- Chrome **stays in `oyster`** — it already deploys via its own worker, and moving
  groovebox + the worker + the `/assets/*` proxy buys nothing toward self-serve.
  Extraction to `oyster-to/arcade` is a deferrable, reversible-later (`git
  filter-repo`) cosmetic move; never a prerequisite.
- Games get **`oyster-to/arcade-games`** so contributors don't fork the product
  and game history doesn't pollute product CI.
- The two are joined by a **registry + sandboxed iframes**, *not* a git submodule
  or build-time fetch — because the registry is the literal spine of self-serve,
  so the connecting mechanism pays for itself instead of being scaffolding.

---

## The game contract

A "game" is the smallest thing the cabinet can list, launch, isolate, and trust
nothing about. Adopting the Oyster framework is **strongly suggested — but never
forced**: the `/install` flow actively *coaches an agent up the ladder* rather
than just accepting whatever it's handed, while always leaving a working
lower-effort path. **The port itself is part of the install.**

### Two tiers of polish (progressive adoption)

A submission lands somewhere on a spectrum; the install flow's job is to push it
toward the top:

- **Tier 1 — Drop-in (the floor).** Any self-contained HTML game. Sandboxed,
  listed, playable — but *frozen*: it shares nothing with the cabinet, so it
  neither looks native nor inherits future improvements. The "I just want my POC
  up" path, and the always-available fallback when a port is too hard.
- **Tier 2 — Adopted (the target).** The agent ports the POC *onto* the cabinet:
  the shared `window.Arcade.*` libs (CRT chrome, splash/attract, audio, touch,
  pause, leaderboard, pixel font) loaded from a **hosted, versioned cabinet
  bundle**, plus a port that follows the **design guide**. The payoff is the whole
  point of this feature:
  - it **looks native** — same CRT cabinet, pixel font, neon-on-dark feel;
  - it gets **leaderboard / touch / splash / pause for free**, not hand-rolled;
  - it **inherits cabinet upgrades automatically** — because it *references* the
    shared bundle instead of vendoring a copy, a better CRT shader or smoother
    touch shipped to the cabinet lifts every adopted game with no re-submit.

So a kid's rough POC doesn't just get *hosted* — it gets *upgraded on the way in*,
and keeps improving as the cabinet does. (This is also exactly the
`arcade-framework-roadmap.md` PROOF test, arriving via real outside games rather
than a purpose-built demo.)

### How "upgrades when it pulls in" works

Adopted games reference the shared libs by a **versioned URL on a dedicated static
origin** (kept off the privileged cabinet origin on purpose):

```html
<script src="https://shared.arcade.oyster.to/v1/audio.js"></script>
```

- Pinned to a **major** (`v1`) → backwards-compatible improvements flow to every
  adopted game automatically. Breaking changes bump to `v2`; games opt in.
- The game's CSP allow-lists **exactly** `shared.arcade.oyster.to` for scripts —
  *our* audited code, never arbitrary third-party JS, and never the whole arcade
  origin.
- The shared libs must work under the game's locked-down CSP (no cross-origin
  network). Concretely, `leaderboard.js` (today it `fetch`es the registry) needs a
  **sandboxed mode** that posts scores to the host over `postMessage` instead (see
  the host protocol). Tracked in the build steps.
- A moving `v1` alias is a *fleet-wide* dependency: changes ship via **canary +
  cross-game regression test + instant rollback** — never validate-after-release.

### The design guide (loose by design)

A short, example-driven **arcade design guide** lives with the framework and is
handed to the agent by `/install`. Deliberately *loose* — principles + do/don't +
a couple of worked examples, not a rigid pixel spec — so games keep their own
character (Crossy Road, Among Us, and Roblox don't look alike, and shouldn't)
while sharing the cabinet frame. Roughly: the CRT/neon-on-dark palette idiom (and
how to pick a tasteful per-game `palette`); the Press Start 2P pixel font and
chunky retro "feel"; splash/pause/end-initials conventions (use the shared ones);
reach for the shared `sfx-*` cues before inventing audio; phone touch-control
conventions.

### 1. Packaging

```
arcade-games/
  <game-id>/
    game.json        ← manifest (required)
    index.html       ← entry point (required; overridable via manifest.entry)
    thumb.png        ← carousel thumbnail (required; 480×480 recommended)
    ...              ← any other assets the game references (relative paths only)
```

Rules:

- **Self-contained.** Everything the game needs lives in its folder, referenced by
  **relative path** — loaded from the game's *own* origin, so `localStorage` and
  same-origin `fetch` work normally. The only off-origin reference allowed is the
  shared cabinet bundle from `shared.arcade.oyster.to` (Tier 2). No other external
  scripts/connections — CSP-enforced (see §3).
- **One folder = one game = one `game-id`.** The folder name is the id.
- **Size budget.** Soft caps on folder size, file count, and individual +
  decompressed sizes (so the edge upload stays sane and zip-bombs can't land);
  enforced by the validator.
- **No bundler required** — but `file://` won't reproduce the production headers,
  sandbox, or origin, so authoring is verified with **`arcade-games preview`**,
  which serves the game under the *exact* prod iframe + CSP config. The "open it
  and it works" simplicity stays; the preview just makes it truthful.

### 2. Manifest — `game.json`

Replaces the hand-maintained `GAMES` array entry. The registry is *derived* from
these, so adding a game never touches chrome code.

| Field | Req | Type | Notes |
|---|---|---|---|
| `schemaVersion` | ✓ | `1` | Lets the contract evolve without breaking old games. |
| `id` | ✓ | string | `^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$`. Must equal folder name. |
| `name` | ✓ | string | Display name on the marquee/card (e.g. `NUCLEAR TESTING FACILITY`). |
| `author` | ✓ | string | **Rendered on the game-select screen** (a "by &lt;author&gt;" credit). An **alias/handle**, never identifying info — especially for kids. Length + control-char limited. |
| `tagline` | ✓ | string | One line for the card / coming-soon flyer. |
| `description` |  | string | Longer blurb. |
| `entry` |  | string | Defaults to `index.html`. |
| `thumbnail` |  | string | Defaults to `thumb.png`. |
| `palette` |  | object | `{ bg1, bg2, accent, neon }` hex — themes the card, matches today's `GAMES` palette. |
| `controls` |  | string[] | e.g. `["arrows","tap"]` — drives touch hints + a controls badge. |
| `orientation` |  | `any\|portrait\|landscape` | Default `any`. |
| `capabilities` |  | string[] | Permissions the game needs (`pointer-lock`, `fullscreen`, `gamepad`, `autoplay`). Host grants **only** these — least privilege, not all-on. |

`name` / `author` / `tagline` are length-capped and control-char-stripped.
**Trust tier is not a manifest field** — it's assigned server-side in the registry,
so a manifest can never claim first-party privileges.

Example:

```json
{
  "schemaVersion": 1,
  "id": "nuclear-testing-facility",
  "name": "NUCLEAR TESTING FACILITY",
  "author": "Henry",
  "tagline": "Contain the meltdown before the timer hits zero",
  "controls": ["arrows", "tap"],
  "orientation": "landscape",
  "palette": { "bg1": "#1a0c3a", "bg2": "#04081f", "accent": "#2dd4ff", "neon": "#a855f7" }
}
```

### 3. The runtime boundary (the firewall)

Games already boot in `<iframe id="game-frame">` with a parent-owned exit button
and a `postMessage` close bridge. The firewall is **three enforced layers** — none
of them the repo, all of them runtime:

**(a) Per-game origin.** Each game is served from its own subdomain under an
immutable release path:

```
https://<game-id>.arcade-games.oyster.to/<release-id>/index.html
```

A separate origin is what actually isolates a game from the cabinet (the
same-origin policy does the work); per-game subdomains also isolate games *from
each other* (no shared storage). This is **day one**, not deferred —
retrofitting origins/CSP/caching later lands exactly when the system is most
exposed.

**(b) Sandboxed iframe — with `allow-same-origin`, deliberately:**

```html
<iframe
  sandbox="allow-scripts allow-same-origin allow-pointer-lock"
  allow="autoplay; fullscreen; gamepad"
  src="https://<game-id>.arcade-games.oyster.to/<release-id>/index.html"></iframe>
```

- `allow-scripts allow-same-origin` is only dangerous when the iframe shares the
  *parent's* origin. On a separate subdomain it merely lets the game keep its
  **own** origin — normal `localStorage` / `fetch` for *its* assets — while the
  same-origin policy still walls it off from `arcade.oyster.to`. This is the
  standard user-code-hosting pattern (CodePen/JSFiddle), and it's what makes
  Tier 1 genuinely "any self-contained HTML game."
- **Omitted on purpose:** `allow-top-navigation` (can't hijack the cabinet),
  `allow-popups`, `allow-modals` (no `alert()` freeze / popup abuse). Capabilities
  in `allow=` are granted **per game from its validated `capabilities`**, not
  blanket. (The `allow-fullscreen` *sandbox token* is dropped — fullscreen rides
  the `allow=` / Permissions-Policy mechanism, not a sandbox flag.)

**(c) Server-imposed CSP** (response headers from the serving worker — *not* a
meta tag, which can't express `frame-ancestors`):

```
default-src 'none';
script-src  'self' https://shared.arcade.oyster.to 'wasm-unsafe-eval';
style-src   'self' 'unsafe-inline';
img-src     'self' data: blob:;
media-src   'self' data: blob:;
font-src    'self' https://shared.arcade.oyster.to;
connect-src 'self';            /* own-origin asset/WASM fetch only — no calling home */
worker-src  'self' blob:;
frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none';
frame-ancestors https://arcade.oyster.to;
```

`connect-src 'self'` (not `'none'`) so games that load level JSON / WASM via
`fetch` work, while external exfiltration stays blocked. `frame-ancestors` locks
embedding to the cabinet. (First-party games like invaders MP, which need
WebRTC/DO, live in `oyster` under their own looser policy — the trust tier, set in
the registry, decides the CSP.)

**Invariant — the close button is host-owned and unsuppressable.** The exit `×`
lives in the *parent* DOM, stacked above the iframe; a frozen or hostile game
cannot paint over it or swallow its click. A game ignoring `arcade-close` can
never trap the player. *(Already true in the cabinet today — codified here.)*

### 4. Host ↔ game protocol (`postMessage`)

The cabinet surface splits in two:

- **Local libs (in-iframe, harmless).** `Arcade.Audio / Music / Splash / Pause /
  Touch / Engine` — the game loads these itself; they only touch the game's *own*
  document. Safe under sandbox, optional to use.
- **Host services (mediated by the trusted parent).** Anything that touches shared
  backend state or the cabinet — leaderboard writes, close, persistence — goes
  over `postMessage` so the game *cannot spoof another game's data*. The host owns
  the real `game-id`; the game never asserts it.

**Game → host** (`window.parent.postMessage(msg, '*')`):

| `type` | Payload | Effect |
|---|---|---|
| `arcade-ready` | — | Game booted; host may fade the splash. |
| `arcade-close` | — | Return to the cabinet (today's behaviour). |
| `arcade-score` | `{ value:number }` | Host records under the real game-id leaderboard. |
| `arcade-state` | `{ blob:string }` | Optional host-persisted save state (for cross-device; purely-local saves can use the game's own `localStorage`). |
| `arcade-error` | `{ message }` | Host can surface a friendly "this game crashed". |

**Host → game** (`iframe.contentWindow.postMessage(msg, '*')`):

| `type` | Payload | Effect |
|---|---|---|
| `arcade-init` | `{ embedded:true, muted, state? }` | Sent on load; richer successor to `?embedded=1`. |
| `arcade-pause` / `arcade-resume` | — | Cabinet-driven pause (e.g. tab hidden). |

`?embedded=1` stays for back-compat; `arcade-init` is the structured path forward.

**Message security.** Because each game has a real subdomain origin (not the
opaque `null` an originless sandbox would produce), **both sides authenticate by
`event.origin`** — the host checks a message came from the launched game's
subdomain, the game checks host→game came from `arcade.oyster.to`. Day-one shape:
a versioned envelope `{ protocol:"oyster-arcade", v:1, type, payload }`, scores
validated as finite numbers, game-supplied error text rendered with `textContent`
(never HTML). *Designed-in now, built before opening up:* per-launch session
nonce, payload schemas + size/rate limits, and a dedicated `MessageChannel` port
handed over at `arcade-init` (retiring the global listener).

### 5. Identity, trust & releases

- **`gameId` vs `releaseId`.** `gameId` is the stable identity (folder name now;
  registry-assigned opaque id at self-serve). Each publish mints a fresh immutable
  `releaseId` (content hash) — that's what's in the served URL, so assets cache
  forever and rollback is instant.
- **Trust tier is server-assigned.** First-party vs contributed lives in the
  trusted registry, **never** in the author-controlled manifest — a manifest can't
  claim first-party to win the looser policy.
- **Collisions.** Now / gated: PR review + a validator uniqueness check on the
  folder name. Self-serve: the registry namespaces ids (the proven groovebox
  share-id pattern) so two `nuclear-testing-facility` submissions can't fight;
  `author` becomes a verified handle.

### 6. Publishing (atomic & immutable)

A merged manifest goes live through a defined transaction — no build-time fetch,
no half-published state:

1. **Validate** (compatibility lint + supply-chain hygiene — see below).
2. **Publish** the bundle under its immutable `releaseId` path.
3. **Verify** it loads under the real prod headers + sandbox.
4. **Flip** the registry pointer to the new `releaseId` atomically.
5. **Retain** the prior release for instant rollback.

Assets cache immutable (the `releaseId` is in the path); the registry is served
with ETags / short revalidation so a pointer flip is seen quickly. A **kill
switch** disables a game by flipping a registry flag — no delete, no redeploy.

---

## The `/install` flow

`arcade.oyster.to/install` is an **agent-readable contribution guide at a
well-known URL** (an `llms.txt`/`AGENTS.md` for the arcade) that hands over both
the **contract and the design guide**, and *strongly suggests* the agent port the
POC up to Tier 2 — with Tier 1 drop-in as an explicit, always-available fallback,
never a block. It's orthogonal to the backend — same URL at every stage:

- **Now / gated** → *"clone `oyster-to/arcade-games`, adopt the cabinet + design
  guide, scaffold the manifest, run `npx arcade-games validate <id>`, open a PR."*
- **Self-serve** → *"POST your validated bundle to `/api/games`."*

The intended loop, from a kid's machine:

```
kid: "put my game on the arcade"
agent: fetch arcade.oyster.to/install          → contract + design guide
       → PORT the POC up to Tier 2 (strongly suggested): adopt Arcade.* libs +
         design guide; fall back to Tier 1 drop-in only if a port is blocked
       → scaffold game.json (author → shown on the select screen) + thumb
       → run the validator (same checks the gate/upload API runs)
       → open the PR (or POST the bundle)
```

## Validation — compatibility lint + supply-chain hygiene (not the security layer)

Enforcement of no-network / no-cabinet-access is the **headers + sandbox**, not
the validator — static analysis can't *prove* runtime behaviour. `validate` is
**compatibility lint + supply-chain hygiene**, run identically by the author
locally, PR CI, and (later) the upload API, so "passes locally" = "will be
accepted." It checks:

- **Manifest:** schema, id format + folder-name match, length/control-char limits,
  entry + thumbnail exist, thumbnail well-formed and sized.
- **Compatibility:** loads under the prod preview; uses only its declared
  `capabilities`.
- **Supply-chain:** reject symlinks, submodules, Git-LFS pointers, zip/encoded
  path traversal, `<base>` elements, case-colliding filenames, wrong MIME types,
  excessive file counts / individual + decompressed sizes (zip-bomb guard).

**CI safety:** never run contributed code with secrets or via `pull_request_target`.
Run the *trusted* validator from the default branch with a read-only token, then
browser-smoke-test in the **production sandbox** with no privileged credentials.

---

## What to build first (foundation-right; gate stays manual)

Ordered; each a small, durable PR. The retrofit-expensive isolation is day-one;
the *additive* hardening is designed-in now, built before the gate opens.

1. **Data-driven registry.** Replace the hardcoded `GAMES` array with a
   `games.json` the cabinet fetches and renders — cards derived from manifests,
   including the **"by &lt;author&gt;" credit on the select screen** — not inline
   `<template>` previews. *Pure refactor of `index.html`.*
2. **Serving worker: per-game origin + CSP + immutable releases.** Stand up
   `*.arcade-games.oyster.to` serving `<release-id>/…` with the full CSP header
   set, the publish→verify→flip→rollback transaction, and the kill switch. *The
   isolation foundation — the thing you don't want to retrofit later.*
3. **Sandbox the iframe + host-mediate the leaderboard.** Apply the `sandbox` /
   `allow` policy and the host-owned-close invariant; give `shared/leaderboard.js`
   a sandboxed mode that posts scores over the bridge. *First-party games keep
   working through it.*
4. **Shared bundle (`shared.arcade.oyster.to/v1/…`) + design guide.** With canary +
   cross-game regression + rollback for the moving `v1` alias. *Makes Tier 2
   adoption + upgrades-on-pull possible.*
5. **Contract + `validate` + `arcade-games preview`, proven on Henry's game.** Take
   his POC all the way to **Tier 2** → manifest (with his author credit) → sandbox
   → validated → listed. First real end-to-end run; the framework PROOF in
   miniature.
6. **`/install` guide + `arcade-games` repo + PR CI** (read-only token, no
   `pull_request_target`). Wire the registry to read first-party + games-repo
   manifests.

**Designed-in now, built before opening past the trusted circle:** the message
hardening (nonce / schemas / rate-limits / `MessageChannel`), the deep
supply-chain lint, and **content moderation / reporting / takedown** — sandboxing
stops bad *code*, not bad *content*. The upload API + opaque self-serve ids come
with the self-serve flip.

## Open questions (for review)

- **Thumbnail vs live preview.** Today's cards use rich inline `<template>`
  previews; the portable contract is a static `thumb.png`. Anything we'd miss for
  contributed games? (First-party games could keep bespoke previews.)
- **Score trust.** Even host-mediated, a game reports its own score — cheatable.
  Fine for a family arcade; flag if leaderboards ever need to be real.
- **Upgrade pinning.** Major-pin (`v1`, auto-upgrade — recommended) vs exact-pin
  (frozen). Major-pin delivers "gets better over time"; the guardrail is canary +
  cross-game regression + instant rollback (§"How upgrades when it pulls in works").
- **First-party stays first-party.** Confirm invaders (WebRTC/DO) + groovebox
  simply remain first-party in `oyster`, served under their own looser policy,
  never subject to the contributed-game CSP.
- **Subdomain ops.** Per-game `*.arcade-games.oyster.to` needs wildcard DNS + cert
  + a routing worker. Confirm that's acceptable vs a single games origin with
  per-game *path* isolation (simpler, but games then share storage with each other
  — cabinet stays protected either way).
