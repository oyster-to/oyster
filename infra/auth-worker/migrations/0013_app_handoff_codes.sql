-- One-time codes for the apex → app.oyster.to auth handshake
-- (spec 2026-06-05-app-oyster-to-migration). The apex oyster_session
-- cookie is host-only (#397) and cannot follow to the subdomain; the
-- auth-worker mints a code here, oyster-cloud burns it and sets its own
-- host-only cookie with the same session id.
-- All timestamps are milliseconds since epoch (Date.now()), matching
-- sessions / magic_link_tokens / device_codes.
CREATE TABLE IF NOT EXISTS app_handoff_codes (
  code_hash   TEXT PRIMARY KEY,   -- sha256 hex of the raw token; raw never stored
  session_id  TEXT NOT NULL,     -- no REFERENCES sessions(id): codes are 60s-lived and GC'd by expires_at; the callback re-validates the session row anyway
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,   -- created_at + 60_000
  consumed_at INTEGER
);

-- The opportunistic GC path (DELETE … WHERE expires_at < ? LIMIT 100)
-- scans on expires_at; index it now while the table is empty.
CREATE INDEX IF NOT EXISTS idx_app_handoff_codes_expires_at
ON app_handoff_codes (expires_at);
