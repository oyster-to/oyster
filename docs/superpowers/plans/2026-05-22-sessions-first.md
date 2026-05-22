# 1.0 first run: show sessions, hide setup — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Strip the first-run setup story so Oyster opens directly to the user's sessions. No AI provider gate, no setup wizard dominating the UI, no MCP nudges in first-run, no "Click + to set up your first space" copy. The data layer already works — this plan removes the UI that's asking the user to do setup they've already done.

**Architecture:** Pure UI + CLI changes. No schema migration, no data model refactor. The OnboardingDock, ChatBar, Home view, and CLI welcome banner all get tightened or stripped. One new server endpoint (`/api/chat/provider-status`) feeds the chat bar's graceful no-provider state.

**Tech Stack:** Node.js (CLI bin), TypeScript + React (web/), Express-style routes (server/), vitest (server tests). Web has no test framework — UI changes verified via `tsc -b`, `eslint .`, and manual browser inspection.

**Spec:** `docs/superpowers/specs/2026-05-22-sessions-first-design.md`

---

## File Structure

**Files modified:**
- `bin/oyster.mjs` — Strip auth gate (lines 367-396)
- `web/src/components/ChatBar.tsx` — Drop "Set up Oyster" hero CTA; consume provider-status
- `web/src/components/Home/index.tsx` — Headings, subtitle, "Unsorted" pill
- `web/src/components/OnboardingDock.tsx` — Neutralize pill, restructure items
- `server/src/index.ts` — New `/api/chat/provider-status` route
- `CHANGELOG.md` — User-visible behaviour change entry
- `package.json` — Version 0.9.8 → 1.0.0

**Files created:**
- `server/test/provider-status-route.test.ts` — TDD for the new server endpoint

---

## Task 1: Strip the AI provider gate from `bin/oyster.mjs`

**Files:**
- Modify: `bin/oyster.mjs` (lines 367-396 — the `main()` function's auth-check block)

**Goal:** Oyster boots and starts the server unconditionally. Never spawns `opencode auth login`. The `hasAuth()` and `runLogin()` function definitions stay (they'll be reused for opt-in chat-bar setup) — we just stop calling them at boot.

- [ ] **Step 1: Read the current `main()` function**

Run: `sed -n '365,400p' bin/oyster.mjs` to confirm the exact block.

Expected output includes lines like:
```js
if (!hasEnvKey && !hasAuth()) {
  console.log("\n  🦪 Welcome to Oyster");
  ...
  const ok = await runLogin(opencodeBin);
  if (!ok || !hasAuth(opencodeBin)) {
    console.log("\n  No provider configured. Run `oyster` again to retry.\n");
    process.exit(1);
  }
  console.log("\n  Provider connected. Starting Oyster...\n");
}
```

- [ ] **Step 2: Delete the auth-check block**

Replace the block (currently lines 375-390 in `bin/oyster.mjs`, starting with `// Skip auth check if any provider API key is in env` and ending with the closing `}` of the `if (!hasEnvKey && !hasAuth())` block) with:

```js
// No auth gate. The server starts unconditionally — provider auth
// (OpenCode TUI / API key / OAuth) is only needed if the user opts
// into the in-Oyster chat bar later. Keep hasAuth() + runLogin()
// defined above; the chat-bar "Add chat provider" affordance can
// reuse them when the user explicitly chooses to wire one up.
```

- [ ] **Step 3: Verify type / syntax**

Run: `node --check bin/oyster.mjs`
Expected: no output (success).

- [ ] **Step 4: Manual smoke test — server starts with no opencode auth**

Run (in a shell with no `~/.local/share/opencode/auth.json` present, or by temporarily renaming it):
```bash
mv ~/.local/share/opencode/auth.json ~/.local/share/opencode/auth.json.bak 2>/dev/null
node bin/oyster.mjs
```

Expected: server starts and prints `🦪 Starting Oyster...` followed by the listening URL. No "First, let's connect an AI provider." prompt. No `opencode providers login` spawned.

Then restore:
```bash
mv ~/.local/share/opencode/auth.json.bak ~/.local/share/opencode/auth.json 2>/dev/null
```

Ctrl-C to stop the server.

- [ ] **Step 5: Commit**

```bash
git add bin/oyster.mjs
git commit -m "feat(cli): remove AI provider gate from oyster boot

Oyster starts the server unconditionally now. opencode provider auth
(API key / OAuth / TUI) becomes an opt-in path for the in-Oyster chat
bar, not a boot prerequisite.

hasAuth() + runLogin() stay defined for the future Add chat provider
affordance in the chat bar."
```

---

## Task 2: Drop the "Set up Oyster" hero CTA from ChatBar

**Files:**
- Modify: `web/src/components/ChatBar.tsx` (lines 491-510 — the `isFirstRun` branch of the hero tagline)

**Goal:** First-run users see the same neutral hero tagline as everyone else. No "Ask: Set up Oyster" button.

- [ ] **Step 1: Read the current hero tagline block**

Open `web/src/components/ChatBar.tsx` and locate the `{isHero && (() => {` block starting around line 484.

- [ ] **Step 2: Replace the `isFirstRun` branch**

Find this block (lines ~491-510):

```tsx
{isFirstRun ? (
  <>
    <span className="tagline-bright">Welcome to your surface.</span>
    <div className="chatbar-hero-sub">
      Ask:{" "}
      <button
        type="button"
        className="chatbar-hero-prompt"
        onClick={() => handleSend("Set up Oyster")}
        disabled={streaming}
        tabIndex={taglineHidden ? -1 : 0}
        title="Click to send, or type it yourself"
      >
        Set up Oyster
      </button>
    </div>
  </>
) : tagline ? (
```

Replace with:

```tsx
{tagline ? (
```

(i.e. drop the entire `isFirstRun ? ... : ` ternary. The `tagline` / default fallback branches stay.)

- [ ] **Step 3: Remove the now-unused `isFirstRun` prop**

In the `Props` type (line ~99) and the function signature (line ~103), remove `isFirstRun?: boolean;` and the destructured `isFirstRun`.

- [ ] **Step 4: Remove `isFirstRun` pass-through from caller**

In `web/src/App.tsx` line ~866, find `<ChatBar ... isFirstRun={isFirstRun} ... />` and remove the `isFirstRun={isFirstRun}` prop. The local `isFirstRun` variable in App.tsx (line 317) stays — it's still used to gate `isHero` for hero positioning.

- [ ] **Step 5: Type check**

Run: `cd web && npx tsc -b`
Expected: no errors. (If there are errors, the prop wasn't removed cleanly — re-check.)

- [ ] **Step 6: Lint check**

Run: `cd web && npm run lint`
Expected: no new errors.

- [ ] **Step 7: Commit**

```bash
git add web/src/components/ChatBar.tsx web/src/App.tsx
git commit -m "feat(chat): drop Set up Oyster hero CTA

First-run users now see the same neutral hero tagline as everyone else.
The Set up Oyster button was pre-filling the chat input with a prompt
that demanded setup of a concept (spaces) the user doesn't need to
derive value from Oyster. isFirstRun prop removed from ChatBar; the
App-level variable stays as it still gates hero positioning."
```

---

## Task 3: Update Home headings + drop instructional subtitle

**Files:**
- Modify: `web/src/components/Home/index.tsx` (line 880 — `h1` heading; lines 888-896 — subtitle block)

**Goal:** "Everything active." → quieter. "Everything else." → quieter. Drop the "Click [+] on a tile to set up your first space" first-run teaching line entirely.

- [ ] **Step 1: Replace the home title line**

Find line 880:
```tsx
<h1 className="home-title">{isHomeView ? (showElsewhere ? "Everything else." : "Everything active.") : eyebrow}</h1>
```

Replace with:
```tsx
<h1 className="home-title">{isHomeView ? "Recent sessions." : eyebrow}</h1>
```

(Both Home views — default and elsewhere-pill — show the same heading. The pill selection in the breadcrumb is the scope cue; the heading is the page identity.)

- [ ] **Step 2: Delete the first-run teaching subtitle block**

Find lines 881-896 (starting with `{/* First-run teaching line on Unsorted: ...`) and delete the entire block:

```tsx
{/* First-run teaching line on Unsorted: orphan tiles look passive,
    so point at the per-tile affordance. With zero spaces the action
    is *creating* one (the popover says "promote this folder"), not
    attaching — so frame as "set up". Drops once any real space
    exists; by then the user has met the model. Inlines the actual
    FolderPlus glyph (size + stroke matches the tile button) so the
    instruction visually points at exactly the icon to click. */}
{isHomeView && showElsewhere && realSpaces.length === 0 && (
  <div className="home-subtitle">
    Click the
    {" "}
    <FolderPlus size={14} strokeWidth={2} role="img" aria-label="folder plus" className="home-subtitle-glyph" />
    {" "}
    on a tile to set up your first space.
  </div>
)}
```

- [ ] **Step 3: Check if `FolderPlus` import is still used**

Run: `grep -n "FolderPlus" web/src/components/Home/index.tsx`

Expected: still used elsewhere (the project-tile attach button). If not used anymore, remove from the lucide-react import line.

- [ ] **Step 4: Type check + lint**

Run: `cd web && npx tsc -b && npm run lint`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/Home/index.tsx
git commit -m "feat(home): consolidate Home heading; drop setup teaching subtitle

Everything active. / Everything else. → Recent sessions. (single
heading for both Home sub-views; the breadcrumb pill is the scope cue).

The Click [+] on a tile to set up your first space subtitle is gone.
It demanded setup before the user could derive value; per the spec,
spaces are organise-when-you-want, not a first-run gate."
```

---

## Task 4: Rename "Unsorted" pill → "All"

**Files:**
- Modify: `web/src/components/Home/index.tsx` (line 853 — pill label; line 731 — eyebrow ternary)

**Goal:** Per spec item 5 — rename the "Unsorted" pill to **All**. The pill stays visible whenever there are orphan sessions (no conditional hide).

- [ ] **Step 1: Rename pill label "Unsorted" → "All"**

Find line 853:
```tsx
<span className="home-breadcrumb-pill-label">Unsorted</span>
```

Replace with:
```tsx
<span className="home-breadcrumb-pill-label">All</span>
```

- [ ] **Step 2: Update eyebrow ternary**

Find line 731:
```tsx
const eyebrow = isHomeView ? (showElsewhere ? "Unsorted" : "Home")
```

Replace with:
```tsx
const eyebrow = isHomeView ? (showElsewhere ? "All" : "Home")
```

- [ ] **Step 3: Type check + lint**

Run: `cd web && npx tsc -b && npm run lint`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add web/src/components/Home/index.tsx
git commit -m "feat(home): rename Unsorted → All

Unsorted sounded like a chore. 'All' is the user-facing name for what
the elsewhere bucket actually represents — sessions outside any space."
```

---

## Task 5: Neutralise the OnboardingDock pill — keep the 4 items

**Files:**
- Modify: `web/src/components/OnboardingDock.tsx` (lines 88-117 — `ITEMS` array; lines 277-296 — pill render; lines 268-275 — dock button aria-label; line 260 — `requiredDone` derivation)

**Goal:** The dock retains its four-item checklist (spaces, publish, MCP, memories). MCP becomes the **required** item (was optional). Spaces drops to optional. The pill itself stops dominating: no amber pulse, no "Set up Oyster" label — just a quiet 🦪 icon that opens the checklist on click.

`McpConnect`, `CLIENT_CONFIGS`, the `mcp_client_connected` SSE listener, the `/api/mcp/status` REST fallback — **all kept**. The auto-tick when an agent connects still works.

- [ ] **Step 1: Restructure `ITEMS` array — rewording, required flip**

Find lines 88-117 and replace the entire `ITEMS` array:

```tsx
// Order matters: required first, then optionals in install-friction order
// (publish = no install; MCP = config edit; memories = external AI roundtrip).
const ITEMS: ChecklistItem[] = [
  {
    key: "spaces",
    title: "Set up your spaces",
    required: true,
    desc: "Let Oyster scan your dev folders and group your work into spaces.",
    actionLabel: "Set up Oyster",
  },
  {
    key: "publish",
    title: "Publish your first artefact",
    required: false,
    desc: "Make a thing in chat, click Publish — get a share URL.",
    actionLabel: "Show me how",
  },
  {
    key: "mcp",
    title: "Connect another agent (MCP)",
    required: false,
    desc: "Drive Oyster from Claude Code, Cursor, VS Code or Windsurf.",
    actionLabel: "Show me how",
  },
  {
    key: "memories",
    title: "Import memories",
    required: false,
    desc: "Bring memories from ChatGPT or Claude into Oyster.",
    actionLabel: "Show me how",
  },
];
```

with:

```tsx
// MCP is the required item — driving Oyster from your existing agent
// is the central value prop. Spaces / publish / memories are optional
// discoverable extras. Order: required first, then optionals roughly
// by install-friction.
const ITEMS: ChecklistItem[] = [
  {
    key: "mcp",
    title: "Connect an agent",
    required: true,
    desc: "Drive Oyster from Claude Code, Cursor, VS Code or Windsurf.",
    actionLabel: "Connect",
  },
  {
    key: "spaces",
    title: "Organise into spaces",
    required: false,
    desc: "Group your work into spaces — useful once you have a few projects on the go.",
    actionLabel: "Organise",
  },
  {
    key: "publish",
    title: "Publish your first artefact",
    required: false,
    desc: "Make a thing in chat, click Publish — get a share URL.",
    actionLabel: "Show me how",
  },
  {
    key: "memories",
    title: "Import memories",
    required: false,
    desc: "Bring memories from ChatGPT or Claude into Oyster.",
    actionLabel: "Show me how",
  },
];
```

- [ ] **Step 2: Keep `ItemKey` / `OnboardingState` / `COMPLETE_KEY` / `allDone` unchanged**

These all stay as they are (4-item union, 4 completion fields). Verify the existing definitions look like:

```tsx
type ItemKey = "spaces" | "publish" | "mcp" | "memories";

interface OnboardingState {
  spacesComplete: boolean;
  publishComplete: boolean;
  mcpComplete: boolean;
  memoriesComplete: boolean;
}
```

No code change in this step — just confirmation.

- [ ] **Step 3: Flip the required-derive from spaces → MCP**

Find (around line 260):

```tsx
const done = allDone(state);
const requiredDone = state.spacesComplete;
```

Replace with:

```tsx
const done = allDone(state);
const requiredDone = state.mcpComplete;
```

- [ ] **Step 4: Keep the MCP auto-tick effects** (no code change in this step — just confirmation)

The REST `/api/mcp/status` effect (lines 170-182) and the SSE `mcp_client_connected` listener (lines 186-190) **stay in place**. Both auto-tick `mcpComplete` when an agent connects. No change.

Also keep `McpConnect` component (lines 457-533), `CLIENT_CONFIGS` / `CLIENT_TABS` / `ClientKey` constants (lines 5-53), and the `view.kind === "step" && view.key === "mcp"` render branch. All stay.

- [ ] **Step 5: Keep the spaces auto-tick — but its meaning shifts**

The `userSpaceCount` auto-tick (line 195-198) stays. With spaces now optional, this tick contributes to the all-done 🦪 state but isn't gating the `requiredDone` derivation any more.

No change in this step — just confirmation.

- [ ] **Step 6: Neutralise the pill — drop "Set up Oyster" label + amber pulse**

Find the pill render around lines 277-297:

```tsx
{/* Three pill states. Pre-required: amber pulsing dot + "Set up
    Oyster", attention-grabbing. Post-required-with-optionals-pending:
    purple pill (matches "+ New session") with a gold ◐ half-circle
    glyph — the glyph is the only state cue; the pill stays quiet so
    it doesn't out-shout the active space pill. All-done: chrome
    drops away and only the 🦪 oyster remains — silent on-brand
    confirmation, the "you found your pearl" moment. */}
{!requiredDone && <span className="onboarding-dock-progress" />}
{requiredDone && !done && <span className="onboarding-dock-mid-glyph" aria-hidden="true">◐</span>}
{done && (
  <span className="onboarding-dock-check" role="img" aria-label="Setup complete">
    🦪
  </span>
)}
{!done && (
  <span className="onboarding-dock-label">
    {requiredDone ? "Continue setup" : "Set up Oyster"}
  </span>
)}
```

Replace with:

```tsx
{/* Neutralised pill. No amber pulse, no "Set up Oyster" label, no
    state cue — just a quiet 🦪 icon that opens the checklist. The
    items themselves (spaces, publish, MCP, memories) stay in the
    popover; the pill stops shouting to discover them. */}
<span className="onboarding-dock-check" role="img" aria-hidden="true">
  🦪
</span>
```

- [ ] **Step 7: Update the dock button `aria-label`**

Find the dock button (line 268):

```tsx
aria-label={
  done
    ? "Oyster setup complete"
    : requiredDone
      ? "Continue Oyster setup"
      : "Set up Oyster"
}
```

Replace with:

```tsx
aria-label="Onboarding checklist"
```

- [ ] **Step 8: Type check + lint**

Run: `cd web && npx tsc -b && npm run lint`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add web/src/components/OnboardingDock.tsx
git commit -m "feat(dock): neutralise pill; MCP becomes the required item

The dock pill stops dominating: no amber pulse, no Set up Oyster label,
no state glyph — just a quiet 🦪 icon that opens the checklist on
click. The four items (spaces, publish, MCP, memories) stay, just
quieter.

Required flips: MCP is now required (it is the central value prop —
drive Oyster from your existing agent), spaces drops to optional
('Organise into spaces' — useful once you have a few projects on the
go). McpConnect component, CLIENT_CONFIGS, /api/mcp/status REST
fallback, and mcp_client_connected SSE listener all stay — the
auto-tick when an agent connects is unchanged."
```

---

## Task 6: Add server endpoint `/api/chat/provider-status`

**Files:**
- Create: `server/test/provider-status-route.test.ts`
- Modify: `server/src/index.ts` (add new route)

**Goal:** The chat bar needs to know whether OpenCode has an auth.json before deciding to render the input vs an "Add chat provider" affordance. This endpoint exposes that.

- [ ] **Step 1: Write the failing test**

Create `server/test/provider-status-route.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The route reads ~/.local/share/opencode/auth.json. To test deterministically
// we point HOME at a temp dir, then assert the route's response by importing
// the handler in isolation rather than booting the full server.
import { getProviderStatus } from "../src/routes/provider-status.js";

describe("provider-status", () => {
  let tmpHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "oyster-provider-status-"));
    originalHome = process.env.HOME;
    process.env.HOME = tmpHome;
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
  });

  it("returns configured: false when auth.json is absent", () => {
    expect(getProviderStatus()).toEqual({ configured: false });
  });

  it("returns configured: false when auth.json is empty object", () => {
    const authDir = join(tmpHome, ".local", "share", "opencode");
    mkdirSync(authDir, { recursive: true });
    writeFileSync(join(authDir, "auth.json"), "{}");
    expect(getProviderStatus()).toEqual({ configured: false });
  });

  it("returns configured: true when auth.json has at least one provider", () => {
    const authDir = join(tmpHome, ".local", "share", "opencode");
    mkdirSync(authDir, { recursive: true });
    writeFileSync(join(authDir, "auth.json"), JSON.stringify({ anthropic: { api: "sk-..." } }));
    expect(getProviderStatus()).toEqual({ configured: true });
  });

  it("returns configured: false when auth.json is malformed", () => {
    const authDir = join(tmpHome, ".local", "share", "opencode");
    mkdirSync(authDir, { recursive: true });
    writeFileSync(join(authDir, "auth.json"), "not json");
    expect(getProviderStatus()).toEqual({ configured: false });
  });

  it("returns configured: true when ANTHROPIC_API_KEY is in env (env-key bypass)", () => {
    const originalKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-test";
    try {
      expect(getProviderStatus()).toEqual({ configured: true });
    } finally {
      if (originalKey !== undefined) process.env.ANTHROPIC_API_KEY = originalKey;
      else delete process.env.ANTHROPIC_API_KEY;
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && npx vitest run test/provider-status-route.test.ts`
Expected: FAIL with `Cannot find module '../src/routes/provider-status'`.

- [ ] **Step 3: Create the route module**

Create `server/src/routes/provider-status.ts`:

```ts
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Mirror of bin/oyster.mjs's hasAuth() + env-key check. Returns whether
// the chat bar can spawn a useful OpenCode session, which is the only
// thing the client uses this signal for. Cheap (one stat / one tiny read)
// so the chat bar can fetch on mount without latency concerns.
export function getProviderStatus(): { configured: boolean } {
  if (
    process.env.ANTHROPIC_API_KEY ||
    process.env.OPENAI_API_KEY ||
    process.env.GOOGLE_API_KEY ||
    process.env.GEMINI_API_KEY
  ) {
    return { configured: true };
  }
  const authFile = join(homedir(), ".local", "share", "opencode", "auth.json");
  if (!existsSync(authFile)) return { configured: false };
  try {
    const data = JSON.parse(readFileSync(authFile, "utf8"));
    return { configured: Object.keys(data).length > 0 };
  } catch {
    return { configured: false };
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server && npx vitest run test/provider-status-route.test.ts`
Expected: PASS — all 5 tests green.

- [ ] **Step 5: Wire the route into `server/src/index.ts`**

Add this import near the top with the other route imports (around line 36-50):

```ts
import { getProviderStatus } from "./routes/provider-status.js";
```

Find the route registration block in `server/src/index.ts` (search for an existing simple JSON route — e.g. `/api/mcp/status`). Below it, add:

```ts
if (url.pathname === "/api/chat/provider-status" && req.method === "GET") {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(getProviderStatus()));
  return;
}
```

(Adjust to match the exact route-dispatch style used by the file — check whether it uses `if (url.pathname === ...)` or a router object, and mirror that pattern.)

- [ ] **Step 6: Build the server to verify**

Run: `cd server && npm run build`
Expected: no errors.

- [ ] **Step 7: Smoke-test the endpoint**

Start the server (`cd server && npm run dev`), then in another shell:

```bash
curl -s http://localhost:3333/api/chat/provider-status
```

Expected: a JSON response like `{"configured":true}` (if you have opencode auth set up) or `{"configured":false}` (if not).

Ctrl-C the server when done.

- [ ] **Step 8: Commit**

```bash
git add server/src/routes/provider-status.ts server/test/provider-status-route.test.ts server/src/index.ts
git commit -m "feat(server): add /api/chat/provider-status endpoint

Reports whether OpenCode has provider auth configured (auth.json with
non-empty keys, or one of ANTHROPIC_API_KEY / OPENAI_API_KEY /
GOOGLE_API_KEY / GEMINI_API_KEY in env). The chat bar uses this to
decide between rendering the input (provider exists) or an Add chat
provider affordance (no provider).

TDD: 5 vitest cases cover absent / empty / valid / malformed auth.json
and the env-key bypass."
```

---

## Task 7: ChatBar — graceful no-provider state

**Files:**
- Modify: `web/src/components/ChatBar.tsx` (add provider-status fetch + conditional render)

**Goal:** When no provider is configured, the chat bar renders a calm "Add chat provider" affordance instead of the input. When configured, it renders the input as today.

- [ ] **Step 1: Add a provider-status hook at the top of `ChatBar`**

In `ChatBar.tsx`, find the existing `useState` block (around line 103-130) and add after the existing state:

```tsx
const [providerConfigured, setProviderConfigured] = useState<boolean | null>(null);

useEffect(() => {
  let cancelled = false;
  fetch("/api/chat/provider-status")
    .then((r) => (r.ok ? r.json() : { configured: false }))
    .then((data) => { if (!cancelled) setProviderConfigured(Boolean(data.configured)); })
    .catch(() => { if (!cancelled) setProviderConfigured(false); });
  return () => { cancelled = true; };
}, []);
```

- [ ] **Step 2: Render conditional UI for the no-provider state**

Find the input render block (around line 705-720 — the `<textarea ... className="chatbar-input" ...>` element). Wrap it in a conditional. The simplest approach: replace the input area's render with:

```tsx
{providerConfigured === false ? (
  <div className="chatbar-add-provider">
    <span className="chatbar-add-provider-text">No chat provider yet.</span>
    <a
      href="https://oyster.to/docs/chat-provider"
      target="_blank"
      rel="noopener noreferrer"
      className="chatbar-add-provider-link"
    >
      Add chat provider →
    </a>
  </div>
) : (
  /* existing textarea + send-button JSX */
)}
```

Wrap the existing input markup in the `else` branch. When `providerConfigured === null` (still loading), the original input renders (treat unknown as configured to avoid a flash of empty state).

- [ ] **Step 3: Add minimal styles for the no-provider state**

In `web/src/components/ChatBar.css` (or wherever `chatbar-input` is styled), add:

```css
.chatbar-add-provider {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 18px;
  background: rgba(20, 21, 42, 0.5);
  border: 1px dashed rgba(124, 107, 255, 0.3);
  border-radius: 12px;
  color: rgba(232, 233, 240, 0.66);
  font-size: 13px;
}
.chatbar-add-provider-text {
  flex: 1;
}
.chatbar-add-provider-link {
  color: #9b8cff;
  text-decoration: none;
  font-weight: 500;
}
.chatbar-add-provider-link:hover {
  text-decoration: underline;
}
```

(If the CSS lives in a different file — e.g. a global `App.css` — adjust accordingly. `grep -rn "chatbar-input" web/src/` will find it.)

- [ ] **Step 4: Type check + lint**

Run: `cd web && npx tsc -b && npm run lint`
Expected: no errors.

- [ ] **Step 5: Manual verification**

Start the dev server (`npm run dev` from repo root), then test both states:

- **Provider configured:** existing OpenCode auth.json → chat input renders as today.
- **No provider:** temporarily rename `~/.local/share/opencode/auth.json` and reload → chat bar shows "No chat provider yet. Add chat provider →" affordance. Restore auth.json afterwards.

- [ ] **Step 6: Commit**

```bash
git add web/src/components/ChatBar.tsx web/src/components/ChatBar.css
git commit -m "feat(chat): graceful Add chat provider state when no provider

When /api/chat/provider-status reports configured: false, the chat bar
renders a calm Add chat provider affordance (dashed border, link to
docs) instead of an input that would error on first send.

When provider is configured (existing user case), the chat input
renders unchanged. When the status is still loading (null), defaults
to showing the input — avoids a flash of empty state."
```

---

## Task 8: Empty state — calm "no sessions found" message

**Files:**
- Modify: `web/src/components/Home/index.tsx` (add empty-state render in the sessions section)

**Goal:** When there are no sessions at all (true zero-data path — state B in the spec), the empty state reads as *"Start a Claude Code session in a project. Oyster will pick it up automatically."* rather than the current blank table or "Welcome to your surface" hero.

- [ ] **Step 1: Identify the sessions render block**

Run: `grep -n "Sessions\|sessions.map\|scopedSessions" web/src/components/Home/index.tsx | head -20`

Locate the table render where sessions appear (the `<section className="home-section">` block around line 1075-1100 from the earlier read). Identify the conditional that wraps the table body.

- [ ] **Step 2: Add empty-state block**

After the sessions table render (and within the same `<section>`), add a conditional empty-state:

```tsx
{stateCounts.all === 0 && isHomeView && !showElsewhere && (
  <div className="home-empty-state">
    <div className="home-empty-state-title">No sessions found yet.</div>
    <div className="home-empty-state-body">
      Start a Claude Code session in a project. Oyster will pick it up automatically.
    </div>
  </div>
)}
```

(The exact prop name for the "all sessions count" may differ — use `stateCounts.all` if that matches, otherwise grep for the variable that holds the total count in this component.)

- [ ] **Step 3: Add minimal styles**

In the same CSS file used for `.home-section` (likely `Home.css`), add:

```css
.home-empty-state {
  text-align: center;
  padding: 48px 24px;
  color: rgba(232, 233, 240, 0.55);
}
.home-empty-state-title {
  font-size: 16px;
  color: var(--text);
  margin-bottom: 6px;
  font-weight: 500;
}
.home-empty-state-body {
  font-size: 13.5px;
}
```

- [ ] **Step 4: Type check + lint**

Run: `cd web && npx tsc -b && npm run lint`
Expected: no errors.

- [ ] **Step 5: Manual verification**

Start the dev server. On a fresh state (no sessions), navigate to Home — verify the calm empty-state copy appears, no "Welcome to your surface" overlay.

- [ ] **Step 6: Commit**

```bash
git add web/src/components/Home/index.tsx web/src/components/Home/Home.css
git commit -m "feat(home): calm empty state when no sessions found

Replaces the silent blank table on Home with a brief 'Start a Claude
Code session in a project. Oyster will pick it up automatically.' —
matches the spec's State B copy. Only renders when stateCounts.all is
0 and the user is on the default Home view."
```

---

## Task 9: CHANGELOG entry + version bump to 1.0.0

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `package.json`

**Goal:** A terse user-facing CHANGELOG entry under *Changed*, and the version bump from 0.9.8 → 1.0.0.

- [ ] **Step 1: Add CHANGELOG entry**

Read the top of `CHANGELOG.md` to find the `[Unreleased]` section (or whichever heading reflects work in progress per project convention).

Under *Changed*, add:

```markdown
- **Oyster opens to your work, not to a setup wizard.** First launch no longer requires an AI provider, no longer demands you create a space, and shows your sessions on the home screen immediately. Set-up surfaces only appear when something is genuinely missing.
```

- [ ] **Step 2: Bump version**

Edit `package.json` line 3 (`"version": "0.9.8"`) → `"version": "1.0.0"`.

Do NOT run `npm version` — per the saved project memory ([Release: promote Unreleased manually](feedback_changelog_user_facing.md) and similar), the version bump + Unreleased→[1.0.0] promotion is a manual step done before release tagging. This task just updates the version string; the user runs the release process separately.

If `CHANGELOG.md` has an `[Unreleased]` section, also rename it to `[1.0.0] - 2026-05-22` (or leave for the user to do at tag time — defer per project convention).

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md package.json
git commit -m "chore(release): 1.0.0 — sessions-first first run

CHANGELOG entry under Changed for the user-visible behaviour change.
Version bump 0.9.8 → 1.0.0. Tag + release process happens separately
via npm run release."
```

---

## Task 10: End-to-end manual verification in `oystertestone`

**Files:**
- No code changes — pure verification.

**Goal:** Validate against the spec's test plan in a real cold-install user account, before opening the PR for review.

- [ ] **Step 1: Build the package locally**

From the repo root:
```bash
npm run build
```

Then pack it:
```bash
npm pack
```

This produces `oyster-os-1.0.0.tgz` in the repo root.

- [ ] **Step 2: Switch to `oystertestone`**

Via Fast User Switching → `oystertestone`.

- [ ] **Step 3: Install the local build**

In `oystertestone`'s terminal, with the tarball accessible via `/Users/Shared/oyster-os-1.0.0.tgz` (copy it there from the main account first):

```bash
npm install -g /Users/Shared/oyster-os-1.0.0.tgz
```

- [ ] **Step 4: Run and verify against the spec's test plan**

```bash
oyster
```

Verify (matching the spec's test plan items 1-8):

- [ ] `oyster` starts immediately — no provider prompt, no `opencode auth login` spawned
- [ ] Browser opens at `http://localhost:4444`
- [ ] Home shows real session data (from `oystertestone`'s existing Claude Code sessions)
- [ ] No "Set up Oyster" pulsing pill in the topbar — just a quiet 🦪 icon
- [ ] No "Click [+] to set up your first space" copy
- [ ] Heading reads *"Recent sessions."* on both Home views (default and the "All" pill)
- [ ] "All" pill (was "Unsorted") renders correctly when there are orphan sessions
- [ ] Dock opens to show 4 items: **Connect an agent** (required), Organise into spaces, Publish first artefact, Import memories
- [ ] Connecting Claude Code via MCP (using the per-client command in the dock) auto-ticks the MCP item
- [ ] Chat bar with no provider — shows "Add chat provider →" affordance, doesn't error
- [ ] Chat bar with provider configured — works as today, unchanged

- [ ] **Step 5: Cleanup**

```bash
npm uninstall -g oyster-os
rm /Users/Shared/oyster-os-1.0.0.tgz
```

Switch back to main account.

- [ ] **Step 6: Open the PR**

From the worktree:

```bash
gh pr create --title "1.0 first run: show sessions, hide setup" --body "..."
```

PR body should link to:
- The spec PR (#551)
- A summary of what changed (the 10-item bulleted list from spec)
- The manual test plan completion (paste the checkbox list from Step 4)

---

## Out of Scope (per spec)

- Topics / tags / faceting (1.1+)
- Data model refactor (sessions-as-unit table)
- In-Oyster HTML provider picker (replaces OpenCode TUI for the chat bar)
- Auto-detect existing Claude Code / Cursor credentials
- Native binary distribution (Bun-compiled, signed, notarised)
- `install.sh` / `install.md` improvements (separate spec)
- Empty-state coach-mark (#312)
- First-run MCP nudges of any kind

---

## Self-Review

**Spec coverage** — each spec item maps to a task:
1. *No provider gate* → Task 1
2. *No setup wizard (no domination)* → Tasks 2, 5 (drop hero CTA + neutralise dock pill)
3. *Home shows sessions first* → Tasks 3, 8 (rename + empty state)
4. *Auto-discover work* → already shipping (Claude Code JSONL reader exists). 1.0 scope is *consume what's there*, not *build new discovery*. No new task.
5. *Spaces are optional* → Task 5 (spaces flipped to `required: false`; "Organise into spaces" wording)
6. *Chat bar is optional* → Tasks 6, 7 (provider-status + graceful state)
7. *MCP stays in onboarding — quietly* → Task 5 (MCP becomes the required dock item with "Connect an agent" / "Connect" wording; pill itself is neutralised)

10-item change list:
1. Remove auth gate → Task 1
2. Server unconditional → Task 1 (same change)
3. Home = Recent sessions → Task 3
4. Rename "Everything else" → Task 3 (consolidates both Home headings to "Recent sessions.")
5. Rename "Unsorted" → "All" → Task 4
6. Remove "Click + to set up..." → Task 3
7. Demote "Set up Oyster" pill (neutralise, keep items) → Task 5
8. Hide chat input cleanly → Tasks 6, 7
9. Spaces as organising only → Task 5 (item renamed "Organise into spaces", flipped to optional)
10. Empty state for no sessions → Task 8

CHANGELOG + version → Task 9. Manual verification → Task 10.

**Placeholder scan:** No "TBD", "TODO", "implement later". Each step has exact code or exact commands.

**Type consistency:** `ItemKey` / `OnboardingState` / `COMPLETE_KEY` / `allDone` all stay as today's 4-item shape — no type-shape changes in Task 5. The `requiredDone` derive flips from `state.spacesComplete` → `state.mcpComplete` (one-line change). `providerConfigured` is `boolean | null` consistently in Task 7 and `/api/chat/provider-status` returns `{ configured: boolean }` consistently in Tasks 6+7.

**Edge case to flag:** Task 5 keeps `McpConnect`, `CLIENT_CONFIGS`, the SSE listener, and the `/api/mcp/status` REST fallback. If the engineer accidentally removes any of them while neutralising the pill, the auto-tick when an agent connects breaks. Step 4 of Task 5 calls this out explicitly.

---

## Execution Handoff

After saving, two paths:

**1. Subagent-Driven (recommended)** — fresh subagent per task, review between, fast iteration
**2. Inline Execution** — execute in this session via executing-plans skill, batch with checkpoints

Pick one.
