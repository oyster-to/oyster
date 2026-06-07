export type { Artifact, ArtifactKind, ArtifactStatus, IconStatus, SessionJoinedForArtifact } from "../../../shared/types";
import type { Artifact, SessionJoinedForArtifact } from "../../../shared/types";
import { getJson, patchJson, postJson, postEmpty, del, apiPath } from "./http";
import { caps } from "../caps";
import { fetchCloudPublications } from "./cloud-publications";
import { fetchCloudArtifacts } from "./cloud-artifacts";
import { freshRelayState, relayPath } from "./relay";

export async function fetchArtifacts(signal?: AbortSignal): Promise<Artifact[]> {
  // Cloud Artefacts tab = the synced registry, plus orphan live publications
  // as fallback. Publications are joined onto registry rows by artifact_id
  // ONLY to mark which are openable (url = shareUrl) and keep the published
  // pill working — publication state itself is never synced or duplicated;
  // the publish worker stays authoritative. A publication whose registry row
  // never synced (or was deleted locally) still appears as its own row,
  // preserving the pre-registry behaviour.
  if (caps.cloud) {
    const [registry, publications] = await Promise.all([
      fetchCloudArtifacts(signal),
      fetchCloudPublications(signal),
    ]);
    const pubById = new Map(publications.map((p) => [p.id, p]));
    const merged = registry.map((a) => {
      const pub = pubById.get(a.id);
      if (!pub) return a;
      pubById.delete(a.id);
      return { ...a, url: pub.url, status: pub.status, publication: pub.publication };
    });
    // Orphans: live publications with no surviving registry row.
    return enrichWithLiveDevices([...merged, ...pubById.values()], signal);
  }
  return getJson<Artifact[]>(apiPath("/api/artifacts"), signal);
}

/** Relay enrichment (spec 2026-06-07-device-relay-design): the registry
 *  mirror deliberately carries no file URLs, so unpublished rows whose
 *  origin device is ONLINE get their viewer URL from the device's live
 *  /api/artifacts (relayed), rewritten through /api/relay/d/<id>/…. The
 *  row then opens like any other. Strictly progressive: any failure —
 *  no devices, device wedged, relay rolled back — returns the rows
 *  untouched (today's inert mirror). */
async function enrichWithLiveDevices(rows: Artifact[], signal?: AbortSignal): Promise<Artifact[]> {
  try {
    const online = (await freshRelayState(signal)).online.filter((d) => d.ready);
    if (online.length === 0) return rows;
    const lists = await Promise.all(online.map(async (d) => {
      try {
        const artifacts = await getJson<Artifact[]>(relayPath(d.device_id, "/api/artifacts"), signal);
        return { deviceId: d.device_id, artifacts };
      } catch {
        return null; // one slow/offline device must not block the rest
      }
    }));
    // artifact_id → live open target. Three cases from the device's own
    // url field: redirect artefacts point at the public web (open as-is);
    // /docs/ + /artifacts/ paths relay through the device; local_process
    // localhost URLs are meaningless remotely (stay inert).
    const liveById = new Map<string, string>();
    for (const list of lists) {
      if (!list) continue;
      for (const a of list.artifacts) {
        if (typeof a.url !== "string" || a.url.length === 0) continue;
        if (a.runtimeKind === "redirect" && /^https?:\/\//.test(a.url)) {
          liveById.set(a.id, a.url);
        } else if (a.url.startsWith("/docs/") || a.url.startsWith("/artifacts/")) {
          liveById.set(a.id, relayPath(list.deviceId, a.url));
        }
      }
    }
    if (liveById.size === 0) return rows;
    return rows.map((row) => {
      if (row.url) return row; // published — share page stays canonical
      const liveUrl = liveById.get(row.id);
      if (!liveUrl) return row;
      return { ...row, url: liveUrl, status: "online" as const };
    });
  } catch {
    return rows;
  }
}

// startApp/stopApp keep their bespoke shape: server routes are GETs and the
// callers in App.tsx tolerate any response (no throw on non-OK). Promoting
// to getJson would change that contract — out of scope for this refactor.
export async function startApp(name: string): Promise<{ status: string; port?: number }> {
  const res = await fetch(apiPath(`/api/apps/${name}/start`));
  return res.json();
}

export async function stopApp(name: string): Promise<{ status: string }> {
  const res = await fetch(apiPath(`/api/apps/${name}/stop`));
  return res.json();
}

export async function updateArtifact(
  id: string,
  fields: { label?: string; group_name?: string | null },
): Promise<Artifact> {
  return patchJson<Artifact>(apiPath(`/api/artifacts/${encodeURIComponent(id)}`), fields);
}

export async function archiveArtifact(id: string): Promise<void> {
  return postEmpty(apiPath(`/api/artifacts/${encodeURIComponent(id)}/archive`));
}

export async function listArchivedArtifacts(): Promise<Artifact[]> {
  // No archived-publication concept in cloud — the apex publish API only
  // exposes live publications.
  if (caps.cloud) return [];
  return getJson<Artifact[]>(apiPath("/api/artifacts/archived"));
}

export async function restoreArtifact(id: string): Promise<void> {
  return postEmpty(apiPath(`/api/artifacts/${encodeURIComponent(id)}/restore`));
}

export async function uninstallPlugin(id: string): Promise<void> {
  return postEmpty(apiPath(`/api/plugins/${encodeURIComponent(id)}/uninstall`));
}

export async function pinArtifact(id: string): Promise<{ id: string; pinnedAt: number }> {
  return postJson<{ id: string; pinnedAt: number }>(apiPath(`/api/artifacts/${encodeURIComponent(id)}/pin`));
}

export async function unpinArtifact(id: string): Promise<void> {
  return del(apiPath(`/api/artifacts/${encodeURIComponent(id)}/pin`));
}

export async function renameGroup(
  spaceId: string,
  oldName: string,
  newName: string,
): Promise<{ updated: number }> {
  return patchJson<{ updated: number }>(apiPath("/api/groups"), {
    space_id: spaceId,
    old_name: oldName,
    new_name: newName,
  });
}

export async function archiveGroup(spaceId: string, name: string): Promise<{ archived: number }> {
  return postJson<{ archived: number }>(apiPath("/api/groups/archive"), { space_id: spaceId, name });
}

export async function fetchSessionsForArtifact(
  id: string,
  signal?: AbortSignal,
): Promise<SessionJoinedForArtifact[]> {
  return getJson<SessionJoinedForArtifact[]>(
    apiPath(`/api/artifacts/${encodeURIComponent(id)}/sessions`),
    signal,
  );
}

