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
