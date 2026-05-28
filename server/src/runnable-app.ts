// Detect a project's runnable web app from its package.json `dev` script,
// and build the launch invocation. Pure functions — no surprises, easily
// tested. See docs/superpowers/specs/2026-05-26-runnable-app-detection-design.md.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Artifact, ArtifactStatus } from "../../shared/types.js";

export type Framework = "vite" | "next";

export type ClassifyResult =
  | { framework: Framework }
  | { framework: null; reason: string };

// Classify a package.json `dev` script string. Conservative: match the leading
// executable + subcommand, never a substring. Strips leading KEY=value env
// assignments (zero or more); does NOT unwrap wrappers (cross-env / concurrently / npm-run-all).
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
