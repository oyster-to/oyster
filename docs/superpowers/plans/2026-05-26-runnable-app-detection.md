# Runnable-App Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect a project's runnable web app (Vite/Next) from `package.json` and surface it as both an in-memory `local_process` artefact (reusing the existing launch+preview) and a chip on the project tile — derived, no DB row, no on-disk marker.

**Architecture:** A single pure resolver classifies the `dev` script and produces the canonical app descriptor (`id: app:<projectId>`). The project service exposes a derived `app?` field for the tile chip; the artifact service appends derived `local_process` artefacts in `getAllArtifacts` via an injected provider. Process-manager owns derived-app runtime state (`{appId → port, pid, child}`) — a port is allocated only at start, and status comes from child liveness. The DB-app launch path is left untouched (a parallel, argv-based runtime is added rather than refactoring the existing `startApp`).

**Tech Stack:** TypeScript, Node, better-sqlite3, vitest (`server/test/`). Web: React (no test runner — web steps are manual verification). Spec: `docs/superpowers/specs/2026-05-26-runnable-app-detection-design.md`.

---

## File Structure

- **Create** `server/src/runnable-app.ts` — pure detection + descriptor building: `classifyDevScript`, `buildLaunchArgv`, `resolveRunnableApp`, `buildDerivedAppArtifacts`. One responsibility: "given a project, what runnable app (if any) and how to launch it."
- **Create** `server/test/runnable-app.test.ts` — unit tests for the above.
- **Modify** `server/src/process-manager.ts` — add derived-app runtime: `runningApps` map, `startAppById`, `stopAppById`, `getRunningApp`, `findFreePort`. Leave `startApp`/`stopApp`/`procs` (DB-app path) untouched.
- **Create** `server/test/process-manager-derived.test.ts` — runtime lifecycle tests.
- **Modify** `server/src/project-service.ts` — add `app?` to `Project`; populate it in the per-project derivation.
- **Modify** `server/test/project-service.test.ts` — chip-field tests.
- **Modify** `server/src/artifact-service.ts` — `setDerivedAppProvider` + merge in `getAllArtifacts`.
- **Modify** `server/test/artifact-service.test.ts` — derived-merge + dedupe tests.
- **Modify** `server/src/routes/static.ts` — start/stop routes resolve derived apps.
- **Modify** `server/src/index.ts` — wire the provider + static-route deps.
- **Modify** `web/src/data/projects-api.ts` — `Project.app?` type.
- **Modify** `web/src/components/Home/ProjectTile.tsx` (+ `ProjectTileGrid.tsx`, `Home/index.tsx`, `App.tsx` as needed) — render the chip + `onOpenApp` wiring.
- **Modify** `CHANGELOG.md`.

All server test commands run from `server/`: `cd server && npx vitest run <path>`.

---

## Task 1: Pure dev-script classifier + launch-argv builder

**Files:**
- Create: `server/src/runnable-app.ts`
- Test: `server/test/runnable-app.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// server/test/runnable-app.test.ts
import { describe, it, expect } from "vitest";
import { classifyDevScript, buildLaunchArgv } from "../src/runnable-app.js";

describe("classifyDevScript", () => {
  it("classifies bare vite as vite", () => {
    expect(classifyDevScript("vite")).toEqual({ framework: "vite" });
  });
  it("classifies vite with trailing flags as vite", () => {
    expect(classifyDevScript("vite --host 0.0.0.0")).toEqual({ framework: "vite" });
  });
  it("classifies `vite dev` alias as vite", () => {
    expect(classifyDevScript("vite dev")).toEqual({ framework: "vite" });
  });
  it("classifies next dev (with turbopack) as next", () => {
    expect(classifyDevScript("next dev --turbopack")).toEqual({ framework: "next" });
    expect(classifyDevScript("next dev -H 0.0.0.0")).toEqual({ framework: "next" });
  });
  it("strips a leading KEY=value env assignment", () => {
    expect(classifyDevScript("NODE_ENV=dev vite")).toEqual({ framework: "vite" });
  });
  it("rejects wrappers (cross-env, concurrently) with a reason", () => {
    expect(classifyDevScript("cross-env NODE_ENV=dev vite")).toEqual({
      framework: null, reason: "unrecognized launcher: cross-env",
    });
    expect(classifyDevScript('concurrently "a" "b"').framework).toBeNull();
  });
  it("rejects non-dev vite/next subcommands with a reason", () => {
    expect(classifyDevScript("vite build")).toEqual({ framework: null, reason: "vite build is not a dev server" });
    expect(classifyDevScript("next build").framework).toBeNull();
    expect(classifyDevScript("next start").framework).toBeNull();
  });
  it("rejects empty/undefined with a reason", () => {
    expect(classifyDevScript(undefined)).toEqual({ framework: null, reason: "no dev script" });
    expect(classifyDevScript("   ").framework).toBeNull();
  });
});

describe("buildLaunchArgv", () => {
  it("builds vite argv with --port and --strictPort after `npm run dev --`", () => {
    expect(buildLaunchArgv("vite", 4500)).toEqual(
      ["npm", "run", "dev", "--", "--port", "4500", "--strictPort"]
    );
  });
  it("builds next argv with -p after `npm run dev --`", () => {
    expect(buildLaunchArgv("next", 4500)).toEqual(["npm", "run", "dev", "--", "-p", "4500"]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run test/runnable-app.test.ts`
Expected: FAIL — `classifyDevScript` / `buildLaunchArgv` not exported (module not found).

- [ ] **Step 3: Write the implementation**

```ts
// server/src/runnable-app.ts
// Detect a project's runnable web app from its package.json `dev` script,
// and build the launch invocation. Pure functions — no surprises, easily
// tested. See docs/superpowers/specs/2026-05-26-runnable-app-detection-design.md.

export type Framework = "vite" | "next";

export type ClassifyResult =
  | { framework: Framework }
  | { framework: null; reason: string };

// Classify a package.json `dev` script string. Conservative: match the leading
// executable + subcommand, never a substring. Strips a single leading KEY=value
// env assignment; does NOT unwrap wrappers (cross-env / concurrently / npm-run-all).
export function classifyDevScript(devScript: string | undefined): ClassifyResult {
  if (!devScript || !devScript.trim()) return { framework: null, reason: "no dev script" };
  const tokens = devScript.trim().split(/\s+/);
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
  const cmd = tokens[i];
  const sub = tokens[i + 1];

  if (cmd === "vite") {
    // bare `vite`, `vite dev`, or `vite --flags` → dev server.
    // `vite build` / `vite preview` (non-flag subcommand) → not a dev server.
    if (!sub || sub.startsWith("-") || sub === "dev") return { framework: "vite" };
    return { framework: null, reason: `vite ${sub} is not a dev server` };
  }
  if (cmd === "next") {
    if (sub === "dev") return { framework: "next" };
    return { framework: null, reason: `next ${sub ?? "(no subcommand)"} is not a dev server` };
  }
  return { framework: null, reason: `unrecognized launcher: ${cmd}` };
}

// Build the spawn argv. Uses `npm run dev -- <flags>` so flags pass through to
// the underlying tool regardless of what else the dev script does. npm assumed.
export function buildLaunchArgv(framework: Framework, port: number): string[] {
  const base = ["npm", "run", "dev", "--"];
  if (framework === "vite") return [...base, "--port", String(port), "--strictPort"];
  return [...base, "-p", String(port)]; // next
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run test/runnable-app.test.ts`
Expected: PASS (all `classifyDevScript` + `buildLaunchArgv` cases).

- [ ] **Step 5: Commit**

```bash
git add server/src/runnable-app.ts server/test/runnable-app.test.ts
git commit -m "feat(runnable-app): pure dev-script classifier + launch-argv builder"
```

---

## Task 2: `resolveRunnableApp` — read package.json, produce the descriptor

**Files:**
- Modify: `server/src/runnable-app.ts`
- Test: `server/test/runnable-app.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `server/test/runnable-app.test.ts`:

```ts
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveRunnableApp } from "../src/runnable-app.js";

function projectAt(scripts: Record<string, string> | null): { dir: string; project: { id: string; name: string; spaceId: string | null; recentPath: string } } {
  const dir = mkdtempSync(join(tmpdir(), "oyster-rapp-"));
  if (scripts) writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", scripts }));
  return { dir, project: { id: "p-123", name: "My App", spaceId: "work", recentPath: dir } };
}

describe("resolveRunnableApp", () => {
  it("returns a descriptor with id app:<projectId> for a vite project", () => {
    const { dir, project } = projectAt({ dev: "vite" });
    const r = resolveRunnableApp(project);
    expect(r).toEqual({ app: { id: "app:p-123", label: "My App", cwd: dir, framework: "vite" } });
    rmSync(dir, { recursive: true, force: true });
  });
  it("returns a next descriptor", () => {
    const { dir, project } = projectAt({ dev: "next dev --turbopack" });
    const r = resolveRunnableApp(project);
    expect(r.app?.framework).toBe("next");
    expect(r.app?.id).toBe("app:p-123");
    rmSync(dir, { recursive: true, force: true });
  });
  it("returns null+reason for a non-launcher dev script", () => {
    const { dir, project } = projectAt({ dev: "concurrently \"a\" \"b\"" });
    expect(resolveRunnableApp(project).app).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });
  it("returns null+reason when package.json is missing", () => {
    const { dir, project } = projectAt(null);
    expect(resolveRunnableApp(project)).toEqual({ app: null, reason: "no package.json" });
    rmSync(dir, { recursive: true, force: true });
  });
  it("returns null+reason when recentPath is absent", () => {
    expect(resolveRunnableApp({ id: "p", name: "n", spaceId: null, recentPath: null }))
      .toEqual({ app: null, reason: "no recent path" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run test/runnable-app.test.ts`
Expected: FAIL — `resolveRunnableApp` not exported.

- [ ] **Step 3: Write the implementation**

Append to `server/src/runnable-app.ts`:

```ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface RunnableApp {
  id: string;        // app:<projectId>
  label: string;
  cwd: string;
  framework: Framework;
}

export type ResolveResult =
  | { app: RunnableApp }
  | { app: null; reason: string };

// The SOLE producer of a detected app's identity + launch shape. The tile chip,
// the artefact card, and the start/stop routes all call this — nothing
// reconstructs `app:<id>` or the argv on its own.
export function resolveRunnableApp(project: {
  id: string;
  name: string;
  spaceId: string | null;
  recentPath?: string | null;
}): ResolveResult {
  const cwd = project.recentPath;
  if (!cwd) return { app: null, reason: "no recent path" };
  const pkgPath = join(cwd, "package.json");
  if (!existsSync(pkgPath)) return { app: null, reason: "no package.json" };
  let pkg: { scripts?: Record<string, string> };
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  } catch {
    return { app: null, reason: "package.json parse error" };
  }
  const result = classifyDevScript(pkg.scripts?.dev);
  if (result.framework === null) return { app: null, reason: result.reason };
  return { app: { id: `app:${project.id}`, label: project.name, cwd, framework: result.framework } };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run test/runnable-app.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/runnable-app.ts server/test/runnable-app.test.ts
git commit -m "feat(runnable-app): resolveRunnableApp reads package.json → descriptor"
```

---

## Task 3: Process-manager derived-app runtime

**Files:**
- Modify: `server/src/process-manager.ts` (add new exports; do NOT change `startApp`/`stopApp`/`procs`)
- Test: `server/test/process-manager-derived.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// server/test/process-manager-derived.test.ts
import { describe, it, expect, afterEach } from "vitest";
import {
  startAppById, stopAppById, getRunningApp, findFreePort, isPortOpen,
} from "../src/process-manager.js";

const started: string[] = [];
afterEach(() => { for (const id of started.splice(0)) stopAppById(id); });

describe("derived-app runtime", () => {
  it("records a running app, then clears it on exit", async () => {
    const port = await findFreePort();
    // A trivial long-lived process we can observe + kill.
    startAppById("app:test-1", ["node", "-e", "setInterval(()=>{},1000)"], process.cwd(), port);
    started.push("app:test-1");
    expect(getRunningApp("app:test-1")).toMatchObject({ port });

    const stopped = stopAppById("app:test-1");
    expect(stopped).toBe(true);
    // Give the exit handler a tick to clear the map.
    await new Promise((r) => setTimeout(r, 50));
    expect(getRunningApp("app:test-1")).toBeUndefined();
  });

  it("clears the entry when the child errors (bad binary)", async () => {
    startAppById("app:test-2", ["this-binary-does-not-exist-xyz"], process.cwd(), 65000);
    await new Promise((r) => setTimeout(r, 50));
    expect(getRunningApp("app:test-2")).toBeUndefined();
  });

  it("findFreePort skips Oyster's own ports", async () => {
    const p = await findFreePort();
    expect(p).not.toBe(3333);
    expect(p).not.toBe(4444);
    expect(await isPortOpen(p)).toBe(false);
  });

  it("start is idempotent for the same appId", async () => {
    const port = await findFreePort();
    startAppById("app:test-3", ["node", "-e", "setInterval(()=>{},1000)"], process.cwd(), port);
    started.push("app:test-3");
    const first = getRunningApp("app:test-3");
    startAppById("app:test-3", ["node", "-e", "setInterval(()=>{},1000)"], process.cwd(), 9999);
    expect(getRunningApp("app:test-3")).toBe(first); // unchanged
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run test/process-manager-derived.test.ts`
Expected: FAIL — `startAppById` / `stopAppById` / `getRunningApp` / `findFreePort` not exported.

- [ ] **Step 3: Write the implementation**

Add to `server/src/process-manager.ts` (after the existing `procs`/`starting` declarations near the top, and alongside the existing port helpers — `isPortOpen` is already exported there):

```ts
// ── Derived-app runtime (separate from the DB-app `procs` path above) ──
// Detected runnable apps (Vite/Next) are launched here. Keyed by the derived
// app id (`app:<projectId>`). A port is allocated at start, never on read.
interface RunningApp { port: number; pid: number; child: ChildProcess; }
const runningApps = new Map<string, RunningApp>();

export function getRunningApp(appId: string): { port: number; pid: number } | undefined {
  const r = runningApps.get(appId);
  return r ? { port: r.port, pid: r.pid } : undefined;
}

export function startAppById(appId: string, argv: string[], cwd: string, port: number): void {
  if (runningApps.has(appId)) return; // idempotent
  starting.add(appId);
  const child = spawn(argv[0], argv.slice(1), { cwd, stdio: "pipe" });
  runningApps.set(appId, { port, pid: child.pid ?? -1, child });
  // BOTH exit and error must clear state, or status sticks at "starting" / a
  // stale "offline"-with-old-port. A failed spawn fires "error", not "exit".
  const cleanup = () => { runningApps.delete(appId); starting.delete(appId); };
  child.on("exit", cleanup);
  child.on("error", cleanup);
  child.stdout?.on("data", (d: Buffer) => process.stdout.write(`[${appId}] ${d}`));
  child.stderr?.on("data", (d: Buffer) => process.stderr.write(`[${appId}] ${d}`));
}

export function stopAppById(appId: string): boolean {
  const r = runningApps.get(appId);
  if (!r) return false;
  r.child.kill("SIGTERM");
  runningApps.delete(appId);
  starting.delete(appId);
  return true;
}

// Find a free TCP port, skipping Oyster's own (3333 dev / 4444 installed).
export async function findFreePort(start = 4500): Promise<number> {
  const skip = new Set([3333, 4444]);
  for (let p = start; p < start + 1000; p++) {
    if (skip.has(p)) continue;
    if (!(await isPortOpen(p))) return p;
  }
  throw new Error("no free port found");
}
```

Also extend the existing `cleanup()` at the bottom of the file (the `SIGINT`/`SIGTERM` handler that does `procs.forEach((p) => p.kill())`) to also kill derived apps:

```ts
function cleanup() {
  procs.forEach((p) => p.kill());
  runningApps.forEach((r) => r.child.kill()); // ← add
  process.exit();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run test/process-manager-derived.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/process-manager.ts server/test/process-manager-derived.test.ts
git commit -m "feat(process-manager): derived-app runtime (start/stop/status/free-port)"
```

---

## Task 4: `buildDerivedAppArtifacts` — projects + runtime → Artifact[]

**Files:**
- Modify: `server/src/runnable-app.ts`
- Test: `server/test/runnable-app.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `server/test/runnable-app.test.ts`:

```ts
import { buildDerivedAppArtifacts } from "../src/runnable-app.js";

describe("buildDerivedAppArtifacts", () => {
  function mkVite() {
    const dir = mkdtempSync(join(tmpdir(), "oyster-bda-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
    return dir;
  }

  it("emits an offline local_process app for a runnable project with no running child", async () => {
    const dir = mkVite();
    const apps = await buildDerivedAppArtifacts(
      [{ id: "p1", name: "Site", spaceId: "work", recentPath: dir }],
      { getRunningApp: () => undefined, isStarting: () => false, isPortOpen: async () => false },
    );
    expect(apps).toHaveLength(1);
    expect(apps[0]).toMatchObject({
      id: "app:p1", artifactKind: "app", runtimeKind: "local_process",
      status: "offline", url: "", sourceOrigin: "discovered", projectId: "p1", spaceId: "work",
    });
    rmSync(dir, { recursive: true, force: true });
  });

  it("emits online with a url when a child is running and the port is open", async () => {
    const dir = mkVite();
    const apps = await buildDerivedAppArtifacts(
      [{ id: "p1", name: "Site", spaceId: "work", recentPath: dir }],
      { getRunningApp: () => ({ port: 4500, pid: 1 }), isStarting: () => false, isPortOpen: async () => true },
    );
    expect(apps[0]).toMatchObject({ status: "online", url: "http://localhost:4500" });
    rmSync(dir, { recursive: true, force: true });
  });

  it("skips non-runnable projects", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oyster-bda-non-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { dev: "concurrently x" } }));
    const apps = await buildDerivedAppArtifacts(
      [{ id: "p1", name: "Mono", spaceId: "work", recentPath: dir }],
      { getRunningApp: () => undefined, isStarting: () => false, isPortOpen: async () => false },
    );
    expect(apps).toHaveLength(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it("falls back to spaceId 'home' when the project has no space", async () => {
    const dir = mkVite();
    const apps = await buildDerivedAppArtifacts(
      [{ id: "p1", name: "Site", spaceId: null, recentPath: dir }],
      { getRunningApp: () => undefined, isStarting: () => false, isPortOpen: async () => false },
    );
    expect(apps[0].spaceId).toBe("home");
    rmSync(dir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run test/runnable-app.test.ts`
Expected: FAIL — `buildDerivedAppArtifacts` not exported.

- [ ] **Step 3: Write the implementation**

Append to `server/src/runnable-app.ts`:

```ts
import type { Artifact, ArtifactStatus } from "../../shared/types.js";

export interface AppRuntimeView {
  getRunningApp(appId: string): { port: number; pid: number } | undefined;
  isStarting(appId: string): boolean;
  isPortOpen(port: number): Promise<boolean>;
}

// Map runnable projects → in-memory local_process app artefacts. Status + url
// come from runtime state (a live child + open port), never a pre-reserved port.
export async function buildDerivedAppArtifacts(
  projects: Array<{ id: string; name: string; spaceId: string | null; recentPath?: string | null }>,
  runtime: AppRuntimeView,
): Promise<Artifact[]> {
  const out: Artifact[] = [];
  for (const project of projects) {
    const r = resolveRunnableApp(project);
    if (!r.app) continue;
    const appId = r.app.id;
    const running = runtime.getRunningApp(appId);

    let status: ArtifactStatus = "offline";
    let url = "";
    let runtimeConfig: Record<string, unknown> = {};
    if (running && (await runtime.isPortOpen(running.port))) {
      status = "online";
      url = `http://localhost:${running.port}`;
      runtimeConfig = { port: running.port };
    } else if (runtime.isStarting(appId)) {
      status = "starting";
    }

    out.push({
      id: appId,
      label: r.app.label,
      artifactKind: "app",
      spaceId: project.spaceId ?? "home",
      status,
      runtimeKind: "local_process",
      runtimeConfig,
      url,
      createdAt: new Date(0).toISOString(),
      sourceOrigin: "discovered",
      projectId: project.id,
    });
  }
  return out;
}
```

> Note: confirm `ArtifactStatus` includes `"online" | "offline" | "starting"` in `shared/types.ts` (it does — see `rowToArtifact`'s `local_process` branch). If the `Artifact` type requires additional non-optional fields, mirror exactly what `artifact-service.ts:726-743` sets for `local_process`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run test/runnable-app.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/runnable-app.ts server/test/runnable-app.test.ts
git commit -m "feat(runnable-app): buildDerivedAppArtifacts (projects+runtime → artefacts)"
```

---

## Task 5: Merge derived apps into `getAllArtifacts` (dedupe + warn)

**Files:**
- Modify: `server/src/artifact-service.ts` (add `setDerivedAppProvider`; merge before the `getAllArtifacts` return at `:217`)
- Test: `server/test/artifact-service.test.ts`

- [ ] **Step 1: Write the failing test**

Append a new `describe` to `server/test/artifact-service.test.ts` (reuse the file's existing `makeDb` / `seed` helpers and the 4-arg `new ArtifactService(db, new SqliteArtifactStore(db), "https://oyster.to", "https://share.oyster.to")` pattern):

```ts
import type { Artifact } from "../../shared/types.js";

describe("getAllArtifacts derived-app merge", () => {
  it("appends provider apps and never writes them to the DB", async () => {
    const db = makeDb();
    const service = new ArtifactService(db, new SqliteArtifactStore(db), "https://oyster.to", "https://share.oyster.to");
    const derived: Artifact = {
      id: "app:p1", label: "Site", artifactKind: "app", spaceId: "work",
      status: "offline", runtimeKind: "local_process", runtimeConfig: {}, url: "",
      createdAt: new Date(0).toISOString(), sourceOrigin: "discovered", projectId: "p1",
    };
    service.setDerivedAppProvider(async () => [derived]);

    const all = await service.getAllArtifacts();
    expect(all.find((a) => a.id === "app:p1")).toMatchObject({ runtimeKind: "local_process" });

    const row = db.prepare("SELECT id FROM artifacts WHERE id = ?").get("app:p1");
    expect(row).toBeUndefined(); // derived → never persisted
  });

  it("does not duplicate a derived id that already exists, and keeps the original", async () => {
    const db = makeDb();
    seed(db, { id: "app:p1", label: "Real Row", runtime_kind: "local_process" });
    const service = new ArtifactService(db, new SqliteArtifactStore(db), "https://oyster.to", "https://share.oyster.to");
    service.setDerivedAppProvider(async () => [{
      id: "app:p1", label: "Derived Dupe", artifactKind: "app", spaceId: "work",
      status: "offline", runtimeKind: "local_process", runtimeConfig: {}, url: "",
      createdAt: new Date(0).toISOString(), sourceOrigin: "discovered", projectId: "p1",
    }]);

    const all = await service.getAllArtifacts();
    const matches = all.filter((a) => a.id === "app:p1");
    expect(matches).toHaveLength(1);
    expect(matches[0].label).toBe("Real Row"); // existing wins; derived dropped
  });
});
```

> If `seed`'s `fields` type doesn't accept `runtime_kind`, extend that helper's `Partial<...>` to include it (it already inserts into the `artifacts` table — add the column to the partial and the insert).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run test/artifact-service.test.ts`
Expected: FAIL — `setDerivedAppProvider` is not a function.

- [ ] **Step 3: Write the implementation**

In `server/src/artifact-service.ts`, add a field + setter to the class (near the other private fields):

```ts
  private derivedAppProvider?: () => Promise<Artifact[]>;

  // Inject the runnable-app provider. Wired in index.ts once projectService +
  // process-manager exist. Optional so tests and the reconcile path work without it.
  setDerivedAppProvider(provider: () => Promise<Artifact[]>): void {
    this.derivedAppProvider = provider;
  }
```

Then replace the `getAllArtifacts` return at `artifact-service.ts:217`:

```ts
    const ghosts = this.synthesiseCloudOnlyGhosts(new Set([...persisted, ...gen].map((a) => a.id)));
    const merged = [...persisted, ...gen, ...ghosts];

    // Derived runnable-app artefacts (in-memory, never persisted). Dedupe by id:
    // the `app:<projectId>` namespace is reserved for these, so a pre-existing id
    // is unexpected — keep the existing entry and warn rather than silently drop.
    if (this.derivedAppProvider) {
      const ids = new Set(merged.map((a) => a.id));
      for (const app of await this.derivedAppProvider()) {
        if (ids.has(app.id)) {
          debug("artifact-svc", "derived app id collides with existing artefact", { id: app.id });
          continue;
        }
        ids.add(app.id);
        merged.push(app);
      }
    }
    return merged;
```

(`debug` is already imported in this file — see its use at `:325`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run test/artifact-service.test.ts`
Expected: PASS (new describe) and no regressions in the file.

- [ ] **Step 5: Commit**

```bash
git add server/src/artifact-service.ts server/test/artifact-service.test.ts
git commit -m "feat(artifact-service): merge derived runnable-app artefacts (dedupe + warn)"
```

---

## Task 6: `Project.app` derived field (tile chip data)

**Files:**
- Modify: `server/src/project-service.ts` (add `app?` to `Project`; populate in the derivation)
- Modify: `web/src/data/projects-api.ts` (mirror the `app?` type)
- Test: `server/test/project-service.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `server/test/project-service.test.ts` (reuse the file's `initDb` + `mkdtempSync` patterns; note `writeFileSync`, `mkdirSync` are already imported there):

```ts
describe("ProjectService runnable-app field", () => {
  let dir: string; let db: Database.Database; let service: ProjectService;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "oyster-ps-app-"));
    db = initDb(dir);
    db.exec(`INSERT INTO spaces (id, display_name, color, scan_status) VALUES ('work','Work','#000','none')`);
    service = new ProjectService(db);
  });
  afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

  it("sets project.app for a vite project", () => {
    const folder = mkdtempSync(join(tmpdir(), "oyster-ps-vite-"));
    writeFileSync(join(folder, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
    const proj = service.createProject({ spaceId: "work", name: "Site" });
    db.prepare("INSERT INTO project_paths (project_id, path) VALUES (?, ?)").run(proj.id, folder);

    const [listed] = service.listForSpace("work");
    expect(listed.app).toEqual({ id: `app:${proj.id}`, label: "Site" });
    rmSync(folder, { recursive: true, force: true });
  });

  it("leaves project.app undefined for a non-runnable project", () => {
    const folder = mkdtempSync(join(tmpdir(), "oyster-ps-non-"));
    writeFileSync(join(folder, "package.json"), JSON.stringify({ scripts: { dev: "concurrently x" } }));
    const proj = service.createProject({ spaceId: "work", name: "Mono" });
    db.prepare("INSERT INTO project_paths (project_id, path) VALUES (?, ?)").run(proj.id, folder);

    const [listed] = service.listForSpace("work");
    expect(listed.app).toBeUndefined();
    rmSync(folder, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run test/project-service.test.ts`
Expected: FAIL — `listed.app` is `undefined` for the vite case (field not populated).

- [ ] **Step 3: Write the implementation**

In `server/src/project-service.ts`:

a) Add the field to the `Project` interface (after `isGitRepo?`):

```ts
  /** Derived runnable web app (Vite/Next), computed at read time from the
   *  recent path's package.json. Absent when the project isn't a recognized
   *  single-launcher app. Drives the project-tile "app" chip; never persisted. */
  app?: { id: string; label: string };
```

b) Import the resolver at the top:

```ts
import { resolveRunnableApp } from "./runnable-app.js";
```

c) Populate it in the three list/get methods. The cleanest seam: after `detectPathState` is spread in. Add a small private helper and call it in `listForSpace`, `listAll`, `getById`. Replace each `{ ...rowToProject(row), ...this.detectPathState(row.id) }` with `this.withDerived(rowToProject(row))`:

```ts
  // Attach read-time derived fields (path state + runnable app) to a project.
  private withDerived(base: Project): Project {
    const project = { ...base, ...this.detectPathState(base.id) };
    const r = resolveRunnableApp(project);
    if (r.app) project.app = { id: r.app.id, label: r.app.label };
    return project;
  }
```

Update the three call sites:
- `listForSpace` (`:80`): `return rows.map((row) => this.withDerived(rowToProject(row)));`
- `listAll` (`:89`): `return rows.map((row) => this.withDerived(rowToProject(row)));`
- `getById` (`:99`): `return this.withDerived(rowToProject(row));`

> `detectPathState` takes `row.id`; `rowToProject(row).id === row.id`, so `this.detectPathState(base.id)` is equivalent. `resolveRunnableApp` needs `recentPath`, which `detectPathState` has just provided on `project`.

d) Mirror the type in `web/src/data/projects-api.ts` `Project` interface (after `isGitRepo?`):

```ts
  /** Derived runnable web app (Vite/Next) at the project's recent path.
   *  Absent when not a recognized launcher. Drives the tile "app" chip. */
  app?: { id: string; label: string };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run test/project-service.test.ts`
Expected: PASS (and existing project-service tests still green).

- [ ] **Step 5: Typecheck the web type change**

Run: `cd web && npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add server/src/project-service.ts web/src/data/projects-api.ts server/test/project-service.test.ts
git commit -m "feat(projects): derived Project.app field for the tile chip"
```

---

## Task 7: Start/stop routes resolve derived apps + wire the provider

**Files:**
- Modify: `server/src/routes/static.ts` (`StaticRouteDeps` + start/stop handlers)
- Modify: `server/src/index.ts` (provider wiring + static-route deps)
- Test: `server/test/static-derived-app.test.ts` (new — exercise the resolution helper directly)

The start/stop handlers in `static.ts` (`:174` start, `:200` stop) currently only consult `artifactService.getAppConfig(name)` (DB). Add a derived fallback: treat `name` as a `projectId` (the web strips the `app:` prefix before calling `/api/apps/:name/...`).

- [ ] **Step 1: Extend `StaticRouteDeps`**

In `server/src/routes/static.ts`, add to the `StaticRouteDeps` interface:

```ts
  /** Derived runnable-app launch hooks (parallel to startApp/stopApp, which
   *  serve DB-backed apps). Resolve a projectId → runnable app and manage it. */
  projectService: { getById: (id: string) => { id: string; name: string; spaceId: string | null; recentPath?: string | null } | null };
  startAppById: (appId: string, argv: string[], cwd: string, port: number) => void;
  stopAppById: (appId: string) => boolean;
  getRunningApp: (appId: string) => { port: number; pid: number } | undefined;
  findFreePort: () => Promise<number>;
```

Add the import at the top of `static.ts`:

```ts
import { resolveRunnableApp, buildLaunchArgv } from "../runnable-app.js";
```

- [ ] **Step 2: Add the derived fallback to the start handler**

In the `startMatch` block, replace the `if (!config) { 404 }` early-return with a derived fallback:

```ts
    const name = startMatch[1];
    const config = artifactService.getAppConfig(name);
    if (config) {
      if (await deps.isPortOpen(config.port)) { sendJson({ status: "already_running" }); return true; }
      deps.startApp(name, config);
      try { await deps.waitForReady(config.port); sendJson({ status: "started", port: config.port }); }
      catch { sendJson({ status: "timeout", message: "Couldn't start — runnable apps launch via `npm run dev`; check the dev script." }, 500); }
      return true;
    }
    // Derived runnable app: `name` is a projectId (web strips the `app:` prefix).
    const project = deps.projectService.getById(name);
    const r = project ? resolveRunnableApp(project) : { app: null as null };
    if (r.app) {
      if (deps.getRunningApp(r.app.id)) { sendJson({ status: "already_running" }); return true; }
      const port = await deps.findFreePort();
      deps.startAppById(r.app.id, buildLaunchArgv(r.app.framework, port), r.app.cwd, port);
      try { await deps.waitForReady(port); sendJson({ status: "started", port }); }
      catch { sendJson({ status: "timeout", message: "Couldn't start — runnable apps launch via `npm run dev`; check the dev script." }, 500); }
      return true;
    }
    res.writeHead(404); res.end("Unknown app"); return true;
```

> This replaces the original `startMatch` body (`:177-195`). Keep the `rejectIfNonLocalOrigin()` guard at the top of the block unchanged.

- [ ] **Step 3: Add the derived fallback to the stop handler**

In the `stopMatch` block, after the existing DB `getAppConfig` path, add the derived branch:

```ts
    const name = stopMatch[1];
    const config = artifactService.getAppConfig(name);
    if (config) {
      const stopped = deps.stopApp(name, config.port);
      sendJson({ status: stopped ? "stopped" : "not_managed" });
      return true;
    }
    // Derived app: stop by the same id the start path used.
    const stopped = deps.stopAppById(`app:${name}`);
    sendJson({ status: stopped ? "stopped" : "not_managed" });
    return true;
```

> Replaces the original `stopMatch` body (`:204-211`), keeping the origin guard.

- [ ] **Step 4: Wire deps + the provider in `index.ts`**

a) Extend the process-manager import (`index.ts:8`) to add the new functions:

```ts
import {
  startApp,
  stopApp,
  isPortOpen,
  waitForReady,
  isStarting,
  startAppById,
  stopAppById,
  getRunningApp,
  findFreePort,
  // ...existing imports (getGeneratedArtifactEntries, etc.)
} from "./process-manager.js";
```

b) After both `artifactService` (`:302`) and `projectService` (`:566`) exist, wire the provider (place this right after `:566`):

```ts
import { buildDerivedAppArtifacts } from "./runnable-app.js";
// ...
artifactService.setDerivedAppProvider(() =>
  buildDerivedAppArtifacts(projectService.listAll(), { getRunningApp, isStarting, isPortOpen }),
);
```

c) Add the new fields to the `tryHandleStaticRoute` deps object (`:883`):

```ts
    startApp, stopApp, isPortOpen, waitForReady,
    projectService, startAppById, stopAppById, getRunningApp, findFreePort,
```

- [ ] **Step 5: Test the resolution helper**

```ts
// server/test/static-derived-app.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveRunnableApp, buildLaunchArgv } from "../src/runnable-app.js";

// The route's derived branch is `resolveRunnableApp(project)` + `buildLaunchArgv`.
// Pin that contract: a vite project resolves and produces a runnable argv.
describe("static route derived-app resolution contract", () => {
  it("resolves a projectId-shaped project to a launchable argv", () => {
    const dir = mkdtempSync(join(tmpdir(), "oyster-route-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
    const project = { id: "p9", name: "Site", spaceId: "work", recentPath: dir };
    const r = resolveRunnableApp(project);
    expect(r.app?.id).toBe("app:p9");
    const argv = buildLaunchArgv(r.app!.framework, 4501);
    expect(argv).toEqual(["npm", "run", "dev", "--", "--port", "4501", "--strictPort"]);
    rmSync(dir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 6: Run tests + typecheck**

Run: `cd server && npx vitest run test/static-derived-app.test.ts && npx tsc --noEmit`
Expected: PASS, no type errors (confirms the new deps wiring compiles).

- [ ] **Step 7: Commit**

```bash
git add server/src/routes/static.ts server/src/index.ts server/test/static-derived-app.test.ts
git commit -m "feat(routes): start/stop resolve derived apps; wire provider in index"
```

---

## Task 8: Project-tile chip (web) — manual verification

**Files:**
- Modify: `web/src/components/Home/ProjectTile.tsx` (render chip + `onOpenApp` prop)
- Modify: `web/src/components/Home/ProjectTileGrid.tsx` and `web/src/components/Home/index.tsx` (thread `onOpenApp`)
- Modify: `web/src/App.tsx` (provide `onOpenApp` → switch to the app's space; narrow, does NOT start the process)
- Modify: `web/src/components/Home/Home.css` (chip style)

> The chip is **narrow**: it reveals the app on the surface (switches to the project's space) so the user can click the card to Start. It does not start the process itself — that keeps a single launch path (the card's existing local_process click flow).

- [ ] **Step 1: Add the chip to `ProjectTile`**

Add an `onOpenApp?: (appId: string) => void;` prop to the `ProjectTile` props type, then render the chip inside `.home-space-card-name` (next to the `<GitBranch>` block), only when `project.app` is set:

```tsx
{project.app && (
  <button
    type="button"
    className="home-project-app-chip"
    title={`Open the ${project.app.label} app`}
    onClick={(e) => { e.stopPropagation(); onOpenApp?.(project.app!.id); }}
  >
    ▶ app
  </button>
)}
```

- [ ] **Step 2: Thread `onOpenApp` through the grid + Home to App**

- `ProjectTileGrid.tsx`: accept `onOpenApp` and pass it to each `<ProjectTile … onOpenApp={onOpenApp} />`.
- `Home/index.tsx`: accept `onOpenApp` and pass to `ProjectTileGrid`.
- `App.tsx`: pass `onOpenApp={(appId) => { const a = artifacts.find((x) => x.id === appId); if (a) handleSpaceChange(a.spaceId); }}` to `<Home>` (use the existing space-change handler; `artifacts` already includes derived apps after Task 5/7).

- [ ] **Step 3: Add chip CSS** to `Home.css` (match the existing `signal` / chip vocabulary — small, dim, rounded; reuse existing tokens):

```css
.home-project-app-chip {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 999px;
  border: 1px solid var(--home-border, rgba(255,255,255,0.12));
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
  line-height: 1.4;
}
.home-project-app-chip:hover { color: var(--text); }
```

- [ ] **Step 4: Typecheck the web build**

Run: `cd web && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Manual verification (run the app)**

Use the `reference-worktree-dev-server` memory to run dev from this worktree (copy `.env`, ensure node_modules, watch the `~/Oyster` lockfile). Then:

1. Confirm a known Vite project is attached (e.g. `~/Dev/sober-o-matic`); if not, add it via the UI.
2. On its project tile, confirm the **▶ app** chip appears.
3. Confirm an **app artefact card** for it appears on the desktop (kind "app", `local_process`).
4. Click the card → it starts (`npm run dev -- --port <p> --strictPort`) and opens a popup at `localhost:<p>`. Status dot goes online.
5. Click the chip → the surface switches to that project's space (does **not** start a second process).
6. Confirm a `concurrently` project (e.g. `~/Dev/blunderfixer` root) shows **no** chip and **no** app card.
7. Stop the app (card stop affordance) → status returns to offline; re-list shows no DB row was written (optional: confirm via `sqlite3 ~/Oyster/db/oyster.db "SELECT id FROM artifacts WHERE id LIKE 'app:%'"` → empty).

- [ ] **Step 6: Commit**

```bash
git add web/src/components/Home/ProjectTile.tsx web/src/components/Home/ProjectTileGrid.tsx web/src/components/Home/index.tsx web/src/App.tsx web/src/components/Home/Home.css
git commit -m "feat(web): project-tile runnable-app chip (opens app on the surface)"
```

---

## Task 9: CHANGELOG + full integration check

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add the changelog entry** under the `[Unreleased]` → `### Added` section (create the heading if absent; outcome phrasing, no implementation detail):

```markdown
- **Runnable apps, detected automatically.** Projects that run a Vite or Next dev server are recognised on sight — launch and preview them straight from the surface, and jump to them from the project tile.
```

- [ ] **Step 2: Refresh the changelog HTML**

Run: `npm run build:changelog`
Expected: `docs/changelog.html` regenerated.

- [ ] **Step 3: Full server test sweep**

Run: `cd server && npx vitest run`
Expected: all green (new suites + no regressions).

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md docs/changelog.html
git commit -m "docs(changelog): runnable-app detection"
```

---

## Self-Review

**Spec coverage:**
- Single resolver (`resolveRunnableApp`, sole id producer) — Task 2, used by Tasks 4/6/7. ✓
- Vite + Next conservative detection (env-strip, reject wrappers, preserve trailing flags) — Task 1. ✓
- Derived, in-memory, no DB row (no `filePath`; "absent from DB" test) — Tasks 4, 5. ✓
- No port on read; allocate at start; process-manager owns `{appId→port,pid,child}` — Tasks 3, 7. ✓
- Status from process state + crash cleanup on exit AND error — Task 3. ✓
- Tile chip (narrow, opens on surface) + artefact card — Tasks 6, 8. ✓
- Start/stop symmetry via the same resolution path — Task 7. ✓
- `app:<projectId>` id; dedupe-with-warn on collision — Tasks 2, 5. ✓
- Launch-failure messaging names the npm assumption — Task 7. ✓
- CHANGELOG — Task 9. ✓
- Deferred (orchestrators, agent, persisted override, non-npm) — out of scope by construction (classifier returns null for non-launchers). ✓

**Placeholder scan:** none — every code step has complete code.

**Type consistency:** `resolveRunnableApp` returns `{ app: RunnableApp } | { app: null; reason }` (Task 2), consumed as `r.app` in Tasks 4/6/7. `buildLaunchArgv(framework, port)` signature consistent across Tasks 1/7. `startAppById`/`stopAppById`/`getRunningApp`/`findFreePort` signatures consistent across Tasks 3/7. `Project.app` shape `{ id, label }` consistent across Tasks 6/8. Derived `Artifact` shape matches `artifact-service.ts:726-743` `local_process` branch.
</content>
