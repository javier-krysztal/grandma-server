-- =============================================================================
-- DESTRUCTIVE: Phase B Complete Undo / Rollback Script
-- WARNING: THIS SCRIPT IS DESTRUCTIVE.
-- Running this script permanently drops all Phase B tables (install_tokens,
-- grandma_tokens, classes_v2, class_members_v2, join_attempts, events_v2,
-- event_pool, saves, highlights, child_privacy, hidden_photos, reports,
-- reko_calls, children) and removes Phase B columns/constraints from
-- matched_photos, restoring the pre-Phase-B schema.
-- =============================================================================

BEGIN;

-- 1. Drop Phase B tables in reverse dependency order
DROP TABLE IF EXISTS highlights;
DROP TABLE IF EXISTS saves;
DROP TABLE IF EXISTS reports;
DROP TABLE IF EXISTS event_pool;
DROP TABLE IF EXISTS events_v2;
DROP TABLE IF EXISTS child_privacy;
DROP TABLE IF EXISTS hidden_photos;
DROP TABLE IF EXISTS join_attempts;
DROP TABLE IF EXISTS class_members_v2;
DROP TABLE IF EXISTS classes_v2;
DROP TABLE IF EXISTS grandma_tokens;
DROP TABLE IF EXISTS install_tokens;
DROP TABLE IF EXISTS reko_calls;

-- 2. Revert matched_photos constraints and columns
ALTER TABLE matched_photos DROP CONSTRAINT IF EXISTS matched_photos_child_asset_unique;
DROP INDEX IF EXISTS idx_matched_photos_child_id;
ALTER TABLE matched_photos DROP COLUMN IF EXISTS child_id;
ALTER TABLE matched_photos DROP COLUMN IF EXISTS sent_to_grandma;
ALTER TABLE matched_photos DROP COLUMN IF EXISTS uploader_display_name;
ALTER TABLE matched_photos DROP COLUMN IF EXISTS uploader_child_name;

-- 3. Drop children table last (referenced by matched_photos.child_id)
DROP TABLE IF EXISTS children;

-- 4. Restore v1 (parent_id, asset_id) unique index if needed
CREATE UNIQUE INDEX IF NOT EXISTS idx_matched_photos_parent_asset
  ON matched_photos(parent_id, asset_id);

COMMIT;
