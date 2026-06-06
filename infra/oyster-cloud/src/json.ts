// Browser-origin guard for mutating routes (spec
// 2026-06-05-cloud-remote-view-design.md). share.oyster.to serves
// untrusted published HTML and is *same-site* with the apex, so
// SameSite=Lax alone doesn't stop credentialed cross-origin fetches from
// it. Non-browser clients (the local Oyster server) send no Origin
// header — absence passes. app.oyster.to is the remote view's own
// hostname (spec 2026-06-05-app-oyster-to-migration).
const ALLOWED_BROWSER_ORIGINS = new Set([
  "https://oyster.to",
  "https://www.oyster.to",
  "https://app.oyster.to",
]);

export function rejectBadOrigin(req: Request): Response | null {
  const origin = req.headers.get("origin");
  if (origin && !ALLOWED_BROWSER_ORIGINS.has(origin)) {
    return jsonError(403, "bad_origin");
  }
  return null;
}

export function jsonError(status: number, code: string, message?: string, extra: Record<string, unknown> = {}): Response {
  const body: Record<string, unknown> = { error: code, ...extra };
  if (message) body.message = message;
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function jsonOk(payload: object, status = 200, extraHeaders?: HeadersInit): Response {
  const headers = new Headers({ "content-type": "application/json" });
  if (extraHeaders) {
    new Headers(extraHeaders).forEach((v, k) => headers.set(k, v));
  }
  return new Response(JSON.stringify(payload), { status, headers });
}
