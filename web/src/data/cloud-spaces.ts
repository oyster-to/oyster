// cloud-spaces.ts — maps the oyster-publish worker's synced_spaces rows
// (GET /api/spaces/mine on the APEX, NOT under the /app/api rewrite) into
// the local Space shape so the space switcher works in the cloud build.
import type { Space } from "../../../shared/types";

interface SyncedSpaceRow {
  owner_id: string;
  space_id: string;
  display_name: string;
  color: string | null;
  parent_id: string | null;
  summary_title: string | null;
  summary_content: string | null;
  updated_at: number; // epoch ms
  deleted_at: number | null;
  created_at: number; // epoch ms
}

function toSpace(r: SyncedSpaceRow): Space {
  return {
    id: r.space_id,
    displayName: r.display_name,
    color: r.color,
    parentId: r.parent_id,
    // Scan/registry fields have no cloud counterpart — the projects grid is
    // hidden in cloud (caps.hasProjects false), so these are inert defaults.
    scanStatus: "none",
    scanError: null,
    lastScannedAt: null,
    lastScanSummary: null,
    summaryTitle: r.summary_title,
    summaryContent: r.summary_content,
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}

export async function fetchCloudSpaces(): Promise<Space[]> {
  // Returns [] on failure rather than throwing — mirrors the local
  // fetchSpaces contract (App bootstrap expects a list).
  // Served by oyster-publish via the worker's service-binding proxy on app.oyster.to — call it directly (no apiPath).
  try {
    const res = await fetch("/api/spaces/mine");
    if (!res.ok) return [];
    const data = (await res.json()) as { spaces?: SyncedSpaceRow[] };
    // Drop tombstones — the cloud view only needs live spaces for the pills.
    return (data.spaces ?? [])
      .filter((r) => r.deleted_at == null)
      .map(toSpace);
  } catch {
    return [];
  }
}
