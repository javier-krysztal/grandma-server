-- =============================================================================
-- Phase B Migration (B1 + B2 Schema & Backfill) — IDEMPOTENT
-- Safe to run BEFORE enabling MULTI_CHILD_ENABLED or CLASS_SHARING_ENABLED.
-- Does NOT drop existing constraints needed by v1 endpoints; see
-- migrations/002_phase_b_activate.sql for flag activation.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Per-install authentication tokens (stored as SHA-256 hex hashes only)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS install_tokens (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  parent_id VARCHAR(255) NOT NULL,
  token_hash VARCHAR(64) UNIQUE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_used_at TIMESTAMPTZ DEFAULT NOW(),
  revoked_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_install_tokens_parent_id ON install_tokens(parent_id);
ALTER TABLE install_tokens ENABLE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- 2. Children table + idempotent backfill from UNION of families & matched_photos
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS children (
  child_id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  parent_id VARCHAR(255) NOT NULL,
  child_name VARCHAR(255),
  child_dob TEXT,
  personal_collection_indexed BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_children_parent_id ON children(parent_id);
ALTER TABLE children ENABLE ROW LEVEL SECURITY;

-- Backfill one child per distinct parent_id across families UNION matched_photos
INSERT INTO children (parent_id, child_name, child_dob)
SELECT src.parent_id, src.child_name, src.child_dob
FROM (
  SELECT f.parent_id, f.child_name, f.child_dob
  FROM families f
  WHERE f.parent_id IS NOT NULL
  UNION
  SELECT mp.parent_id, NULL::VARCHAR(255) AS child_name, NULL::TEXT AS child_dob
  FROM matched_photos mp
  WHERE mp.parent_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM families f2 WHERE f2.parent_id = mp.parent_id)
) src
WHERE NOT EXISTS (
  SELECT 1 FROM children c WHERE c.parent_id = src.parent_id
);

-- Add child_id and sent_to_grandma columns on matched_photos and backfill
ALTER TABLE matched_photos ADD COLUMN IF NOT EXISTS child_id UUID REFERENCES children(child_id);
ALTER TABLE matched_photos ADD COLUMN IF NOT EXISTS sent_to_grandma BOOLEAN DEFAULT TRUE;
ALTER TABLE matched_photos ADD COLUMN IF NOT EXISTS uploader_display_name VARCHAR(255);
ALTER TABLE matched_photos ADD COLUMN IF NOT EXISTS uploader_child_name VARCHAR(255);

UPDATE matched_photos mp
SET child_id = (
  SELECT c.child_id
  FROM children c
  WHERE c.parent_id = mp.parent_id
  ORDER BY c.created_at ASC
  LIMIT 1
)
WHERE mp.child_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_matched_photos_child_id ON matched_photos(child_id);

-- -----------------------------------------------------------------------------
-- 3. Grandma long random access tokens + code attempt throttling
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS grandma_tokens (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  parent_id VARCHAR(255) NOT NULL,
  grandma_code VARCHAR(12) NOT NULL,
  token_hash VARCHAR(64) UNIQUE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  revoked_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_grandma_tokens_parent_id ON grandma_tokens(parent_id);
ALTER TABLE grandma_tokens ENABLE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- 4. Classes v2 (5-digit code, named class; child_id lives on class_members_v2)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS classes_v2 (
  class_id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  class_code VARCHAR(5) UNIQUE NOT NULL,
  class_name VARCHAR(255) NOT NULL,
  rekognition_collection_id VARCHAR(255) UNIQUE NOT NULL,
  created_by VARCHAR(255) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_classes_v2_code ON classes_v2(class_code);
ALTER TABLE classes_v2 ENABLE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- 5. Class Members v2: unique (class_id, child_id), role (admin|member),
--    status (pending|approved), display_name, consent tracking
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS class_members_v2 (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  class_id UUID NOT NULL REFERENCES classes_v2(class_id) ON DELETE CASCADE,
  child_id UUID NOT NULL REFERENCES children(child_id) ON DELETE CASCADE,
  parent_id VARCHAR(255) NOT NULL,
  display_name VARCHAR(255) NOT NULL,
  role VARCHAR(16) NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  status VARCHAR(16) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved')),
  consent_version VARCHAR(32) NOT NULL,
  consented_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (class_id, child_id)
);
CREATE INDEX IF NOT EXISTS idx_class_members_v2_class_status ON class_members_v2(class_id, status);
CREATE INDEX IF NOT EXISTS idx_class_members_v2_parent ON class_members_v2(parent_id);
ALTER TABLE class_members_v2 ENABLE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- 6. Join/Code Attempt Throttling (by parent_id AND IP)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS join_attempts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  parent_id VARCHAR(255),
  ip VARCHAR(64) NOT NULL,
  target_type VARCHAR(16) NOT NULL DEFAULT 'class' CHECK (target_type IN ('class', 'event', 'grandma')),
  attempted_code VARCHAR(16) NOT NULL,
  succeeded BOOLEAN NOT NULL DEFAULT FALSE,
  attempted_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_join_attempts_ip_time ON join_attempts(ip, attempted_at DESC);
CREATE INDEX IF NOT EXISTS idx_join_attempts_parent_time ON join_attempts(parent_id, attempted_at DESC);
ALTER TABLE join_attempts ENABLE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- 7. Events v2 (6-digit code, optional class_id)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS events_v2 (
  event_id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  event_code VARCHAR(6) UNIQUE NOT NULL,
  event_name VARCHAR(255) NOT NULL,
  class_id UUID REFERENCES classes_v2(class_id) ON DELETE SET NULL,
  created_by VARCHAR(255) NOT NULL,
  event_date DATE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_events_v2_code ON events_v2(event_code);
CREATE INDEX IF NOT EXISTS idx_events_v2_class_id ON events_v2(class_id);
ALTER TABLE events_v2 ENABLE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- 8. Event Pool (B2): private per-uploader pool, status (active|held|deleted),
--    starred_by / starred_at, 30-day expiry (7-day expiry for held moderation)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS event_pool (
  pool_id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  event_id UUID NOT NULL REFERENCES events_v2(event_id) ON DELETE CASCADE,
  parent_id VARCHAR(255) NOT NULL,
  s3_key TEXT NOT NULL,
  photo_url TEXT NOT NULL,
  content_hash VARCHAR(64) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'held', 'deleted')),
  moderation_labels JSONB,
  sharpness REAL,
  taken_at TIMESTAMPTZ,
  uploaded_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '30 days'),
  starred BOOLEAN DEFAULT FALSE,
  starred_by VARCHAR(255),
  starred_at TIMESTAMPTZ,
  matched BOOLEAN DEFAULT FALSE,
  UNIQUE (event_id, parent_id, content_hash)
);
CREATE INDEX IF NOT EXISTS idx_event_pool_event_status ON event_pool(event_id, status);
CREATE INDEX IF NOT EXISTS idx_event_pool_expires_at ON event_pool(expires_at);
ALTER TABLE event_pool ENABLE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- 9. Saves table (B2): tracks parent saves/hearts for highlight ranking
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS saves (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  pool_id UUID NOT NULL REFERENCES event_pool(pool_id) ON DELETE CASCADE,
  parent_id VARCHAR(255) NOT NULL,
  action_type VARCHAR(16) NOT NULL DEFAULT 'save' CHECK (action_type IN ('save', 'heart')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (pool_id, parent_id, action_type)
);
CREATE INDEX IF NOT EXISTS idx_saves_pool_id ON saves(pool_id);
ALTER TABLE saves ENABLE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- 10. Highlights (B2): up to 5 per event, references event_pool(pool_id)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS highlights (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  event_id UUID NOT NULL REFERENCES events_v2(event_id) ON DELETE CASCADE,
  pool_id UUID NOT NULL REFERENCES event_pool(pool_id) ON DELETE CASCADE,
  photo_url TEXT NOT NULL,
  source VARCHAR(24) NOT NULL CHECK (source IN ('uploader_star', 'creator_star', 'save_heart', 'auto')),
  rank INT NOT NULL CHECK (rank BETWEEN 1 AND 5),
  sent_to_grandma BOOLEAN DEFAULT FALSE,
  computed_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (event_id, pool_id)
);
CREATE INDEX IF NOT EXISTS idx_highlights_event_id ON highlights(event_id, rank);
ALTER TABLE highlights ENABLE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- 11. Child Privacy switches per (child_id, class_id)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS child_privacy (
  child_id UUID NOT NULL REFERENCES children(child_id) ON DELETE CASCADE,
  class_id UUID NOT NULL REFERENCES classes_v2(class_id) ON DELETE CASCADE,
  no_shared_photos BOOLEAN NOT NULL DEFAULT FALSE,
  no_match_in_others BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (child_id, class_id)
);
ALTER TABLE child_privacy ENABLE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- 12. Hidden photos (family-local hide + mismatch log)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS hidden_photos (
  parent_id VARCHAR(255) NOT NULL,
  photo_url TEXT NOT NULL,
  child_id UUID REFERENCES children(child_id) ON DELETE SET NULL,
  reason VARCHAR(32) DEFAULT 'mismatch',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (parent_id, photo_url)
);
ALTER TABLE hidden_photos ENABLE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- 13. Reports (with status column)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reports (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  reporter_id VARCHAR(255) NOT NULL,
  pool_id UUID REFERENCES event_pool(pool_id) ON DELETE SET NULL,
  photo_url TEXT NOT NULL,
  reason TEXT,
  status VARCHAR(16) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'reviewed', 'dismissed', 'removed')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status);
ALTER TABLE reports ENABLE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- 14. Daily Rekognition call counter (20,000/day ceiling enforcement)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reko_calls (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  endpoint VARCHAR(48) NOT NULL,
  parent_id VARCHAR(255),
  calls_count INT NOT NULL DEFAULT 1,
  blocked BOOLEAN NOT NULL DEFAULT FALSE,
  called_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_reko_calls_called_at ON reko_calls(called_at);
ALTER TABLE reko_calls ENABLE ROW LEVEL SECURITY;

COMMIT;
