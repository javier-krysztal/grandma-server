-- =============================================================================
-- Phase B Flag Activation Script — IDEMPOTENT
-- Run ONLY when activating MULTI_CHILD_ENABLED=true / CLASS_SHARING_ENABLED=true,
-- after migrations/001_phase_b_up.sql has been applied and existing parent
-- faces have been re-indexed into personal/child collections.
--
-- Switches matched_photos deduplication from (parent_id, asset_id) to
-- (child_id, asset_id) so siblings under the same parent account can both
-- match the same camera-roll photo.
-- =============================================================================

BEGIN;

-- 1. Ensure any matched_photos rows created since 001_phase_b_up.sql have child_id
INSERT INTO children (parent_id, child_name, child_dob)
SELECT DISTINCT mp.parent_id, NULL::VARCHAR(255), NULL::TEXT
FROM matched_photos mp
WHERE mp.parent_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM children c WHERE c.parent_id = mp.parent_id);

UPDATE matched_photos mp
SET child_id = (
  SELECT c.child_id
  FROM children c
  WHERE c.parent_id = mp.parent_id
  ORDER BY c.created_at ASC
  LIMIT 1
)
WHERE mp.child_id IS NULL;

-- 2. Drop legacy (parent_id, asset_id) constraint / index only at flag activation
ALTER TABLE matched_photos DROP CONSTRAINT IF EXISTS matched_photos_parent_asset_key;
DROP INDEX IF EXISTS idx_matched_photos_parent_asset;

-- 3. Add plain unique constraint on (child_id, asset_id) (idempotent via DO block)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'matched_photos_child_asset_unique'
  ) THEN
    ALTER TABLE matched_photos
      ADD CONSTRAINT matched_photos_child_asset_unique UNIQUE (child_id, asset_id);
  END IF;
END $$;

COMMIT;
