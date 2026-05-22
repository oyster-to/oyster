# 1.0 first run: show sessions, hide setup

**Status:** Approved 2026-05-22
**Author:** Matthew Slight + Claude
**Driver:** First-install test session in a clean macOS user account (`oystertestone`), 2026-05-22

## Product principle

> Oyster should not say "Set me up." It should say "Here is what your agents have been doing."

Oyster opens to your work. Setup is only there if something is missing.

## Why now

A cold-install test on 2026-05-22 surfaced that **the core product is already working** — sessions are auto-detected, Claude Code is identified, projects are inferred from folders, artefacts are collected, timestamps are visible. The data layer is correct.

What's broken is the UI hierarchy and language: "Set up Oyster" dominates the topbar, the home heading says *"Everything else."*, the topbar pill says *"Unsorted"*, the chat bar pre-fills with *"Set up Oyster"*. The user has already done the meaningful setup (installed Oyster, run real sessions), and the UI keeps asking them to do more.

This spec is about **stopping the UI apologising for itself** — exposing the already-shipped sessions-first model that the data layer has been doing all along.

## Assumption

User has Node + npm. Install is:

```bash
npm install -g oyster-os
oyster
```

`install.sh` / `install.md` improvements are tracked as separate work and not part of this spec.

## Desired 1.0 product behaviour

### 1. No provider gate

Do not ask for Anthropic / OpenAI / ChatGPT / OpenCode credentials on first boot. Oyster starts even with no AI provider configured.

**Acceptance:** Oyster must not spawn OpenCode, run `opencode auth login`, or show any provider picker unless the user explicitly chooses *Add chat provider*.

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

### 7. MCP / agent connection is helpful, not required

Show a small *"Use with Claude Code"* affordance. Do not make it a required onboarding step.

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

### C — No agent integration detected

Still do not block. Show:

```
Oyster works best with Claude Code, Cursor, or another MCP-capable agent.
```

Small CTA: *"Connect an agent"*.

## Concrete 1.0 change list

1. Remove `runLogin()` / OpenCode auth gate from `bin/oyster.mjs`.
2. Let server / browser launch unconditionally.
3. Make "Recent sessions" the home / default view.
4. Rename "Everything else" to "Recent sessions" (or "All work").
5. Rename "Unsorted" — choose by what the pill actually represents:
   - If it truly shows everything → **All**
   - If it only shows unassigned work → **Recent**
   - If no spaces exist → **hide the pill entirely**
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
2. **Connect Claude Code via MCP** (still works — verify the dock auto-tick via `mcp_client_connected` still fires).
3. **Chat bar with no provider** — shows "Add chat provider" affordance or hides cleanly. Doesn't error.
4. **Chat bar with provider configured** (existing user case) — works as today, unchanged.
5. **Empty home (state B)** — when no sessions found, the empty state reads as *"Start a session, then refresh"*, not *"You haven't set up Oyster"*.
6. **Spaces are findable but optional** — user can create / use / ignore them without onboarding pressure.
7. **Fresh user with no Claude sessions** (true zero-data path):
   - Oyster still opens
   - No setup wizard
   - Empty state is calm
   - Start-session CTA is visible

## Decision log

- *2026-05-22 — Spec rescoped from "MCP-first onboarding" to "sessions-first simplification".* MCP is implementation detail; the user benefit is *"open Oyster and see the work your agents have already done."*
- *2026-05-22 — Decided A (ship simplification for 1.0) over slipping for full data-model refactor.* Test evidence showed the data layer already supports the desired UX; only the UI needs to stop apologising. ~1-2 days of work, not 3 weeks.
- *2026-05-22 — Install path improvements (install.sh, install.md fixes) split into a separate spec.* This spec focuses purely on first-run product behaviour after `oyster` is on PATH.
