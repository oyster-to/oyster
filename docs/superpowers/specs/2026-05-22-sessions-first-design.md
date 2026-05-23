# 1.0 first run: show sessions, hide setup

**Date:** 2026-05-22
**Status:** Approved 2026-05-22
**Author:** Matthew Slight + Claude
**Driver:** First-install test session in a clean macOS user account (`oystertestone`), 2026-05-22

---

## Product principle

> Oyster should not say "Set me up." It should say "Here is what your agents have been doing."

Oyster opens to your work. Setup is **present but not visually dominating**. The onboarding dock retains its four-item checklist (spaces, publish, MCP, memories) as a quiet entry point — but the pill itself stops shouting (no amber pulse, no "Set up Oyster" label). The required item is **Connect an agent (MCP)**, because driving Oyster from your existing Claude Code / Cursor / Windsurf is the central value prop.

The change is in **dominance**, not in **presence**. Setup affordances exist; they don't pollute the topbar.

## Why now

A cold-install test on 2026-05-22 surfaced that **the core product is already working** — sessions are auto-detected, Claude Code is identified, projects are inferred from folders, artefacts are collected, timestamps are visible. The data layer is correct.

What's broken is the UI hierarchy and language: "Set up Oyster" dominates the topbar, the home heading says *"Everything else."*, the topbar pill says *"Unsorted"*, the chat bar pre-fills with *"Set up Oyster"*. The user has already done the meaningful setup (installed Oyster, run real sessions), and the UI keeps asking them to do more.

This spec is about **stopping the UI apologising for itself** — exposing the already-shipped sessions-first model that the data layer has been doing all along.

## Assumption

User has Node.js 20+. Install is:

```bash
npm install -g oyster-os
oyster
```

`install.sh` / `install.md` improvements are tracked as separate work and not part of this spec.

## Desired 1.0 product behaviour

### 1. No provider gate

Do not ask for Anthropic / OpenAI / ChatGPT / OpenCode credentials on first boot. Oyster starts even with no AI provider configured.

**Acceptance:** Oyster must not spawn OpenCode, run `opencode providers login`, or show any provider picker unless the user explicitly chooses *Add chat provider*.

### 2. No setup wizard

No *"Set up Oyster"* as the dominant CTA. The user has already installed and run Oyster — treat that as setup enough.

### 3. Home shows sessions first

Default screen:

```
Recent sessions
[session cards / table]
```

Primary CTAs visible on Home:

- **Start new session**
- **Resume recent session**

Not *"Everything else"*, not *"Set up your first space"*, not *"Unsorted"*.

### 4. Auto-discover work

**Required for 1.0:**
- Read existing Claude Code session history from `~/.claude/projects/**`
- Show detected sessions immediately on Home

**Nice-to-have (not blocking 1.0):**
- Opportunistic folder scan of `~/Dev/**`, `~/Projects/**`, and the current working directory

The 1.0 scope is *consume the Claude Code data we already know is there*, not *build new filesystem discovery*.

### 5. Spaces are optional

Spaces are just organisation, later. First-run copy implies *"Your work is here. Organise it later if useful."* — not *"You need to set up spaces before Oyster is useful."*

### 6. Chat bar is optional

If no chat provider exists, the chat bar should not break or gate the app. Show either an *"Add chat provider"* affordance, or hide it quietly.

### 7. MCP stays in onboarding — quietly

MCP is the **required** item in the dock. The dock retains four items: spaces, publish, MCP, memories. The pill itself is neutralised (no amber pulse, no "Set up Oyster" label) so onboarding doesn't dominate. Users see their sessions immediately; the dock is a quiet 🦪 icon they can open if they want.

Wording shift on the MCP item:

```
title: "Connect an agent"
desc:  "Drive Oyster from Claude Code, Cursor, VS Code or Windsurf."
actionLabel: "Connect"
required: true
```

Framing: the onboarding affordance exists; it just stops shouting.

## Three first-run states

### A — Sessions found (best case)

```
Recent sessions
Resume / inspect / publish / manage
```

No setup UI.

### B — No sessions found

```
No sessions found yet.

Start a Claude Code session in a project. Oyster will pick it up automatically.
```

Optional secondary action: *"Choose folders to scan"*.

### C — No agent installed (rare for the 1.0 ICP)

The user has no Claude Code (or other supported agent) on this machine. Don't block. Show:

```
Oyster works alongside Claude Code, Cursor, and other AI coding agents.
Install one to see your sessions here.
```

Link out to docs explaining how to install an agent. The dock's "Connect an agent" item still appears in the checklist — but the empty-state copy frames the prerequisite ("install one first").

## Concrete 1.0 change list

1. Remove `runLogin()` / OpenCode auth gate from `bin/oyster.mjs`.
2. Let server / browser launch unconditionally.
3. Make "Recent sessions" the home / default view.
4. Rename "Everything else" to "Recent sessions" (or "All work").
5. Rename "Unsorted" → **All**. (Both views — default Home and the elsewhere-pill view — show the same heading "Recent sessions." The pill itself is the scope selector.)
6. Remove "Click + to set up your first space".
7. Demote or remove the "Set up Oyster" pill.
8. Hide / disable chat input cleanly when no provider exists.
9. Make spaces appear only as an organising / filtering feature.
10. Add a quiet empty state for "no sessions found".

## Out of scope (1.1+)

- Topics / tags / faceting across projects + spaces
- Data model refactor (sessions-as-unit table, spaces/projects as facets)
- In-Oyster HTML provider picker (replaces OpenCode TUI handoff for the chat bar)
- Auto-detect existing Claude Code / Cursor / Windsurf credentials
- Native binary distribution (Bun-compiled, signed, notarised)
- `install.sh` / `install.md` improvements (separate spec)
- Empty-state coach-mark (#312 in roadmap — reassess after 1.0 lands)

## Risks

1. **Existing users with the chat bar in active use** — they currently authenticate OpenCode in the TUI on first boot. Post-pivot, that auth path still works (TUI still exists, runnable via `opencode auth login`), but isn't forced. Behaviour for users who *already* have `~/.local/share/opencode/auth.json` is unchanged — the chat bar keeps working.
2. **The chat bar surface area when no provider is configured** — needs a graceful no-provider state. Risk that some code paths assume `provider != null` and break loudly. Mitigation: grep for `provider` / `model` / `opencode` server-side and add guards.
3. **Discoverability of organising features** — by making spaces optional and demoting them, users who *would* benefit from organisation may not find it. Mitigation: a small "Organise" affordance in the topbar or sessions view, ambient not blocking.
4. **CHANGELOG.md entry** — this is a user-visible behavioural change. Needs an entry under *Changed* in the same PR. Per existing project rule: terse, user-facing only.

## Rollout

- **Single coordinated PR.** Partial rollouts (e.g. auth gate removed but UI still says "Set up Oyster") produce a worse intermediate state.
- **CHANGELOG entry** under *Changed*:
  > **Oyster opens to your work, not to a setup wizard.** First launch no longer requires an AI provider, no longer demands you create a space, and shows your sessions on the home screen immediately. Set-up surfaces only appear when something is genuinely missing.
- **Version bump:** 1.0.0 (semantic-major — this is the launch SKU).
- **No data migration needed.** Schema stays as-is.

## Test plan

1. **Re-run the cold-install test from 2026-05-22 in `oystertestone`** (or a fresh equivalent). Verify:
   - `oyster` starts immediately, no provider prompt
   - Browser opens at `http://localhost:4444`
   - Home shows real session data (from `oystertestone`'s existing Claude Code work)
   - No "Set up Oyster" pill dominating, no "Set up your first space" copy
2. **MCP is the required dock item.** The dock's checklist has "Connect an agent" as the one required item, with the action label "Connect" that surfaces the per-client copy-paste command (Claude Code / Cursor / VS Code / Windsurf).
3. **The dock pill is neutralised.** No amber pulse, no "Set up Oyster" label — just a quiet 🦪 icon that opens the checklist on click. The auto-tick from `mcp_client_connected` SSE event still works.
4. **Chat bar with no provider** — shows "Add chat provider" affordance or hides cleanly. Doesn't error.
5. **Chat bar with provider configured** (existing user case) — works as today, unchanged.
6. **Empty home (state B)** — when no sessions found, the empty state reads as *"Start a session. Oyster will pick it up automatically."*, not *"You haven't set up Oyster"*.
7. **Spaces are findable but optional** — user can create / use / ignore them without onboarding pressure.
8. **Fresh user with no Claude sessions** (true zero-data path):
   - Oyster still opens
   - No setup wizard
   - Empty state is calm
   - Start-session CTA is visible

## Decision log

- *2026-05-22 — Spec rescoped from "MCP-first onboarding" to "sessions-first simplification".* MCP is implementation detail; the user benefit is *"open Oyster and see the work your agents have already done."*
- *2026-05-22 — Decided A (ship simplification for 1.0) over slipping for full data-model refactor.* Test evidence showed the data layer already supports the desired UX; only the UI needs to stop apologising. ~1-2 days of work, not 3 weeks.
- *2026-05-22 — Install path improvements (install.sh, install.md fixes) split into a separate spec.* This spec focuses purely on first-run product behaviour after `oyster` is on PATH.
- *2026-05-22 — MCP demoted from "small first-run affordance" to "post-onboarding discovery".* (Superseded same day — see next entry.)
- *2026-05-22 — MCP reinstated as the **required** dock item.* The earlier "MCP is post-onboarding" framing went too far: keeping a four-item dock with MCP at the centre is more honest to Oyster's value prop. The fix is in **dominance** (neutralised pill, no amber pulse, no "Set up Oyster" label) — not in **presence** (the items themselves stay). Single required item: MCP. Spaces / publish / memories remain optional.
- *2026-05-22 — "Unsorted" → "All" not "Loose".* Both home views use the same heading "Recent sessions." The pill is the scope selector.
