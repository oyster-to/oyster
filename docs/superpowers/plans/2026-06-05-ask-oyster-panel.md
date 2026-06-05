# Ask Oyster Panel (PR 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The bottom ChatBar becomes a right-hand slide-over "Ask Oyster" panel opened from a topbar `✦ Ask` button; the agent learns the user's current scope; the omnikey handler and ⚡ terminal escape hatch are removed.

**Architecture:** Convert `ChatBar.tsx` in place — rename to `AskPanel`, replace the fixed-bottom shell with a slide-over shell, keep all chat logic (slash commands, autocomplete, streaming, queueing, events) byte-identical. The panel is **always mounted** in App with an `open` prop toggling a CSS transform, so conversation state and the SSE stream survive close/reopen exactly as the always-mounted bar does today. Scope context is computed in App and threaded as two props (display label + message prefix).

**Tech Stack:** React 18 + TypeScript (web/), no web test runner (per codebase; verification = `npx tsc -b` + `npm run lint` zero-new-errors + `npm run build` + manual checks). Lint baseline: ~45 pre-existing `react-hooks` errors repo-wide — gate is zero NEW errors on touched lines.

**Spec:** `docs/superpowers/specs/2026-06-05-ask-oyster-panel-design.md`

**One noted spec deviation:** the spec says AI-error surfacing "moves into the panel", but App's `aiError` banner also serves non-chat errors (unpublish failure, App.tsx:559). Keep the `onAiError` → App-banner wiring exactly as today; the banner is the shared error surface. (Provider-status fallback already lives inside the component and moves with it.)

**Branch / worktree:** Branch `ask-oyster-panel` exists (holds the spec). Execute in a worktree: `git worktree add ~/Dev/oyster.worktrees/ask-oyster-panel ask-oyster-panel`, copy `.env` in, symlink `node_modules` (root, web, server) from the main checkout. Manual checks: `npm run dev` from the worktree root → http://localhost:7337 (stop any running Oyster first; stale `~/Oyster/.oyster.lock` may need deleting).

**Key facts an implementer needs (verified against main):**
- `web/src/components/ChatBar.tsx` (691 lines) renders: messages panel (expands upward; bubbles, markdown via marked+DOMPurify, `ToolBlock`/`ReasoningBlock`, question options, copy button), slash autocomplete, ⚡ bolt div (`chatbar-oyster`, onClick=`onOpenTerminal`), status text, provider fallback, input + send.
- `useChatSession` (web/src/hooks/useChatSession.ts) owns messages/sessionId/expanded + `/session/<id>` URL push + popstate reset. **Unchanged in this PR.**
- `useChatEvents` streams SSE into messages. **Unchanged.**
- App couplings (web/src/App.tsx): `chatInputRef` + printable-key focus handler (~lines 69-100), `handleOpenTerminal`/`confirmHardcore`/`showHardcoreGate` + gate modal JSX (only dispatchers of `OPEN_TERMINAL`), `<ChatBar …>` render (~line 854+), `useAllProjects(pickerOpen)` (data/all-projects).
- OnboardingDock.tsx:259 dispatches `oyster:send-prompt`; ChatBar listens (lines 452-462) and the listener moves with the component — but the panel must also OPEN.
- Home topbar right-cluster (web/src/components/Home/index.tsx, `home-breadcrumb-inner--right-cluster`) renders `RunningTerminalsPill` + `NewSessionPill` (`nsp-pill` class — reuse it for the Ask pill).
- App.css: `.chatbar-wrapper/.chatbar-bar/.chatbar-messages(+expand/collapse)/.chatbar-oyster/.chatbar-collapse` are structural (replaced); `.chatbar-input/.chatbar-send/.chatbar-status/.chatbar-copy/.chatbar-add-provider/.slash-*/.chat-bubble/.chat-markdown/.question-options/.tool-block*` are position-independent (kept, classnames unchanged).

---

### Task 1: Convert ChatBar → AskPanel + App wiring + topbar pill + removals

One atomic conversion commit: after it, the app has no bottom bar, a working slide-over, and no omnikey/hardcore code. (It can't be split without an intermediate broken state — the rename breaks App's import.)

**Files:**
- Rename: `web/src/components/ChatBar.tsx` → `web/src/components/AskPanel.tsx` (`git mv`)
- Create: `web/src/components/Topbar/AskPill.tsx`
- Modify: `web/src/App.tsx`, `web/src/components/Home/index.tsx`, `web/src/App.css`

- [ ] **Step 1: `git mv web/src/components/ChatBar.tsx web/src/components/AskPanel.tsx`**

- [ ] **Step 2: Rework the component shell (AskPanel.tsx)**

(a) Props — replace the interface:

```ts
interface Props {
  open: boolean;
  onClose: () => void;
  /** Crumb-shaped scope label for the header chip ("everything" / space / "space › project" / "vault"). */
  scopeLabel: string;
  /** Context line prepended to outbound messages; null at "everything" scope. (Wired in Task 2 — pass null until then.) */
  scopeContext: string | null;
  spaces?: Space[];
  activeSpace?: string;
  onSpaceChange?: (space: string) => void;
  artifacts?: Artifact[];
  onArtifactOpen?: (artifact: Artifact) => void;
  onArtifactPublish?: (artifact: Artifact) => void;
  onArtifactUnpublish?: (artifact: Artifact) => void;
  onAiError?: (message: string | null) => void;
}
```

Dropped: `onOpenTerminal` (button removed), `inputRef` (omnikey removed — keep only the internal `localInputRef`, delete the `externalInputRef` indirection: `const inputRef = useRef<HTMLInputElement>(null);`).

(b) Rename the function `ChatBar` → `AskPanel`; destructure the new props.

(c) Delete the ⚡ bolt block (the `<div className="chatbar-oyster" onClick={onOpenTerminal}>…</div>` with the bolt SVG).

(d) Delete the click-outside-collapses effect (the `handleClickOutside` useEffect — the panel closes only via ✕) and the `wrapperRef` it used.

(e) Replace the outer render shell. The old shape was `div.chatbar-wrapper > [messages panel, chatbar-bar]`. New shape:

```tsx
  return (
    <div className={`ask-panel${open ? " open" : ""}`} aria-hidden={!open}>
      <div className="ask-panel-header">
        <span className="ask-panel-title">✦ Ask Oyster</span>
        <span className="ask-panel-scope" title="Answers consider your current scope">{scopeLabel}</span>
        <button type="button" className="ask-panel-close" onClick={onClose} aria-label="Close Ask Oyster">✕</button>
      </div>

      {/* Messages feed — same inner markup as before, new container class */}
      <div className="ask-panel-messages">
        {messages.length > 0 && (
          <>
            <div className="chatbar-actions">
              <button className={`chatbar-copy ${copied ? "copied" : ""}`} onClick={handleCopyChat} title="Copy chat">
                {copied ? "copied" : "copy"}
              </button>
            </div>
            {/* …the existing messages.filter(...).map(...) block, UNCHANGED… */}
            <div ref={bottomRef} />
          </>
        )}
      </div>

      {/* Input row — same inner markup as the old chatbar-bar, minus the bolt */}
      <div className="ask-panel-inputrow">
        {/* …existing slash-autocomplete block, status text, provider fallback,
            input + send button, ALL UNCHANGED… */}
      </div>
    </div>
  );
```

Concretely: keep every inner block byte-identical (autocomplete, status, provider fallback, input, send, bubbles, question options); only the containers change. The old `chatbar-collapse` (↓) button is deleted — the header ✕ replaces it. The `expanded`/`chat-expanded`/`chat-collapsed` class logic on the messages container is dropped (the feed is always visible inside an open panel); keep the `setExpanded(...)` calls elsewhere in the file untouched (they're harmless hook state and the `expanded` value still drives the autoscroll effect — change that effect's guard from `if (expanded)` to `if (open)` and its deps from `[messages, expanded]` to `[messages, open]`). Keep `slash-dimmed` by moving it onto `ask-panel-messages`: `` className={`ask-panel-messages${slashOpen ? " slash-dimmed" : ""}`} ``. The old `chatbar-bar` onClick expand handler is dropped.

(f) The input's `onFocus` handler (`if (messages.length > 0) setExpanded(true)`) — delete it (no collapsed state to recover from).

- [ ] **Step 3: AskPill**

Create `web/src/components/Topbar/AskPill.tsx` (mirrors NewSessionPill, reuses its CSS):

```tsx
// "✦ Ask" pill. Sibling to NewSessionPill in the breadcrumb nav's
// right-aligned cluster. Opens the Ask Oyster slide-over panel.

export function AskPill({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      className="nsp-pill"
      onClick={onClick}
      title="Ask Oyster about your current scope"
    >
      <span aria-hidden="true">✦</span>
      <span>Ask</span>
    </button>
  );
}
```

- [ ] **Step 4: Thread the pill through Home**

In `web/src/components/Home/index.tsx`:
- Props interface adds: `onOpenAsk?: () => void;` (doc comment: `/** Open the Ask Oyster panel — renders the ✦ Ask pill when provided. */`). Add to destructure.
- Import: `import { AskPill } from "../Topbar/AskPill";`
- In the right-cluster div (next to `{onOpenNewSession && <NewSessionPill …/>}`), add **before** the NewSessionPill:

```tsx
              {onOpenAsk && <AskPill onClick={onOpenAsk} />}
```

- [ ] **Step 5: App wiring + removals (web/src/App.tsx)**

(a) Import swap: `import { ChatBar } from "./components/ChatBar";` → `import { AskPanel } from "./components/AskPanel";`

(b) New state near the other UI state: `const [askOpen, setAskOpen] = useState(false);`

(c) **Remove omnikey:** delete `const chatInputRef = useRef<HTMLInputElement>(null);` and, inside the global `handleKeyDown`, delete ONLY the printable-key block (the `const tag = …; if (tag !== "INPUT" && … && e.key.length === 1) { chatInputRef.current?.focus(); }` lines). Keep ⌘K Spotlight toggle and Escape handling intact. If `useRef` import becomes unused, eslint will say so — it won't (other refs exist).

(d) **Remove the hardcore gate:** delete `handleOpenTerminal`, `confirmHardcore`, the `showHardcoreGate` state, and the entire `{showHardcoreGate && (…hardcore-gate-overlay…)}` JSX block. These were the only dispatchers of `OPEN_TERMINAL` (verified: windows.ts reducer case stays; the `terminalWindow` render block stays — it simply never mounts now, and removing the reducer/window machinery is out of scope).

(e) Replace the `<ChatBar …/>` render with the always-mounted panel:

```tsx
      <AskPanel
        open={askOpen}
        onClose={() => setAskOpen(false)}
        scopeLabel="everything"
        scopeContext={null}
        spaces={spaces}
        activeSpace={activeSpace}
        onSpaceChange={handleSpaceChange}
        artifacts={artifacts}
        onArtifactOpen={handleArtifactClick}
        onArtifactPublish={handleArtifactPublish}
        onArtifactUnpublish={handleArtifactUnpublish}
        onAiError={setAiError}
      />
```

(`scopeLabel`/`scopeContext` get real values in Task 2.)

(f) Pass the opener to Home: add `onOpenAsk={() => setAskOpen(true)}` to the `<Home …>` props.

- [ ] **Step 6: CSS (web/src/App.css)**

Delete these structural blocks (grep each selector to find every occurrence — `.chatbar-messages` appears twice): `.chatbar-wrapper` (both), `.chatbar-bar`, `.chatbar-messages` (both, incl. `.chat-expanded`/`.chat-collapsed`/scrollbar variants), `.chatbar-oyster` (+ `:hover`/`:active`), `.chatbar-collapse` (+ hover; keep `.chatbar-actions .chatbar-collapse`? No — delete all `.chatbar-collapse` rules; the button is gone), `.chatbar-messages.slash-dimmed`. Also delete the now-orphaned `.hardcore-gate-overlay`/`.hardcore-gate`/`.hardcore-*` blocks (this change orphans them).

KEEP unchanged: `.chatbar-input*`, `.chatbar-send*`, `.chatbar-status`, `.chatbar-copy*`, `.chatbar-actions`, `.chatbar-add-provider*`, `.slash-autocomplete*`, `.chat-bubble*`, `.chat-markdown*`, `.question-options*`, `.question-option-btn*`, `.tool-block*`.

Add the panel block (after where `.chatbar-wrapper` was):

```css
/* ── Ask Oyster slide-over panel ── */
.ask-panel {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  width: 420px;
  max-width: 92vw;
  display: flex;
  flex-direction: column;
  background: rgba(13, 14, 26, 0.97);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  border-left: 1px solid rgba(255, 255, 255, 0.08);
  box-shadow: -18px 0 48px rgba(0, 0, 0, 0.5);
  transform: translateX(102%);
  transition: transform 0.22s ease;
  z-index: 200;
}
.ask-panel.open { transform: translateX(0); }

.ask-panel-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 13px 16px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.07);
  flex: none;
}
.ask-panel-title {
  font-size: 13.5px;
  font-weight: 600;
  color: #e8e8f2;
}
.ask-panel-scope {
  margin-left: auto;
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 11px;
  color: rgba(220, 220, 240, 0.55);
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 9999px;
  padding: 2px 10px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 200px;
}
.ask-panel-close {
  background: none;
  border: none;
  color: rgba(220, 220, 240, 0.55);
  cursor: pointer;
  font-size: 13px;
  padding: 2px 4px;
}
.ask-panel-close:hover { color: #fff; }

.ask-panel-messages {
  flex: 1;
  overflow-y: auto;
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.ask-panel-messages.slash-dimmed { opacity: 0.35; }
.ask-panel-messages::-webkit-scrollbar { width: 8px; }
.ask-panel-messages::-webkit-scrollbar-track { background: transparent; }
.ask-panel-messages::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.12);
  border-radius: 4px;
}
.ask-panel-messages::-webkit-scrollbar-thumb:hover { background: rgba(255, 255, 255, 0.2); }

.ask-panel-inputrow {
  position: relative; /* anchors .slash-autocomplete */
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 14px;
  border-top: 1px solid rgba(255, 255, 255, 0.07);
  flex: none;
}
```

Check `.slash-autocomplete`'s existing positioning: it floated above the bottom bar (likely `position:absolute; bottom:…`). With `.ask-panel-inputrow { position: relative }` as its anchor it should sit above the input inside the panel — verify visually and adjust its `left/right/bottom` offsets to fit the panel width if needed (e.g. `left: 8px; right: 8px; bottom: calc(100% + 6px);`).

- [ ] **Step 7: Verify** — `cd web && npx tsc -b && npm run lint` (tsc clean; zero NEW lint errors). `grep -rn "ChatBar\|chatInputRef\|onOpenTerminal\|hardcore" web/src --include="*.tsx" --include="*.ts"` → only `windows.ts`'s reducer (allowed) and nothing else.

- [ ] **Step 8: Manual check** — dev server: bottom bar gone (pages reclaim the space); `✦ Ask` pill next to `+ New session`; click opens slide-over with header/chip("everything")/✕; send a message → thread renders, streaming works; slash commands + autocomplete work inside the panel; `#1` switches space; close+reopen panel → thread intact; typing on the page does NOT focus anything; no ⚡ anywhere.

- [ ] **Step 9: Commit**

```bash
git add -A web/src
git commit -m "ask: ChatBar becomes the Ask Oyster slide-over panel"
git log --oneline -1
```

---

### Task 2: Real scope inheritance — chip + context prefix

**Files:**
- Modify: `web/src/App.tsx`, `web/src/components/AskPanel.tsx`

- [ ] **Step 1: Compute scope in App**

(a) Import the sentinel: `import { VAULT } from "./components/Home/types";`

(b) The projects list: change `const { projects: allProjects, loading: allProjectsLoading } = useAllProjects(pickerOpen);` to enable when the panel is open too: `useAllProjects(pickerOpen || askOpen);`

(c) Below `activeProjectId`/`askOpen` declarations:

```ts
  // Scope label + outbound-context line for the Ask panel. Label mirrors the
  // Home crumb shapes; context is what the agent actually reads — omitted at
  // "everything" so unscoped chats stay clean.
  const askScope = useMemo((): { label: string; context: string | null } => {
    if (activeProjectId === VAULT) {
      return {
        label: "vault",
        context: `[Scope: the user is viewing the Vault — artefacts created in Oyster itself, not tied to a repo.]`,
      };
    }
    const project = activeProjectId ? allProjects.find((p) => p.id === activeProjectId) ?? null : null;
    const spaceId = project?.spaceId ?? (activeSpace !== "home" && activeSpace !== "__all__" && activeSpace !== "__archived__" ? activeSpace : null);
    const spaceName = spaceId ? spaces.find((s) => s.id === spaceId)?.displayName ?? spaceId : null;
    if (project) {
      return {
        label: `${spaceName ? spaceName + " › " : ""}${project.name}`,
        context: `[Scope: ${spaceName ? `space "${spaceName}", ` : ""}project "${project.name}"${project.recentPath ? ` at ${project.recentPath}` : ""}.]`,
      };
    }
    if (spaceName) {
      return { label: spaceName, context: `[Scope: space "${spaceName}".]` };
    }
    return { label: "everything", context: null };
  }, [activeProjectId, activeSpace, allProjects, spaces]);
```

(If `Project` has no `recentPath` field, check `web/src/data/all-projects.ts` for the actual field name and use it; omit the path clause if absent.)

(d) Wire it: `scopeLabel={askScope.label}` and `scopeContext={askScope.context}` on `<AskPanel>` (replacing the Task 1 placeholders).

- [ ] **Step 2: Prefix outbound messages in AskPanel**

In `handleSend`, the non-command path currently does:

```ts
    setInput("");
    setMessages((prev) => [...prev, { role: "user", content }]);
    …
    await sendMessage(sessionId, content);
```

Change ONLY the `sendMessage` line:

```ts
      // Scope context rides ahead of the user's text so the agent's MCP
      // tools act where the user is looking. The displayed bubble stays raw.
      await sendMessage(sessionId, scopeContext ? `${scopeContext}\n\n${content}` : content);
```

`scopeContext` must be added to the `handleSend` useCallback dep array. Slash/`#` commands are untouched (they return before this line and never reach the AI). The queued-prompt drain and `oyster:send-prompt` paths route through `handleSend`, so they inherit the prefix automatically.

- [ ] **Step 3: Verify** — tsc + lint clean. Manual: scope to a project, open panel → chip shows `space › project`; send "what is this project?" → answer reflects the project (and the visible bubble shows only your text); switch to Home unscoped → chip "everything", sends carry no prefix (verify via the agent's view or a quick `console.log` removed before commit — or trust the code path).

- [ ] **Step 4: Commit**

```bash
git add web/src/App.tsx web/src/components/AskPanel.tsx
git commit -m "ask: panel inherits the active scope (chip + outbound context line)"
```

---

### Task 3: Onboarding send-prompt opens the panel

**Files:**
- Modify: `web/src/App.tsx`

- [ ] **Step 1:** AskPanel's existing `oyster:send-prompt` listener sends the text, but the panel may be closed. App opens it — add near the other App-level effects:

```ts
  // OnboardingDock's "Set up Oyster" (and any oyster:send-prompt dispatcher)
  // lands in the Ask panel — make sure the panel is visible when it does.
  useEffect(() => {
    const handler = () => setAskOpen(true);
    window.addEventListener("oyster:send-prompt", handler);
    return () => window.removeEventListener("oyster:send-prompt", handler);
  }, []);
```

- [ ] **Step 2: Verify** — tsc + lint. Manual: trigger the OnboardingDock setup step (or `window.dispatchEvent(new CustomEvent("oyster:send-prompt", { detail: { text: "hello" } }))` from devtools) → panel opens and the message sends (including during the session-boot window — the pending-prompt queue inside AskPanel covers that, unchanged).

- [ ] **Step 3: Commit**

```bash
git add web/src/App.tsx
git commit -m "ask: open the panel when a cross-component prompt arrives"
```

---

### Task 4: Changelog + docs + full build

**Files:**
- Modify: `CHANGELOG.md`, `CLAUDE.md`

- [ ] **Step 1: Changelog** — read the head of CHANGELOG.md first; merge into the existing `[Unreleased]` sections (Keep-a-Changelog style, user-facing only):

```md
### Changed
- **Ask Oyster moves to a side panel** — chat now opens from the ✦ Ask button in the top bar and slides in beside your work, instead of a bar pinned to the bottom of every page. It knows which space and project you're looking at.

### Removed
- **Bottom chat bar** — and with it, typing-anywhere-to-chat and the ⚡ terminal shortcut.
```

(If the file has no `### Removed` section precedent under Unreleased, fold the second bullet into Changed.)

- [ ] **Step 2: CLAUDE.md touch-up** — two stale lines: "Navigated via pills at the bottom of the chat bar, or via `#space` / `/s space` commands" → "Navigated via pills in the top bar, or via `#space` / `/s space` commands in the Ask panel"; and the Key Files entry "`web/src/components/ChatBar.tsx` — chat input, slash commands, space pills" → "`web/src/components/AskPanel.tsx` — Ask Oyster panel: chat input, slash commands, message thread".

- [ ] **Step 3: Full build** — root `npm run build` (web tsc + vite + server tsc all pass); `cd web && npm run lint` (baseline only).

- [ ] **Step 4: Final manual sweep** — Home → space → project → open panel (chip correct at each scope) → send → close/reopen (thread intact) → `/o`, `/p`, `#1` from the panel → provider-fallback state (if testable) → `/session/<id>` URL appears on first message → no bottom bar on any view → viewer fix-error flow still posts (uses chat-api directly).

- [ ] **Step 5: Commit**

```bash
git add CHANGELOG.md CLAUDE.md
git commit -m "changelog+docs: Ask Oyster side panel"
```

---

## Out of scope (per spec)

- PR 3: SpotlightSearch "ask" row.
- Server-side session scoping; VAULT scope type; `selectedCwd` URL form.
- `windows.ts` OPEN_TERMINAL reducer machinery (entry points removed; reducer untouched).
