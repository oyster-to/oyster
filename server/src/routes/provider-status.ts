import type { IncomingMessage, ServerResponse } from "node:http";
import type { RouteCtx } from "../http-utils.js";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Pure function — exported for direct unit testing.
// Mirrors bin/oyster.mjs's hasAuth() + env-key check.
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
  if (req.method !== "GET") {
    ctx.sendJson({ error: "Method Not Allowed" }, 405);
    return true;
  }
  ctx.sendJson(getProviderStatus());
  return true;
}
