// cloud-artifacts.ts — the synced artefact REGISTRY for the cloud Artefacts
// tab (worker GET /api/artifacts/metadata). Rows prove an artefact exists
// and on which device; content stays on that machine, so url is empty and
// the row renders inert unless a live publication is joined onto it
// (artifacts-api.ts does the join — publish worker stays authoritative for
// what's openable).
import type { Artifact, ArtifactKind } from "../../../shared/types";
import { getJson, apiPath } from "./http";

interface CloudArtifactRow {
  artifact_id: string;
  device_id: string | null;
  device_label: string | null;
  label: string;
  artifact_kind: string;
  space_id: string | null;
  project_id: string | null;
  group_name: string | null;
  source_origin: string;
  created_at: string;
  artifact_updated_at: string | null;
  pinned_at: number | null;
  sync_version_at: number;
}

function toArtifact(r: CloudArtifactRow): Artifact {
  return {
    id: r.artifact_id,
    label: r.label,
    // Coerce like cloud-publications.ts: unknown kinds render the default
    // glyph, which is fine for a read-only listing.
    artifactKind: r.artifact_kind as ArtifactKind,
    spaceId: r.space_id ?? "",
    // Content lives on the origin device — there's nothing to open here
    // until artifacts-api.ts joins a live publication on.
    status: "offline",
    runtimeKind: "",
    runtimeConfig: {},
    url: "",
    createdAt: r.created_at,
    groupName: r.group_name ?? undefined,
    sourceOrigin: (["manual", "discovered", "ai_generated"] as const)
      .find((v) => v === r.source_origin) ?? "manual",
    projectId: r.project_id,
    pinnedAt: r.pinned_at,
    originDeviceLabel: r.device_label,
    // Routes relayed opens to the owning device when it's online
    // (artifacts-api.ts does the live join).
    originDeviceId: r.device_id,
  };
}

export async function fetchCloudArtifacts(signal?: AbortSignal): Promise<Artifact[]> {
  const data = await getJson<{ artifacts: CloudArtifactRow[] }>(
    apiPath("/api/artifacts/metadata"), signal,
  );
  return (data.artifacts ?? []).map(toArtifact);
}
