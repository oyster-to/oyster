// server/test/runnable-app.test.ts
import { describe, it, expect } from "vitest";
import { classifyDevScript, buildLaunchArgv, resolveRunnableApp } from "../src/runnable-app.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  it("strips multiple leading KEY=value env assignments", () => {
    expect(classifyDevScript("NODE_ENV=dev PORT=3000 vite")).toEqual({ framework: "vite" });
  });
  it("rejects bare `next` (no subcommand) with a reason", () => {
    expect(classifyDevScript("next")).toEqual({ framework: null, reason: "next (no subcommand) is not a dev server" });
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
    const { dir, project } = projectAt({ dev: 'concurrently "a" "b"' });
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
