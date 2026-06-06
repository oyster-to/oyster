-- Share registry v1 (spec: project-notes po20/2026-06-06-share-registry-spec.md)
CREATE TABLE IF NOT EXISTS gb_registry_items (
  id             TEXT PRIMARY KEY,
  kind           TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  name           TEXT NOT NULL,
  author         TEXT NOT NULL DEFAULT '',
  payload        TEXT NOT NULL,
  remix_of       TEXT,
  revision       INTEGER NOT NULL DEFAULT 1,
  edit_key_hash  TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
