# Cloud Remote View — UI Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `oyster.to/app` serves the real Oyster web UI in a read-mostly "cloud mode" — sessions list with device filter, SessionInspector with live tail, published-artifacts tab with light actions, memories tab — responsive enough to dogfood on a phone.

**Architecture:** One `web/` codebase, two builds. A `caps` module (driven by `VITE_OYSTER_MODE=cloud`) gates everything local-only (ChatBar, terminals, writes, SSE). A thin cloud data adapter maps the worker's snake_case APIs into the existing camelCase types — the component tree is unchanged. The oyster-cloud worker gains an `[assets]` binding and serves the cloud build at `/app/*` (auth-gated index, SPA fallback), replacing the throwaway whoami shell. The `/app/api/*` → `/api/*` rewrite from the backend slice already handles API calls.

**Tech Stack:** React 18 + TypeScript + Vite (web/ — **no test runner**: verification is `tsc -b` + eslint + build + explicit manual browser checks). Cloudflare worker: vitest + @cloudflare/vitest-pool-workers.

**Spec:** `docs/superpowers/specs/2026-06-05-cloud-remote-view-design.md` (UI + Live tail sections)
**Branch / worktree:** `cloud-remote-view-ui` at `~/Dev/oyster.worktrees/cloud-remote-view-ui` (exists). Run `npm install` in `web/`, `server/`, `infra/oyster-cloud/` before starting.

---

## Scope decisions (data-driven, flagged for the user)

Cloud `synced_session_metadata` has **no `space_id` or `project_id`** — sessions can't be space-scoped or project-grouped remotely. Therefore in cloud mode v1:

- **Space pills are hidden** (memories/publications do carry `space_id`, but scoping only two of three tabs would be confusing — defer until session metadata syncs space_id).
- **The projects grid is not rendered** (no registry remotely). The device filter chip + tabs are the navigation.

Both are `caps` gates, not forks — when the metadata gains those columns, the gates lift.

## Key facts (verified — don't re-derive)

- Web data layer: `web/src/data/*-api.ts`, relative `/api/...` paths via `web/src/data/http.ts` (`getJson` etc.). `useFetched(fetcher, initial, {key, enabled, ssEvent})` in `web/src/hooks/useFetched.ts`. Sessions flow: App's `useSessions()` → `fetchSessions()` → props to Home.
- SSE: `web/src/data/ui-events.ts` — `subscribeUiEvents(listener)`, single EventSource on `/api/ui/events`, synthetic `session_changed` on visibility-change. Absent SSE = silently static UI.
- SessionInspector (`web/src/components/SessionInspector/index.tsx`): bootstrap `fetchSession` + `fetchSessionEvents({around?})`; live append on `session_changed` → `fetchSessionEvents({after: lastEventId})` (debounced 200ms); older pages via `{before}`; raw lazy via `fetchSessionEventRaw`. Event shape `{id, sessionId, role, text, ts, raw}` — **identical to the cloud events endpoint**, ids are byte offsets there (monotonic ints — cursors just work).
- Cloud APIs (same origin from `/app`): `GET /app/api/sessions/metadata` → `{sessions:[{session_id, device_id, device_label, agent, title, state, cwd, model, started_at, ended_at, last_event_at, has_bytes, total_bytes, active_device_id, ...}]}` (snake_case); `GET /app/api/sessions/:id/events?before|after|limit`; `GET /app/api/sessions/bytes/:id/manifest` → `{total_size, ...}` (D1-only, cheap); `GET /app/api/memories/events` → `{events:[{event_id, memory_id, event_type, space_id, created_at, payload?:{content, tags, purged_at}}]}`; `GET /api/publish/mine` (apex, oyster-publish) → `{publications:[{share_token, artifact_id, artifact_kind, mode, content_type, size_bytes, published_at, updated_at, label, space_id}]}`; `PATCH/DELETE /api/publish/:token` (Origin `https://oyster.to` is allowlisted).
- snake→camel mapping precedent: the local server already merges cloud sessions — **copy the field mapping from `server/src/routes/sessions.ts:379-415`**.
- Routing: `App.tsx getUrlState()` (lines ~52-67) parses `/s/<space>[/a/:id|/g/:name|/p/:id]`; several `history.pushState` sites. Cloud build is served under `/app` — all routes need a base prefix.
- Worker: `infra/oyster-cloud` has NO `[assets]` yet; precedent is `infra/oyster-arcade-site/wrangler.toml` (`[assets] directory/binding ASSETS`). `/app` + `/app/api/*` dispatch exists in `worker.ts` (lines ~25-33); `app-shell.ts` is the throwaway to replace.
- Home/index.tsx (1768 lines): tab strip ~1180-1213, sessions filter chips ~1217-1241, SessionRow callsites ~1277-1292, Artefacts tab ~1316-1507 (Desktop icons view / ArtefactTable), Memories tab ~1509-1593 (MemoryCard). Write affordances: space delete (~1136-1146, 1678-1713), attach popovers (~1063-1083, 1626-1663), memory add/delete (~1513-1557, MemoryCard.tsx:23, ~1734-1762), ArtefactTable context menu (ArtefactTable.tsx:160-225). SessionRow already renders origin/active device chips (SessionRow.tsx:114-121) — the device *filter* is new.
- Home.css already has `@media (max-width: 720px)` for the sessions table (line ~739). InspectorPanel.css width: `min(640px, 92vw)` (line 21).
- Verification loop: web has no test runner; worker changes get vitest. Deploys are manual `wrangler deploy`; the live-domain check IS the E2E harness (personal dogfood product, instant rollback via `wrangler rollback`).

---

### Task 1: `caps` module, cloud build mode, API base indirection

**Files:**
- Create: `web/src/caps.ts`
- Modify: `web/src/data/http.ts` (add `apiPath` helper), every `web/src/data/*-api.ts` URL construction, `web/vite.config.ts`, `web/package.json` (build:cloud script), root `package.json` (build:cloud chain)

- [ ] **Step 1: Create `web/src/caps.ts`**

```ts
// caps.ts — capability flags for the two build targets.
// Local (default): full surface against the local server.
// Cloud (VITE_OYSTER_MODE=cloud): read-mostly remote view served by the
// oyster-cloud worker at oyster.to/app (spec
// docs/superpowers/specs/2026-06-05-cloud-remote-view-design.md).
// Gate on these named capabilities, never on `mode` directly — call sites
// should say what they need, not where they run.
const cloud = import.meta.env.VITE_OYSTER_MODE === "cloud";

export const caps = {
  cloud,
  /** Local agent available: ChatBar, terminals, resume, setup scan. */
  canChat: !cloud,
  /** Local filesystem writes: spaces/projects/memories/artifact mutations. */
  canWrite: !cloud,
  /** SSE push from the local server; cloud falls back to polling. */
  hasSse: !cloud,
  /** Space pills + project grid — cloud session metadata has no
   *  space_id/project_id yet, so scoping has nothing to bind to. */
  hasScopes: !cloud,
  /** Publication management (unpublish / access mode) — available in BOTH
   *  modes; cloud calls the apex publish API directly. */
  canManagePublications: true,
  /** Prefix for API calls: the cloud SPA lives at /app and its API is the
   *  /app/api/* rewrite on the worker. */
  apiBase: cloud ? "/app" : "",
  /** Prefix for client routes (history.pushState / URL parsing). */
  routeBase: cloud ? "/app" : "",
} as const;
```

- [ ] **Step 2: API base indirection in `web/src/data/http.ts`**

Add (near the top, after imports):

```ts
import { caps } from "../caps";

/** Resolve an API path against the build's API base. Cloud mode serves the
 *  SPA at /app and reaches the worker via the /app/api/* rewrite. */
export function apiPath(path: string): string {
  return `${caps.apiBase}${path}`;
}
```

Then update every URL construction in `web/src/data/*-api.ts` (sessions-api, artifacts-api, projects-api, memories-api, spaces-api, and any other module building `/api/...` strings — grep `"/api/` under `web/src/data/`) to wrap with `apiPath(...)`, e.g. `getJson(apiPath(`/api/sessions/${id}/events?${qs}`))`. Also `web/src/data/ui-events.ts`'s EventSource URL. Mechanical; do not change anything else about those calls.

- [ ] **Step 3: Cloud build config**

`web/vite.config.ts`: derive `base` from the mode so built asset URLs are `/app/assets/*`:

```ts
// in defineConfig(({ mode }) => ...) or via process.env at config eval:
base: process.env.VITE_OYSTER_MODE === "cloud" ? "/app/" : "/",
build: {
  outDir: process.env.VITE_OYSTER_MODE === "cloud" ? "dist-cloud" : "dist",
},
```

(The file already uses the `defineConfig(({ mode }) => ...)` function form — add `base` and `build.outDir` inside the existing callback. Keep all proxy config as-is; it's dev-only.)

`web/package.json` scripts: add `"build:cloud": "VITE_OYSTER_MODE=cloud tsc -b && VITE_OYSTER_MODE=cloud vite build"`.
Root `package.json`: add `"build:cloud": "cd web && npm run build:cloud"`.
Add `web/dist-cloud` to the repo `.gitignore` (alongside however `web/dist` is ignored — check and mirror).

- [ ] **Step 4: Verify both builds**

Run: `cd web && npx tsc -b && npm run lint && npm run build && npm run build:cloud`
Expected: all clean; `web/dist/` unchanged in shape; `web/dist-cloud/index.html` references `/app/assets/...`.
Manual check: `npm run dev` at repo root → local UI at :7337 works exactly as before (apiPath is a no-op locally).

- [ ] **Step 5: Commit**

```bash
git add web/src/caps.ts web/src/data web/vite.config.ts web/package.json package.json .gitignore
git commit -m "web: caps module, cloud build mode, API base indirection"
```

---

### Task 2: Cloud data adapter — sessions, events, polling

**Files:**
- Create: `web/src/data/cloud-sessions.ts`
- Modify: `web/src/data/sessions-api.ts` (cloud branches), `web/src/data/ui-events.ts` (polling fallback)

- [ ] **Step 1: Create `web/src/data/cloud-sessions.ts`**

```ts
// cloud-sessions.ts — maps the oyster-cloud worker's snake_case session
// metadata into the local Session shape so the component tree is unchanged.
// Field mapping mirrors the local server's own cloud-merge
// (server/src/routes/sessions.ts:379-415) — keep them aligned.
import type { Session } from "../../../shared/types";
import { getJson, apiPath } from "./http";

interface CloudSessionMeta {
  session_id: string;
  device_id: string | null;
  device_label: string | null;
  agent: string;
  title: string | null;
  state: string;
  cwd: string | null;
  model: string | null;
  started_at: string;
  ended_at: string | null;
  last_event_at: string;
  has_bytes: boolean;
  total_bytes: number;
  active_device_id: string | null;
}

function toSession(m: CloudSessionMeta): Session {
  return {
    id: m.session_id,
    spaceId: null,          // not synced yet — caps.hasScopes hides scoping
    projectId: null,
    cwd: m.cwd,
    agent: m.agent,
    title: m.title,
    state: m.state,
    displayState: m.state,  // no probe evidence remotely; state is the signal
    displayReason: m.device_label ?? "",
    startedAt: m.started_at,
    endedAt: m.ended_at,
    model: m.model,
    lastEventAt: m.last_event_at,
    originDeviceId: m.device_id,
    originDeviceLabel: m.device_label,
    jsonlAvailableLocally: false,
    hasBytes: m.has_bytes,
    activeDeviceId: m.active_device_id,
    activeDeviceLabel: null,
    terminalId: null,
    terminalAttachedClients: 0,
  } as Session;
}

let cache: { at: number; sessions: Session[] } | null = null;
const CACHE_MS = 3_000; // collapse the fetchSessions + fetchSession(id) pair

export async function fetchCloudSessions(signal?: AbortSignal): Promise<Session[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.sessions;
  const data = await getJson<{ sessions: CloudSessionMeta[] }>(
    apiPath("/api/sessions/metadata"), signal,
  );
  const sessions = (data.sessions ?? []).map(toSession);
  cache = { at: Date.now(), sessions };
  return sessions;
}

export async function fetchCloudSession(id: string, signal?: AbortSignal): Promise<Session> {
  const all = await fetchCloudSessions(signal);
  const s = all.find((x) => x.id === id);
  if (!s) throw Object.assign(new Error("session not found"), { status: 404 });
  return s;
}

/** Cheap liveness probe for the open inspector: manifest is D1-only on the
 *  worker (no R2 decrypt). Returns total plaintext size. */
export async function fetchCloudSessionSize(id: string, signal?: AbortSignal): Promise<number> {
  const m = await getJson<{ total_size: number }>(
    apiPath(`/api/sessions/bytes/${encodeURIComponent(id)}/manifest`), signal,
  );
  return m.total_size ?? 0;
}
```

Verified against `shared/types.ts`: the field list above covers every required `Session` member. The `as Session` cast IS required — `agent`/`state`/`displayState` are string unions (`SessionAgent`, `SessionState`, `DisplayState`) and the cloud metadata types them as plain `string`. Keep the cast with this comment: `// cast: cloud metadata carries agent/state as plain strings; runtime values match the unions`. Never `as any`.

Note: `fetchSessionEvents`'s `around` param is unsupported by the cloud endpoint but unreachable in cloud — `focusEventId` is only ever passed from Spotlight, which is hidden (verified: SessionInspector/index.tsx:109, Props line 29).

- [ ] **Step 2: Cloud branches in `sessions-api.ts`**

At the top: `import { caps } from "../caps";` and the cloud module. Branch the read functions:

- `fetchSessions()`: `if (caps.cloud) return fetchCloudSessions(signal);`
- `fetchSession(id)`: `if (caps.cloud) return fetchCloudSession(id, signal);`
- `fetchSessionEvents(...)`: NO branch needed — the cloud endpoint matches the contract (apiPath already routes it). Leave as-is.
- `fetchSessionEventRaw(...)`: `if (caps.cloud) return null;` (no raw endpoint remotely — the inspector already tolerates null raw; verify the expand UI shows its fallback rather than spinning: read ToolTurn.tsx and if it spins forever on null, render "raw transcript not available in remote view" — small conditional).
- `fetchSessionArtifacts(id)`: `if (caps.cloud) return [];`
- `fetchSessionMemory(id)`: `if (caps.cloud) return { written: [], pulled: [] };`
- `searchTranscripts(...)`: `if (caps.cloud) return [];` (search is deferred)
- `resumeSession(...)`: leave — its UI affordance is hidden in Task 4 (belt: `if (caps.cloud) throw new Error("not available in remote view");`).

- [ ] **Step 3: Polling fallback in `ui-events.ts`**

The module currently creates one EventSource. Gate it:

```ts
import { caps } from "../caps";
```

In the connect path: when `!caps.hasSse`, do not create an EventSource. Instead start a visible-tab interval that emits a synthetic `session_changed` to all listeners every 12s (reuse the existing synthetic-emit code path used on visibility-change), pausing when `document.visibilityState !== "visible"` (clear interval on hide, restart on show — the file already listens to visibilitychange). Keep the subscribe/unsubscribe API identical so no caller changes.

- [ ] **Step 4: Verify**

Run: `cd web && npx tsc -b && npm run lint && npm run build:cloud`
Expected: clean. Manual (local regression): `npm run dev` → sessions list + inspector + live updates still work locally (SSE path untouched).

- [ ] **Step 5: Commit**

```bash
git add web/src/data
git commit -m "web: cloud session adapter + polling fallback for SSE"
```

---

### Task 3: Route base + App.tsx capability gating

**Files:**
- Modify: `web/src/App.tsx`

- [ ] **Step 1: Route base helpers**

In `App.tsx` (or a tiny `web/src/route-base.ts` if App.tsx imports get awkward):

```ts
import { caps } from "./caps";

/** Client routes live under /app in the cloud build. */
const stripBase = (pathname: string) =>
  caps.routeBase && pathname.startsWith(caps.routeBase)
    ? pathname.slice(caps.routeBase.length) || "/"
    : pathname;
const withBase = (path: string) => `${caps.routeBase}${path}`;
```

- `getUrlState()` parses `stripBase(window.location.pathname)` instead of the raw pathname.
- Every `history.pushState(null, "", "/s/...")` site wraps the target with `withBase(...)` — grep BOTH `pushState` AND `replaceState` in App.tsx (space change, project scope handler, artifact deep-link, popstate writes; ~5+ sites).

- [ ] **Step 2: Gate local-only mounts**

With `caps` imported, gate at the JSX mount points (explorer refs):
- ChatBar (~line 882): `{caps.canChat && <ChatBar .../>}`
- TerminalWindow (~765): `{caps.canChat && ...}`
- SetupProposalPanel (~904): `{caps.canWrite && ...}`
- SpotlightSearch (~895): `{caps.canChat && ...}` (v1: hidden in cloud — transcript search returns [] anyway)
- PublishModal (~848): leave mounted (publication management works in cloud).
- ViewerWindow (~713): leave mounted but cloud artifact-open routes through Task 6's share-link behaviour (the cloud Artefacts tab opens share URLs directly; local viewer flow is unreachable in cloud since `/api/artifacts` returns [] — see Task 6).
- SSE handler effect (~217-265): the subscription itself now degrades via ui-events polling; the `open_artifact`/`switch_space`/`open_session`/`terminal_session_linked`/`setup_*` handlers only fire from real SSE, so no change needed.
- Bottom padding: the layout reserves space for ChatBar (Home.css `padding-bottom: 240px`). Set a class on the root element: `<div className={`app${caps.canChat ? "" : " app--no-chatbar"}`}>` (match the real root className) and in Task 8's CSS, zero the reserved padding under `.app--no-chatbar`.

- [ ] **Step 3: Verify**

Run: `cd web && npx tsc -b && npm run lint && npm run build && npm run build:cloud` — clean.
Manual (local regression): `npm run dev` → ChatBar, terminals, Spotlight, setup panel all still present and working; URLs unchanged.

- [ ] **Step 4: Commit**

```bash
git add web/src/App.tsx web/src/route-base.ts 2>/dev/null || git add web/src/App.tsx
git commit -m "web: route base for /app + capability-gated mounts"
```

---

### Task 4: Home gating + device filter chip

**Files:**
- Modify: `web/src/components/Home/index.tsx`, `web/src/components/Home/SessionRow.tsx`, `web/src/components/Home/MemoryCard.tsx`, `web/src/components/Home/ArtefactTable.tsx`, `web/src/components/Home/Home.css`

- [ ] **Step 1: Hide scope navigation and writes (`caps` import in each file)**

In `Home/index.tsx`:
- Space pills row + Home/Vault/shield pills: wrap the breadcrumb/pill block with `{caps.hasScopes && (...)}` (the block above the title; locate via the space-pill onClick handlers). The scope crumb in the tab strip (~1200-1212) renders only when a project is selected — unreachable in cloud (no grid) — leave as-is.
- Projects grid section: wrap its `isHomeView && ...` section with `caps.hasScopes &&`.
- New-session pill / `onOpenNewSession` affordances: gate with `caps.canChat`.
- Space delete link + ConfirmModal (~1136-1146, 1678-1713), AttachOrphanPopover + FolderPlus (~1063-1083, 1626-1663), AttachFolderForm (~1150-1158), SpaceContextMenu (~1664-1676): all behind `caps.canWrite` (most are already conditional on optional callbacks — the cleanest gate is in App.tsx: pass those callbacks as `undefined` when `!caps.canWrite`, which reuses the existing conditionals; prefer that over new JSX wraps wherever a callback prop already gates the JSX).
- Memories tab: "Add memory" button + AddMemoryForm (~1513-1557) behind `caps.canWrite`; refresh button stays.
- `live-terminals` ("running") filter chip: presence comes from local PTYs — exclude `"live-terminals"` from `FILTER_ORDER` when `!caps.canChat` (filter the array at render).

In `SessionRow.tsx`: Connect (~130-138) and Resume (~140-148) buttons behind `caps.canChat`. Artifact chips (`recentArtifacts`, ~158-172) render only when data exists — cloud sessions have none; no change.
In `MemoryCard.tsx`: delete button (line ~23) behind `caps.canWrite`.
In `ArtefactTable.tsx`: context-menu items pin/unpin behind `caps.canWrite`; publish/unpublish/access-mode items behind `caps.canManagePublications` (kept in cloud).

- [ ] **Step 2: Device filter chip (cloud-only addition)**

In `Home/index.tsx`, next to the state-filter chips (~1217-1241):

```tsx
{caps.cloud && deviceLabels.length > 1 && (
  <>
    <span className="home-filter-divider" aria-hidden="true" />
    {deviceLabels.map((d) => (
      <button
        key={d}
        type="button"
        className={`stat-btn${deviceFilter === d ? " active" : ""}`}
        onClick={() => setDeviceFilter(deviceFilter === d ? null : d)}
      >
        {d}
      </button>
    ))}
  </>
)}
```

With, near the other view state:

```ts
const [deviceFilter, setDeviceFilter] = useState<string | null>(null);
// Distinct origin-device labels — the cloud view's primary grouping.
const deviceLabels = useMemo(() => {
  const out = new Set<string>();
  for (const s of sessions) if (s.originDeviceLabel) out.add(s.originDeviceLabel);
  return [...out].sort();
}, [sessions]);
```

And in the visible-sessions memo (where stateFilter applies, ~line 368-373), add: `if (deviceFilter) list = list.filter((s) => s.originDeviceLabel === deviceFilter);`
Reuse the existing `.stat-btn` chip styles; if a divider class doesn't exist, reuse the one from the filter row (~1237).

- [ ] **Step 3: Untitled sessions fallback**

Cloud sessions with null titles currently render raw UUIDs. In `SessionRow.tsx`'s title rendering, the existing label logic already falls back to cwd basename for the project column; for the *title*, add the same fallback: `session.title ?? cwdBasename ?? session.id.slice(0, 8)` (match how the local row derives `cwdBasename`). This also improves local.

- [ ] **Step 4: Verify**

Run: `cd web && npx tsc -b && npm run lint && npm run build && npm run build:cloud` — clean.
Manual (local regression): `npm run dev` → pills/grid/writes all still present locally; device chips do NOT appear (caps.cloud false); session titles unchanged except untitled ones now show cwd basename.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/Home
git commit -m "home: capability gating + cloud device filter chip + untitled fallback"
```

---

### Task 5: SessionInspector cloud live tail

**Files:**
- Modify: `web/src/components/SessionInspector/index.tsx` (one added effect), `web/src/components/SessionInspector/ToolTurn.tsx` (raw fallback, only if Step 2 of Task 2 found it spins)

- [ ] **Step 1: Manifest-polling live tail**

The inspector already appends new events when `session_changed` fires (debounced `after:` fetch). Cloud polling (Task 2) fires that every 12s — but an `after:` fetch decrypts the tail chunk server-side, so don't lean on it for liveness. Add a faster, cheaper, cloud-only effect after the existing live-update effect:

```ts
// Cloud live tail: poll the chunk manifest (D1-only, no R2 decrypt on the
// worker) and fetch events only when the transcript actually grew. The
// SSE path doesn't exist remotely. Spec: 2026-06-05-cloud-remote-view.
useEffect(() => {
  if (!caps.cloud) return;
  if (!session || !["active", "waiting"].includes(session.state)) return;
  let lastSize = -1;
  let stop = false;
  const tick = async () => {
    if (stop || document.visibilityState !== "visible") return;
    try {
      const size = await fetchCloudSessionSize(sessionId);
      if (lastSize >= 0 && size > lastSize) refreshAfterCursor();
      lastSize = size;
    } catch { /* transient — next tick retries */ }
  };
  const t = setInterval(tick, 5_000);
  tick();
  return () => { stop = true; clearInterval(t); };
}, [sessionId, session?.state]);
```

`refreshAfterCursor` = the existing `refetchLive` closure (defined INSIDE the live-update effect at line ~154 — it cannot be called from a sibling effect as-is). Extract it using the file's existing `loadOlderRef` pattern (line ~220): store the callback in a ref the SSE effect populates, and have the cloud effect call `refetchLiveRef.current?.()`. Do NOT duplicate the append logic. Import `fetchCloudSessionSize` from the cloud adapter and `caps`.

- [ ] **Step 2: Cloud-mode adjustments to the existing live/paging paths**

(a) Gate the existing `session_changed` live-append effect with `caps.hasSse` (add an early `if (!caps.hasSse) return;`): in cloud mode the 12s synthetic poll from ui-events would otherwise trigger an `{after}` fetch — which decrypts the tail chunk server-side — every tick even when idle. The manifest poll above is the ONLY live driver in cloud.

(b) Short-page paging fix: the cloud endpoint caps work at 4 chunks per request, so a non-empty page SHORTER than `PAGE_SIZE` can still have older history (e.g. chunks dense with skipped protocol lines). At both `setHasMoreOlder` sites (bootstrap ~line 121, load-older ~line 235), branch:

```ts
setHasMoreOlder(caps.cloud ? page.length > 0 : page.length >= PAGE_SIZE);
```

(`page` = the fetched array at that site — `ev`/`older` respectively.) In cloud, only an EMPTY page means exhausted.

Run: `cd web && npx tsc -b && npm run lint && npm run build:cloud` — clean.
Manual (local regression): inspector still live-appends locally via SSE; load-older paging unchanged locally.

- [ ] **Step 4: Commit**

```bash
git add web/src/components/SessionInspector
git commit -m "inspector: manifest-polling live tail for cloud mode"
```

---

### Task 6: Artefacts tab = publications (cloud)

**Files:**
- Create: `web/src/data/cloud-publications.ts`
- Modify: `web/src/data/artifacts-api.ts` (cloud branches), `web/src/components/Home/index.tsx` (artefacts tab cloud source), `web/src/components/Home/ArtefactTable.tsx` (open behaviour)

- [ ] **Step 1: Create `web/src/data/cloud-publications.ts`**

```ts
// cloud-publications.ts — the cloud Artefacts tab shows what you've
// PUBLISHED (oyster-publish worker, apex /api/publish/* — same origin as
// /app, Origin header allowlisted for mutations). Publications are mapped
// into Artifact-shaped objects so the existing tab renders them unchanged.
import type { Artifact } from "../../../shared/types";
import { getJson, del, patchJson } from "./http";

interface Publication {
  share_token: string;
  artifact_id: string;
  artifact_kind: string;
  mode: "open" | "password" | "signin";
  content_type: string;
  size_bytes: number;
  published_at: number;
  updated_at: number;
  label: string | null;
  space_id: string | null;
}

export const shareUrl = (token: string) => `https://share.oyster.to/p/${token}`;

function toArtifact(p: Publication): Artifact {
  return {
    id: p.artifact_id,
    label: p.label ?? `${p.artifact_kind} · ${p.share_token.slice(0, 8)}`,
    url: shareUrl(p.share_token),
    artifactKind: p.artifact_kind,
    sourceOrigin: "manual",
    // Full ArtefactPublication shape (shared/types.ts:65) — the UI reads
    // `shareMode` and treats `unpublishedAt === null` as "live"; a partial
    // object makes every publication invisibly filtered out.
    publication: {
      shareToken: p.share_token,
      shareUrl: shareUrl(p.share_token),
      shareMode: p.mode,
      publishedAt: p.published_at,
      updatedAt: p.updated_at,
      unpublishedAt: null, // /api/publish/mine returns live publications only
    },
    createdAt: new Date(p.published_at).toISOString(),
    spaceId: p.space_id,   // Artifact.spaceId is `string` — null is benign here
    status: "online",
    runtimeKind: "",
    runtimeConfig: {},
  } as Artifact;
}

export async function fetchCloudPublications(signal?: AbortSignal): Promise<Artifact[]> {
  const data = await getJson<{ publications: Publication[] }>("/api/publish/mine", signal);
  return (data.publications ?? []).map(toArtifact);
}

export function unpublishCloud(token: string): Promise<void> {
  return del<void>(`/api/publish/${encodeURIComponent(token)}`);
}

export function setCloudAccessMode(token: string, mode: "open" | "signin"): Promise<void> {
  return patchJson<void>(`/api/publish/${encodeURIComponent(token)}`, { mode });
}
```

Verified against the code (don't re-derive): `http.ts` exports `getJson`/`patchJson`/`del` (patchJson/del return `Promise<T>` — hence the `<void>` type args; if `del` isn't generic, drop the arg and adjust). `ArtefactPublication` real fields are `shareToken, shareUrl, shareMode, publishedAt, updatedAt, unpublishedAt` — `mode` is WRONG, the UI reads `shareMode` (ArtefactTable.tsx:258, Desktop.tsx:310) and checks `unpublishedAt === null`. `Artifact` requires `status`/`runtimeKind`/`runtimeConfig` (defaults above). oyster-publish PATCH accepts `{mode}` for open↔signin (worker.ts:522-538; password transitions need `password_hash` — out of scope). Exact value for `status`: check the `ArtifactStatus` union in shared/types.ts and use its idle/ready member. NOTE: `/api/publish/*` are apex paths NOT under `/app/api` — do not wrap with `apiPath`.

- [ ] **Step 2: Wire into the Artefacts tab**

`artifacts-api.ts`: `fetchArtifacts()` → `if (caps.cloud) return fetchCloudPublications(signal);`; `listArchivedArtifacts()` → `if (caps.cloud) return [];`. The Home artefacts tab then populates with publications through the existing data flow (App fetches artifacts → desktopProps). 
Open behaviour: in cloud mode a tile/row click opens the share URL in a new tab instead of the local viewer. Find the artifact-click dispatch (App.tsx `onArtifactClick`, ~435-476): at its top, `if (caps.cloud) { window.open(a.url, "_blank", "noopener"); return; }`.
ArtefactTable context menu: wire unpublish → `unpublishCloud(token)` + refetch, access mode open↔signin → `setCloudAccessMode` + refetch, when `caps.cloud` (the local handlers call local endpoints; branch at the handler callsite). **Trap:** ArtefactTable.tsx:149 and Desktop.tsx:338 already call `unpublishCloudShare` from `publish-api.ts`, which hits the LOCAL server proxy route (`/api/publish/by-token/:token/unpublish`) — that 404s in the cloud build. Branch those existing callsites on `caps.cloud` → `unpublishCloud`, don't only add new handlers. Source/kind filter chips and icons/table toggle work unchanged (verified: tiles render icons only — no iframe/preview of `url`, so external share URLs are safe in the icons view).

- [ ] **Step 3: Verify**

Run: `cd web && npx tsc -b && npm run lint && npm run build && npm run build:cloud` — clean. Local regression: artefacts tab unchanged locally (tiles, viewer open, pin/publish menus).

- [ ] **Step 4: Commit**

```bash
git add web/src/data web/src/components/Home web/src/App.tsx
git commit -m "web: cloud artefacts tab = publications with share-link open + light actions"
```

---

### Task 7: Memories tab (cloud fold)

**Files:**
- Create: `web/src/data/cloud-memories.ts`
- Modify: `web/src/data/memories-api.ts` (cloud branch)

- [ ] **Step 1: Create `web/src/data/cloud-memories.ts`**

```ts
// cloud-memories.ts — the worker stores memories as an EVENT LOG
// (created/forgotten/purged); there is no materialized read API. Fold the
// log into current state client-side: a memory is live iff it has a
// created event with a payload and no forgotten/purged tombstone.
import type { Memory } from "./memories-api"; // Memory lives there, NOT in shared/types
import { getJson, apiPath } from "./http";

interface MemoryEvent {
  event_id: string;
  memory_id: string;
  event_type: "memory_created" | "memory_forgotten" | "memory_purged";
  space_id: string | null;
  created_at: number;
  payload?: { content: string | null; tags: string[]; purged_at: number | null };
}

export async function fetchCloudMemories(signal?: AbortSignal): Promise<Memory[]> {
  const data = await getJson<{ events: MemoryEvent[] }>(
    apiPath("/api/memories/events"), signal,
  );
  const dead = new Set<string>();
  const live = new Map<string, Memory>();
  for (const ev of data.events ?? []) {
    if (ev.event_type !== "memory_created") { dead.add(ev.memory_id); continue; }
    if (!ev.payload || ev.payload.content == null || ev.payload.purged_at != null) continue;
    live.set(ev.memory_id, {
      id: ev.memory_id,
      content: ev.payload.content,
      tags: ev.payload.tags ?? [],
      space_id: ev.space_id,
      created_at: new Date(ev.created_at).toISOString(),
      source_session_id: null, // not carried by the sync event log
    } as Memory);
  }
  for (const id of dead) live.delete(id);
  return [...live.values()].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}
```

Verify the `Memory` type's remaining fields against `web/src/data/memories-api.ts:5` (it's snake_case; `source_session_id` is required — defaulted above) and whether `created_at` is rendered as ISO or epoch — match what MemoryCard expects. `GET /api/memories/events` is NOT paginated (verified: worker.ts handleMemoryEventsGet returns everything) — no cursor-following needed.

- [ ] **Step 2: Branch + verify + commit**

`memories-api.ts`: `fetchMemories()` → `if (caps.cloud) return fetchCloudMemories(signal);` (space_id arg ignored in cloud — scoping is hidden).
Run: `cd web && npx tsc -b && npm run lint && npm run build:cloud` — clean. Local regression: memories tab unchanged.

```bash
git add web/src/data
git commit -m "web: cloud memories tab folds the sync event log"
```

---

### Task 8: Responsive pass (benefits local too)

**Files:**
- Modify: `web/src/components/Home/Home.css`, `web/src/components/InspectorPanel.css`, `web/src/App.css`

This is a CSS-only pass; validate on a real phone in Task 10. Targets (the table itself already collapses at 720px — Home.css:739):

- [ ] **Step 1: Home.css additions** (append, in one `@media (max-width: 640px)` block unless a rule must live elsewhere):

```css
/* ——— Mobile collapse (cloud remote view dogfood; applies locally too) ——— */
@media (max-width: 640px) {
  /* Header: 80px/32px desktop padding eats a phone screen. */
  .home-header { padding: 28px 16px 0; }
  .home-title { font-size: 28px; }
  /* Tab strip: full-width, horizontally scrollable, no wrap. */
  .home-tabs { overflow-x: auto; scrollbar-width: none; }
  .home-tabs::-webkit-scrollbar { display: none; }
  .home-tab { padding: 8px 10px; white-space: nowrap; }
  .home-tab-scope { display: none; } /* crumb is desktop chrome */
  /* Filter chips wrap to two rows rather than overflowing. */
  .home-section-head { flex-wrap: wrap; row-gap: 6px; }
  /* Sections breathe less. */
  .home-section { padding: 0 16px; }
}
```

Match the real class names — `.home-header`/`.home-section` etc. are indicative; read Home.css and use the actual selectors for the header block, title, and section padding. Keep the block at the END of the file with the banner comment.

- [ ] **Step 2: Inspector full-screen on phones** (InspectorPanel.css):

```css
/* Phone: the side drawer becomes a full-screen takeover. */
@media (max-width: 640px) {
  .inspector-panel { width: 100vw; }
}
```

(Real class name from InspectorPanel.css:21 — whatever rule sets `width: min(640px, 92vw)` gets the override. Verify the close affordance is reachable — the header back/close button must remain visible; adjust its position only if it relied on the panel edge.)

- [ ] **Step 3: ChatBar padding reservation** (Home.css or App.css — wherever `padding-bottom: 240px` lives, ~Home.css:81):

```css
/* No ChatBar in the cloud build — reclaim its reserved fade space. */
.app--no-chatbar .home-scroll { padding-bottom: 32px; }
```

(Adjust both selectors to the real root + scroll-container class names from Task 3's root class.)

- [ ] **Step 4: Verify + commit**

Run: `cd web && npx tsc -b && npm run lint && npm run build` — clean.
Manual (local, desktop): `npm run dev` → resize browser to 390px width: tabs scroll horizontally, header compact, sessions table in its 3-col collapsed form, inspector takes the full window, nothing overflows horizontally. Resize back to desktop: identical to before.

```bash
git add web/src/components/Home/Home.css web/src/components/InspectorPanel.css web/src/App.css
git commit -m "web: mobile collapse pass (header, tabs, chips, full-screen inspector)"
```

---

### Task 9: Worker serves the cloud build at /app

**Files:**
- Modify: `infra/oyster-cloud/wrangler.toml`, `infra/oyster-cloud/src/worker.ts`, `infra/oyster-cloud/src/app-shell.ts` (slims to the auth page + asset gate), `infra/oyster-cloud/vitest.config.ts` + `infra/oyster-cloud/test/app-shell.test.ts`

- [ ] **Step 1: wrangler assets block**

In `infra/oyster-cloud/wrangler.toml` (precedent: `infra/oyster-arcade-site/wrangler.toml:11-14`):

```toml
# Cloud remote view SPA (web/ built with VITE_OYSTER_MODE=cloud, base /app/).
# Run `npm run build:cloud` at the repo root before deploying.
[assets]
directory = "../../web/dist-cloud"
binding = "ASSETS"
# The worker gates /app itself; unknown paths under /app are SPA routes.
not_found_handling = "single-page-application"
run_worker_first = true
```

Check wrangler 4.x docs/behaviour for `run_worker_first` (the worker must keep handling `/api/*` and auth-gating `/app`; if the installed wrangler version doesn't support it, the routes config already only sends `/app*` + `/api/*` to this worker and assets are only reachable through worker code — verify with `wrangler dev` and adjust). Add `ASSETS: Fetcher` to the `Env` type (src/session.ts or wherever Env lives).

- [ ] **Step 2: Worker dispatch — auth-gated SPA**

Rework the three `/app` blocks in `worker.ts`. ⚠️ **ORDER IS LOAD-BEARING and CHANGES from today's:** currently the shell block (exact `/app` match) sits BEFORE the `/app/api/` rewrite. The new catch-all uses `startsWith("/app/")`, which would swallow `/app/api/*` if left in the shell's current position — every SPA API call would get index.html. The final order MUST be:

```ts
    // 1) www → apex (unchanged)
    if (url.hostname === "www.oyster.to" && url.pathname.startsWith("/app")) {
      return Response.redirect(`https://oyster.to${url.pathname}${url.search}`, 308);
    }
    // 2) /app/api/* → /api/* rewrite (unchanged — MUST run before the
    //    catch-all below, which would otherwise swallow API calls)
    if (url.pathname.startsWith("/app/api/")) {
      url.pathname = url.pathname.slice("/app".length);
    }
    // 3) Everything else under /app is the SPA: hashed assets are public,
    //    navigations are auth-gated (signed-out → sign-in page).
    if (url.pathname === "/app" || url.pathname.startsWith("/app/")) {
      if (req.method !== "GET") return jsonError(405, "method_not_allowed");
      return handleAppShell(req, env, url);
    }
```

(A rewritten `/app/api/...` request no longer starts with `/app/`, so block 3 never sees it. The Task 9 tests assert this explicitly.)

And `app-shell.ts` becomes the gate + asset proxy (keep `esc`, `page`, the 401 sign-in HTML; drop the whoami body):

```ts
/** Serve the cloud SPA: hashed assets pass straight through to the ASSETS
 *  binding; navigations (index.html) require a signed-in user. */
export async function handleAppShell(req: Request, env: Env, url: URL): Promise<Response> {
  const sub = url.pathname.slice("/app".length) || "/";
  // Hashed asset requests (js/css/img) — public, immutable, no auth.
  if (sub.startsWith("/assets/") || /\.(js|css|svg|png|ico|woff2?)$/.test(sub)) {
    return env.ASSETS.fetch(new Request(new URL(sub, url.origin), req));
  }
  // Everything else is a navigation → auth-gate, then SPA index.
  const user = await resolveSession(req, env);
  if (!user) {
    return new Response(page(SIGN_IN_BODY), { status: 401, headers: HTML_HEADERS });
  }
  return env.ASSETS.fetch(new Request(new URL("/", url.origin), req));
}
```

Notes: the Vite build uses base `/app/`, so the html references `/app/assets/*` — those arrive back at this worker via the `oyster.to/app*` route and hit the asset branch. The ASSETS binding is keyed WITHOUT the `/app` prefix (directory root = dist-cloud), hence the `sub` strip. Verify `not_found_handling` SPA behaviour returns index.html for `/` — if the binding needs the literal `/index.html`, use that. Keep the pro-tier nuance consistent with the API: a signed-in FREE user gets the index (the APIs will 403; acceptable v1 — note it).

- [ ] **Step 3: Tests**

Update `test/app-shell.test.ts`: the vitest-pool-workers config needs the assets binding — in `vitest.config.ts` miniflare options add `assets: { directory: "./test/fixtures/app-assets", binding: "ASSETS" }` (create the fixture dir with a minimal `index.html` containing `<div id="root">oyster</div>` and `assets/app.js` containing `// fixture`). If the installed @cloudflare/vitest-pool-workers version doesn't support an assets binding (check its docs/types — `defineWorkersConfig` miniflare `assets` option), instead extract the path logic (`sub` computation + asset-vs-navigation classification) into a pure exported function and unit-test that, with the binding behaviour covered by the Task 10 deploy check. Tests to keep/adapt:
- unauth GET /app → 401 HTML containing "Sign in" (unchanged)
- auth GET /app → 200 HTML (now asserts the fixture index content, not "Signed in as")
- auth GET /app/assets/app.js → 200 WITHOUT auth too (public assets): assert both
- GET /app/api/sessions/metadata with cookie → 200 JSON with a `sessions` property (guards the dispatch-order trap: if the catch-all swallowed the rewrite, this would return index.html — assert the content-type is application/json, not text/html)

- [ ] **Step 4: Verify + commit**

Run: `cd infra/oyster-cloud && npm test && npm run typecheck` — green.
Run: `cd ../.. && npm run build:cloud` then `cd infra/oyster-cloud && npx wrangler dev` → `curl -s -o /dev/null -w "%{http_code}" http://localhost:8787/app` → 401 (no cookie, real gate working against local assets).

```bash
git add infra/oyster-cloud
git commit -m "oyster-cloud: serve the cloud SPA at /app (auth-gated, SPA fallback)"
```

---

### Task 10: Deploy + phone E2E + PR

- [ ] **Step 1: Full verification**

```bash
cd web && npx tsc -b && npm run lint && cd .. && npm run build && npm run build:cloud
cd infra/oyster-cloud && npm test && npm run typecheck
cd ../../server && npm test
```
All green (server suite guards the shared types the adapters import).

- [ ] **Step 2: Deploy**

```bash
npm run build:cloud
cd infra/oyster-cloud && npx wrangler deploy
```

- [ ] **Step 3: E2E — laptop browser (signed in)**

`https://oyster.to/app` → the real UI: tab strip, sessions list with device chips (only if >1 device — with one device, no chips: expected), state filters work, tap a session → inspector with transcript, scroll up pages older events, Artefacts tab lists publications (tap → share page in new tab; ⋯ unpublish works), Memories tab lists current memories. Signed-out incognito → 401 sign-in page. `wrangler rollback` is the escape hatch.

- [ ] **Step 4: E2E — phone**

Same checks at 390px: tabs scroll, header compact, session rows readable, inspector full-screen with reachable back button, live session tail appends within ~5s while an agent runs on the laptop.

- [ ] **Step 5: PR**

```bash
git push -u origin cloud-remote-view-ui
gh pr create --title "Cloud remote view: UI slice (cloud-mode build at oyster.to/app)" --body "<summary: caps module, cloud adapters, live tail, publications tab, memories fold, responsive pass, worker asset serving. Spec + plan links. Scope notes: space pills + project grid hidden in cloud (no space_id/project_id in synced metadata yet); transcript search + raw expand deferred. No changelog entry — flip when this is announced to users.>"
```

---

## Deferred (explicit non-goals of this slice)

- Space-pill scoping + project grid in cloud (needs `space_id`/`project_id` in synced session metadata — a backend follow-up)
- Transcript search, raw tool-turn expand (needs worker endpoints)
- Session→artifact/memory joins in the inspector (cloud returns empty)
- `app.oyster.to` migration (code-exchange handshake + origin allowlists)
- Password access mode management from cloud
- Mid-session token expiry → dedicated signed-out state (spec's error-handling item). v1: navigations re-hit the worker gate (401 page); in-page fetches surface as errors. A `useFetched` 401 interceptor that swaps to a sign-in panel is a fast follow.
- CHANGELOG entry — this is still dogfood; add one when remote view is announced
