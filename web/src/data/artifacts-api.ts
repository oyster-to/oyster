export type { Artifact, ArtifactKind, ArtifactStatus, IconStatus, SessionJoinedForArtifact } from "../../../shared/types";
import type { Artifact, SessionJoinedForArtifact } from "../../../shared/types";
import { getJson, patchJson, postJson, postEmpty, del, apiPath } from "./http";
import { caps } from "../caps";
import { fetchCloudPublications } from "./cloud-publications";
import { fetchCloudArtifacts } from "./cloud-artifacts";

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
    return [...merged, ...pubById.values()];
  }
  return getJson<Artifact[]>(apiPath("/api/artifacts"), signal);
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

