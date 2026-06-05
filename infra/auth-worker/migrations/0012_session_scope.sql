-- 0012_session_scope.sql — per-session space/project scope for the cloud
-- remote view's space switcher (#322 follow-up).
--
-- The remote view at oyster.to/app needs to scope synced sessions by space
-- (and project) the same way the local Home surface does. Neither column
-- existed on synced_session_metadata before — sessions synced under 0008
-- carry NULL until their origin device re-pushes. The local server bumps the
-- dirty marker once on upgrade so existing rows backfill on the next
-- reconcile; the UI falls back to "all spaces" for any still-NULL row.

ALTER TABLE synced_session_metadata ADD COLUMN space_id TEXT;
ALTER TABLE synced_session_metadata ADD COLUMN project_id TEXT;
