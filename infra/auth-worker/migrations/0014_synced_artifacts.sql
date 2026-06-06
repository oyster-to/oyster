-- 0014_synced_artifacts.sql — artefact registry mirror for the cloud remote
-- view (app.oyster.to Artefacts tab).
--
-- Metadata only: rows prove an artefact EXISTS and where (label, kind,
-- space, device). No file content, no publication state — oyster-publish
-- remains the sole source of truth for openable artefacts; the web client
-- joins the two by artifact_id.
--
-- LWW key is sync_version_at (the pushing device's sync_dirty_at, unix ms)
-- — deliberately NOT named updated_at, because artefacts already carry a
-- domain-level updated_at (artifact_updated_at below, datetime text).
--
-- Tombstones: rows with removed_at set are accepted on POST (deletions must
-- propagate) and filtered from GET. Pro-only; gate enforced on the Worker.

CREATE TABLE IF NOT EXISTS synced_artifacts (
  owner_id            TEXT    NOT NULL,
  artifact_id         TEXT    NOT NULL,
  device_id           TEXT,
  device_label        TEXT,
  label               TEXT    NOT NULL,
  artifact_kind       TEXT    NOT NULL,
  space_id            TEXT,
  project_id          TEXT,
  group_name          TEXT,
  source_origin       TEXT    NOT NULL DEFAULT 'manual',
  created_at          TEXT    NOT NULL,
  artifact_updated_at TEXT,
  removed_at          TEXT,
  pinned_at           INTEGER,
  sync_version_at     INTEGER NOT NULL,
  PRIMARY KEY (owner_id, artifact_id)
);

CREATE INDEX IF NOT EXISTS idx_synced_artifacts_owner_version
  ON synced_artifacts (owner_id, sync_version_at DESC);
