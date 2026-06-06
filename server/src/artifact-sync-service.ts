// artifact-sync-service.ts — one-way push of artefact registry METADATA to
// the cloud worker, so the remote view's Artefacts tab can list what exists.
// No file content, no publication state (the publish worker stays the sole
// source of truth for openable artefacts) — registry rows only prove that
// artefacts exist and where.
//
// Mirrors session-sync-service.ts's metadata flow: the store stamps
// sync_dirty_at on every mutation (insert/update/remove/pin), this service
// drains pending rows in batches and records cloud_synced_at on ack. The
// db.ts promotion backfill marks pre-existing rows dirty once, so the whole
// registry reaches the cloud on first Pro sign-in. Tombstones (removed_at
// set) are pushed like any other row — the worker accepts them and filters
// them from GET, which is how deletions propagate.

import type Database from "better-sqlite3";
import type { ProfileBindingService } from "./profile-binding-service.js";
import { createOfflineLogger } from "./sync-log.js";

interface SyncUser { id: string; email: string; tier: string }

export interface ArtifactSyncDeps {
  db: Database.Database;
  /** Same account-switch guard as session/memory sync: a second Pro account
   *  signing into this profile must not push (or claim) this registry. */
  profileBinding: ProfileBindingService;
  currentUser: () => SyncUser | null;
  sessionToken: () => string | null;
  workerBase: string;
  fetch: typeof fetch;
}

export interface ArtifactSyncService {
  /** Drain dirty registry rows to the cloud. Returns rows acknowledged. */
  pushPending(): Promise<number>;
}

const BATCH_SIZE = 100;

function isProSession(deps: ArtifactSyncDeps): { user: SyncUser; token: string } | null {
  const user = deps.currentUser();
  const token = deps.sessionToken();
  if (!user || !token || user.tier !== "pro") return null;
  if (!deps.profileBinding.isOwnedBy(user.id)) {
    console.warn(
      `[artifacts] sync blocked — profile is bound to a different account; current=${user.id}, bound=${deps.profileBinding.getBoundOwner()}`,
    );
    return null;
  }
  return { user, token };
}

interface OutgoingArtifact {
  id: string;
  label: string;
  artifact_kind: string;
  /** Derived space (artifact → project → space), '' when unfiled — same
   *  derivation as ArtifactStore's SELECTs. Normalised to null on the wire. */
  space_id: string | null;
  project_id: string | null;
  group_name: string | null;
  source_origin: string;
  created_at: string;
  /** Domain-level timestamp (datetime('now') text), distinct from the LWW
   *  key below. Named artifact_updated_at cloud-side. */
  updated_at: string;
  removed_at: string | null;
  pinned_at: number | null;
  /** LWW key on the wire — the local sync_dirty_at (unix ms). Named
   *  sync_version_at so the worker schema doesn't overload `updated_at`,
   *  which artefacts already use at the domain level. */
  sync_version_at: number;
  device_id: string | null;
  device_label: string | null;
}

export function createArtifactSyncService(deps: ArtifactSyncDeps): ArtifactSyncService {
  let inFlightPush: Promise<number> | null = null;
  const pushLog = createOfflineLogger("[artifacts] pushPending");

  // Pending predicate mirrors session-sync's scanDirty, with one addition:
  // rows with cloud_owner_id IS NULL are claimable by the current Pro user.
  // The store stamps sync_dirty_at without knowing the owner (writes happen
  // signed-out too); profileBinding guarantees only one account can ever
  // sync from this profile, so claiming unowned rows is safe.
  const scanDirty = deps.db.prepare(
    `SELECT a.id, a.label, a.artifact_kind,
            COALESCE(p.space_id, '') AS space_id,
            a.project_id, a.group_name, a.source_origin,
            a.created_at, a.updated_at, a.removed_at, a.pinned_at,
            a.sync_dirty_at
       FROM artifacts a LEFT JOIN projects p ON p.id = a.project_id
      WHERE a.sync_dirty_at IS NOT NULL
        AND (a.cloud_owner_id IS NULL OR a.cloud_owner_id = ?)
        AND (a.cloud_synced_at IS NULL OR a.cloud_synced_at < a.sync_dirty_at)
      ORDER BY a.sync_dirty_at ASC
      LIMIT ?`,
  );

  // Ack also claims the row for the pushing owner. The owner guard refuses
  // to flip a row that somehow belongs to a different account.
  const markSyncedStmt = deps.db.prepare(
    `UPDATE artifacts
        SET cloud_synced_at = ?,
            cloud_owner_id  = ?
      WHERE id = ? AND (cloud_owner_id IS NULL OR cloud_owner_id = ?)`,
  );

  /** Same lazy device-identity read as session-sync: cache only on success
   *  so a not-yet-seeded row retries instead of locking in null. */
  let cachedDeviceIdentity: { device_id: string; label: string } | null = null;
  function loadDeviceIdentity(): { device_id: string | null; label: string | null } {
    if (cachedDeviceIdentity !== null) return cachedDeviceIdentity;
    const row = deps.db.prepare(
      `SELECT device_id, label FROM device_identity WHERE id = 1 LIMIT 1`,
    ).get() as { device_id: string; label: string } | undefined;
    if (row) {
      cachedDeviceIdentity = row;
      return row;
    }
    return { device_id: null, label: null };
  }

  async function doPushPending(): Promise<number> {
    const session = isProSession(deps);
    if (!session) return 0;

    let totalAccepted = 0;
    const MAX_BATCHES = 1000;  // defensive safety cap

    const identity = loadDeviceIdentity();

    for (let i = 0; i < MAX_BATCHES; i++) {
      type PendingRow = Omit<OutgoingArtifact, "space_id" | "sync_version_at" | "device_id" | "device_label"> & {
        space_id: string;
        sync_dirty_at: number;
      };
      const pending = scanDirty.all(session.user.id, BATCH_SIZE) as PendingRow[];
      if (pending.length === 0) break;

      const stamped: OutgoingArtifact[] = pending.map(({ sync_dirty_at, ...row }) => ({
        ...row,
        space_id: row.space_id === "" ? null : row.space_id,
        sync_version_at: sync_dirty_at,
        device_id: identity.device_id,
        device_label: identity.label,
      }));

      let res: Response;
      try {
        res = await deps.fetch(`${deps.workerBase}/api/artifacts/metadata`, {
          method: "POST",
          headers: { Cookie: `oyster_session=${session.token}`, "content-type": "application/json" },
          body: JSON.stringify({ artifacts: stamped }),
        });
      } catch (err) {
        pushLog.failure(err);
        return totalAccepted;
      }
      if (!res.ok) {
        console.warn(`[artifacts] pushPending non-ok ${res.status}`);
        return totalAccepted;
      }
      pushLog.success();
      const body = await res.json().catch(() => null) as { accepted?: string[] } | null;
      const accepted = body?.accepted ?? [];

      // Mark accepted rows synced (and claimed). A row dirtied again between
      // scan and ack keeps sync_dirty_at > cloud_synced_at and re-pushes on
      // the next drain — same race posture as session-sync.
      const now = Date.now();
      const tx = deps.db.transaction(() => {
        for (const id of accepted) markSyncedStmt.run(now, session.user.id, id, session.user.id);
      });
      tx();
      totalAccepted += accepted.length;

      if (accepted.length > 1) {
        console.log(`[artifacts] pushed: accepted=${accepted.length}`);
      }
      if (accepted.length === 0) break;
    }

    return totalAccepted;
  }

  return {
    async pushPending() {
      if (inFlightPush) return inFlightPush;
      inFlightPush = doPushPending();
      try {
        return await inFlightPush;
      } finally {
        inFlightPush = null;
      }
    },
  };
}
