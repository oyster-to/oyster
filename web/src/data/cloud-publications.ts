// cloud-publications.ts — the cloud Artefacts tab shows what you've
// PUBLISHED (oyster-publish worker, apex /api/publish/* — same origin as
// /app, Origin header allowlisted for mutations). Publications are mapped
// into Artifact-shaped objects so the existing tab renders them unchanged.
import type { Artifact, ArtifactKind } from "../../../shared/types";
import { getJson, del, patchJson } from "./http";

interface Publication {
  share_token: string;
  artifact_id: string;
  artifact_kind: string;
  mode: "open" | "password" | "signin";
  content_type: string;
  size_bytes: number;
  published_at: number;
  updated_at: number;
  label: string | null;
  space_id: string | null;
}

export const shareUrl = (token: string) => `https://share.oyster.to/p/${token}`;

function toArtifact(p: Publication): Artifact {
  return {
    id: p.artifact_id,
    label: p.label ?? `${p.artifact_kind} · ${p.share_token.slice(0, 8)}`,
    url: shareUrl(p.share_token),
    // Artifact.artifactKind is the ArtifactKind union, not a free string;
    // publications carry an arbitrary kind, so coerce for the type. The tab
    // components only use it for the icon — an unknown value renders the
    // default glyph, which is acceptable for the cloud read-only view.
    artifactKind: p.artifact_kind as ArtifactKind,
    sourceOrigin: "manual",
    // Full ArtefactPublication shape (shared/types.ts) — the UI reads
    // `shareMode` and treats `unpublishedAt === null` as "live"; a partial
    // object makes every publication invisibly filtered out.
    publication: {
      shareToken: p.share_token,
      shareUrl: shareUrl(p.share_token),
      shareMode: p.mode,
      publishedAt: p.published_at,
      updatedAt: p.updated_at,
      unpublishedAt: null, // /api/publish/mine returns live publications only
    },
    createdAt: new Date(p.published_at).toISOString(),
    // Artifact.spaceId is `string`, not nullable — fall back to "" so the
    // object typechecks without widening. Cloud has no space scoping anyway.
    spaceId: p.space_id ?? "",
    status: "online", // member of the ArtifactStatus union
    runtimeKind: "",
    runtimeConfig: {},
  };
}

export async function fetchCloudPublications(signal?: AbortSignal): Promise<Artifact[]> {
  const data = await getJson<{ publications: Publication[] }>("/api/publish/mine", signal);
  return (data.publications ?? []).map(toArtifact);
}

export function unpublishCloud(token: string): Promise<void> {
  return del(`/api/publish/${encodeURIComponent(token)}`);
}

export function setCloudAccessMode(token: string, mode: "open" | "signin"): Promise<void> {
  return patchJson<void>(`/api/publish/${encodeURIComponent(token)}`, { mode });
}
