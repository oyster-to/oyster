import type { ArtifactKind } from "../../shared/types.js";

// Allow-list: known useful OUTPUT extensions → artefact kind. Source code,
// config, images (v1), and unknown extensions are NOT registered.
const KIND_BY_EXT: Record<string, ArtifactKind> = {
  md: "notes", markdown: "notes", txt: "notes", rst: "notes", rtf: "notes",
  docx: "notes", doc: "notes", pages: "notes", odt: "notes",
  csv: "table", tsv: "table", xlsx: "table", xls: "table", ods: "table", numbers: "table", parquet: "table",
  pdf: "deck", pptx: "deck", key: "deck", odp: "deck",
  mmd: "diagram", mermaid: "diagram", dot: "diagram", drawio: "diagram", excalidraw: "diagram",
  html: "wireframe", htm: "wireframe",
  ipynb: "notes", // no "notebook" ArtifactKind — .ipynb renders as notes
};

// Hard deny-list (path/name), applied even to allowed extensions: secrets,
// dependencies/vendor, caches, build output, temp, VCS, hidden dirs.
const DENY_SEGMENT = /(^|\/)(node_modules|vendor|bower_components|\.pnpm-store|\.venv|venv|\.cache|__pycache__|\.pytest_cache|\.mypy_cache|dist|build|target|\.next|\.nuxt|out|coverage|\.git|tmp|\.ssh|\.aws|secrets)(\/|$)/;
const DENY_NAME = /(^|\/)(\.env|\.npmrc|\.netrc|\.DS_Store|id_rsa|id_dsa|credentials)|\.(pem|key|p12|pfx|keystore|tmp|temp|swp)$|~$/i;
const HIDDEN_DIR = /\/\.[^/]+\//; // any intermediate directory segment beginning with "."

function ext(path: string): string {
  const base = path.split("/").pop() ?? "";
  const i = base.lastIndexOf(".");
  return i < 0 ? "" : base.slice(i + 1).toLowerCase();
}

/** Returns the artefact kind for a *useful file-output*, or null if the path
 *  is source code, an unknown type, or matches the secret/noise deny-list. */
export function classifyOutput(path: string): ArtifactKind | null {
  const p = path.replace(/\\/g, "/");
  if (DENY_SEGMENT.test(p) || DENY_NAME.test(p) || HIDDEN_DIR.test(p)) return null;
  return KIND_BY_EXT[ext(p)] ?? null;
}
