import type { Space } from "../../../shared/types";
import { caps } from "../caps";
import { getJson, patchJson, postJson, del, apiPath } from "./http";
import { fetchCloudSpaces } from "./cloud-spaces";

export async function fetchSpaces(): Promise<Space[]> {
  // Returns [] on failure rather than throwing — callers (App bootstrap)
  // expect a list, and a missing /api/spaces shouldn't crash the surface.
  if (caps.cloud) return fetchCloudSpaces();
  try {
    return await getJson<Space[]>(apiPath("/api/spaces"));
  } catch {
    return [];
  }
}

export async function createSpace(name: string): Promise<Space> {
  return postJson<Space>(apiPath("/api/spaces"), { name });
}

export async function updateSpace(spaceId: string, fields: { displayName?: string; color?: string }): Promise<Space> {
  return patchJson<Space>(apiPath(`/api/spaces/${spaceId}`), fields);
}

export async function convertFolderToSpace(folderName: string, sourceSpaceId: string = "home", merge?: boolean): Promise<Space> {
  return postJson<Space>(apiPath("/api/spaces/from-folder"), { folderName, sourceSpaceId, merge });
}

export async function promoteFolderToSpace(path: string, name?: string): Promise<Space> {
  return postJson<Space>(apiPath("/api/spaces/from-path"), { path, name });
}

export async function deleteSpace(spaceId: string, folderName?: string): Promise<void> {
  return del(apiPath(`/api/spaces/${spaceId}`), folderName ? { folderName } : undefined);
}
