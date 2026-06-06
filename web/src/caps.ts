// caps.ts — capability flags for the two build targets.
// Local (default): full surface against the local server.
// Cloud (VITE_OYSTER_MODE=cloud): read-mostly remote view served by the
// oyster-cloud worker at app.oyster.to (spec
// docs/superpowers/specs/2026-06-05-cloud-remote-view-design.md).
// Gate on these named capabilities, never on `mode` directly — call sites
// should say what they need, not where they run.
const cloud = import.meta.env.VITE_OYSTER_MODE === "cloud";

export const caps = {
  cloud,
  /** Local agent available: ChatBar, terminals, resume, setup scan. */
  canChat: !cloud,
  /** Local filesystem writes: spaces/projects/memories/artifact mutations. */
  canWrite: !cloud,
  /** SSE push from the local server; cloud falls back to polling. */
  hasSse: !cloud,
  /** Space pills + space scoping. Cloud has synced spaces + (post-SW-1)
   *  session space_ids, so the switcher works remotely. */
  hasSpaces: true,
  /** Projects grid / registry — no cloud counterpart yet. */
  hasProjects: !cloud,
  /** Publication management (unpublish / access mode) — available in BOTH
   *  modes; cloud calls the apex publish API directly. */
  canManagePublications: true,
  /** Prefix for API calls. Cloud lives at the app.oyster.to root since
   *  spec 2026-06-05-app-oyster-to-migration, so both modes are "". The
   *  indirection stays — call sites keep using apiPath(). */
  apiBase: "",
  /** Prefix for client routes (history.pushState / URL parsing). */
  routeBase: "",
} as const;
