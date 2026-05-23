import type { IncomingMessage, ServerResponse } from "node:http";
import type { RouteCtx } from "../http-utils.js";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Pure function — exported for direct unit testing.
// Mirrors the combined hasEnvKey || hasAuth() gate used at boot time
// in bin/oyster.mjs::main() (before this branch removed that gate).
// Either an AI provider env var (ANTHROPIC_API_KEY / OPENAI_API_KEY /
// GOOGLE_API_KEY / GEMINI_API_KEY) or a non-empty auth.json from
// OpenCode's TUI login is enough to be "configured".
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

// Route handler — matches the tryHandleXxxRoute pattern used by every
// other server/src/routes/* module (see pin.ts, auth.ts).
export async function tryHandleProviderStatusRoute(
  req: IncomingMessage,
  _res: ServerResponse,
  url: string,
  ctx: RouteCtx,
): Promise<boolean> {
  if (url !== "/api/chat/provider-status") return false;
  const { sendJson, rejectIfNonLocalOrigin } = ctx;
  if (rejectIfNonLocalOrigin()) return true;
  if (req.method !== "GET") {
    sendJson({ error: "Method Not Allowed" }, 405);
    return true;
  }
  sendJson(getProviderStatus());
  return true;
}
