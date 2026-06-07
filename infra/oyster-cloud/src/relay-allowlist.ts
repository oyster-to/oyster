// Relay route allowlist — cloud-side enforcement (spec
// 2026-06-07-device-relay-design §security). The device-side relay client
// in server/src/relay-client.ts carries its own copy of this table and is
// the AUTHORITATIVE check; this one exists so a non-allowlisted path is
// rejected before it is ever framed onto a device socket. Drift between
// the two tables fails closed (whichever side is narrower wins).
//
// v1 is read-only: GET only, no request bodies.

/** Wire protocol version. Bumped when frame shapes change (slice 2 adds
 *  SSE frames, slice 3 adds raw-WS PTY frames). */
export const RELAY_PROTO = 1;

/** Pattern syntax: exact string, `:seg` (one non-empty path segment), or a
 *  trailing `/*` (any non-empty suffix). Exact patterns listed before
 *  wildcard ones so the matched pattern (used for the device's route
 *  advertisement check) is deterministic. */
export const RELAY_ALLOWLIST: ReadonlyArray<string> = [
  "/api/sessions",
  "/api/sessions/search",
  "/api/sessions/:id",
  "/artifacts/*",
];

const MAX_PATH_CHARS = 2048;

/** Match a relayed path against the allowlist. Returns the matched pattern
 *  (for the hello-routes advertisement check) or null.
 *
 *  Matching rules per the spec: percent-decode REPEATEDLY until stable
 *  (catches double-encoded traversal), reject `.`/`..`/empty segments,
 *  backslashes and NULs at every decode stage, match on pathname only —
 *  the query string rides through to the device untouched. */
export function matchRelayPath(method: string, pathWithQuery: string): string | null {
  if (method !== "GET") return null;
  if (typeof pathWithQuery !== "string" || pathWithQuery.length === 0) return null;
  if (pathWithQuery.length > MAX_PATH_CHARS) return null;

  const qIdx = pathWithQuery.indexOf("?");
  let decoded = qIdx === -1 ? pathWithQuery : pathWithQuery.slice(0, qIdx);
  if (!decoded.startsWith("/")) return null;

  // Decode until stable (bounded — three rounds covers any realistic
  // double/triple encoding; deeper nesting just fails the loop check).
  for (let i = 0; i < 3; i++) {
    if (!segmentsSane(decoded)) return null;
    let next: string;
    try { next = decodeURIComponent(decoded); }
    catch { return null; }
    if (next === decoded) break;
    decoded = next;
    if (i === 2 && decodeURIComponentSafe(decoded) !== decoded) return null;
  }
  if (!segmentsSane(decoded)) return null;

  const segs = decoded.split("/").slice(1); // drop the leading ""
  for (const pattern of RELAY_ALLOWLIST) {
    if (pattern.endsWith("/*")) {
      const prefix = pattern.slice(0, -1); // keep trailing "/"
      if (decoded.startsWith(prefix) && decoded.length > prefix.length) return pattern;
      continue;
    }
    const pSegs = pattern.split("/").slice(1);
    if (pSegs.length !== segs.length) continue;
    let ok = true;
    for (let i = 0; i < pSegs.length; i++) {
      const p = pSegs[i]!;
      const s = segs[i]!;
      if (p.startsWith(":")) { if (s.length === 0) { ok = false; break; } }
      else if (p !== s) { ok = false; break; }
    }
    if (ok) return pattern;
  }
  return null;
}

function segmentsSane(path: string): boolean {
  if (path.includes("\0") || path.includes("\\")) return false;
  const segs = path.split("/");
  for (let i = 1; i < segs.length; i++) {
    const s = segs[i]!;
    // Interior empty segments ("//") and dot segments are rejected outright.
    // A trailing empty segment (path ends in "/") is also rejected — no
    // allowlisted route needs one.
    if (s === "" || s === "." || s === "..") return false;
  }
  return true;
}

function decodeURIComponentSafe(s: string): string | null {
  try { return decodeURIComponent(s); }
  catch { return null; }
}
