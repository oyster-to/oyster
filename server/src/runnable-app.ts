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
