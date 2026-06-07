-- Play counter: bumped by the app when a shared item loads. Anonymous, no PII.
ALTER TABLE gb_registry_items ADD COLUMN plays INTEGER NOT NULL DEFAULT 0;
