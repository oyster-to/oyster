// Worker-side relay routes (spec 2026-06-07-device-relay-design).
// Every handler resolves the browser/device session and applies the pro
// gate BEFORE touching the user's RelayDO — the DO itself is only
// reachable through these handlers (idFromName(user.id)), which is what
// makes cross-user access structurally impossible.

import type { Env } from "./session.js";
import { resolveSession } from "./session.js";
import { jsonError, rejectBadOrigin } from "./json.js";
import { matchRelayPath } from "./relay-allowlist.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function sessionTokenFromCookie(req: Request): string | null {
  const cookie = req.headers.get("Cookie");
  if (!cookie) return null;
  const m = cookie.match(/(?:^|;\s*)oyster_session=([^;]+)/);
  return m?.[1] ?? null;
}

function userStub(env: Env, userId: string): DurableObjectStub {
  return env.RELAY.get(env.RELAY.idFromName(userId));
}

/** Device side: outbound WebSocket dial from the local Oyster server.
 *  GET /api/relay/connect?device_id=<uuid>&device_label=<hostname> */
export async function handleRelayConnect(req: Request, env: Env, url: URL): Promise<Response> {
  const user = await resolveSession(req, env);
  if (!user) return jsonError(401, "sign_in_required");
  if (user.tier !== "pro") return jsonError(403, "pro_required");
  if (req.headers.get("Upgrade") !== "websocket") return jsonError(426, "expected_websocket");

  // resolveSession succeeded, so the cookie token exists. Forward it to
  // the DO for periodic revalidation (revocation enforcement).
  const token = sessionTokenFromCookie(req);
  if (!token) return jsonError(401, "sign_in_required");

  const headers = new Headers(req.headers);
  headers.set("x-relay-session-token", token);
  const fwd = new Request(`https://relay.do/connect${url.search}`, {
    method: "GET",
    headers,
  });
  return userStub(env, user.id).fetch(fwd);
}

/** Browser side: online/disabled device list for the cloud UI. */
export async function handleRelayStatus(req: Request, env: Env): Promise<Response> {
  const user = await resolveSession(req, env);
  if (!user) return jsonError(401, "sign_in_required");
  if (user.tier !== "pro") return jsonError(403, "pro_required");
  return userStub(env, user.id).fetch(new Request("https://relay.do/status"));
}

/** Browser side: forward an allowlisted GET to an online device.
 *  GET /api/relay/d/:deviceId/<path> — <path>?<query> rides to the device. */
export async function handleRelayForward(
  req: Request,
  env: Env,
  deviceId: string,
  forwardPath: string,
): Promise<Response> {
  const user = await resolveSession(req, env);
  if (!user) return jsonError(401, "sign_in_required");
  if (user.tier !== "pro") return jsonError(403, "pro_required");
  if (!UUID_RE.test(deviceId)) return jsonError(400, "invalid_device_id");

  // First of the two cloud-side allowlist checks (the DO repeats it; the
  // device's own table is the authoritative third). Rejecting here keeps
  // junk paths from ever reaching the DO.
  if (matchRelayPath("GET", forwardPath) === null) {
    return jsonError(403, "path_not_allowed");
  }

  const fwd = new Request("https://relay.do/forward", {
    method: "GET",
    headers: {
      "x-relay-device-id": deviceId,
      "x-relay-path": forwardPath,
    },
  });
  return userStub(env, user.id).fetch(fwd);
}

/** Browser side: per-device relay kill switch. Deliberately NOT session
 *  revocation — disabling relay must not sign the device out of sync. */
export async function handleRelayDeviceToggle(
  req: Request,
  env: Env,
  deviceId: string,
  action: "disable" | "enable",
): Promise<Response> {
  const badOrigin = rejectBadOrigin(req);
  if (badOrigin) return badOrigin;
  const user = await resolveSession(req, env);
  if (!user) return jsonError(401, "sign_in_required");
  if (user.tier !== "pro") return jsonError(403, "pro_required");
  if (!UUID_RE.test(deviceId)) return jsonError(400, "invalid_device_id");

  const fwd = new Request(`https://relay.do/${action}`, {
    method: "POST",
    headers: { "x-relay-device-id": deviceId },
  });
  return userStub(env, user.id).fetch(fwd);
}
