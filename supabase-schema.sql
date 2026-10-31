-- Teacher mode tables
CREATE TABLE IF NOT EXISTS classes (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  class_code VARCHAR(4) UNIQUE NOT NULL,
  teacher_name VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS class_members (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  class_code VARCHAR(4) NOT NULL REFERENCES classes(class_code),
  parent_id VARCHAR(255) NOT NULL,
  child_name VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Event mode tables
CREATE TABLE IF NOT EXISTS events (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  event_code VARCHAR(4) UNIQUE NOT NULL,
  event_name VARCHAR(255) NOT NULL,
  class_code VARCHAR(4) NOT NULL REFERENCES classes(class_code),
  created_by VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS event_photos (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  event_code VARCHAR(4) NOT NULL REFERENCES events(event_code),
  parent_id VARCHAR(255) NOT NULL,
  photo_url TEXT NOT NULL,
  matched_parent_id VARCHAR(255),
  matched_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_class_members_class_code ON class_members(class_code);
CREATE INDEX IF NOT EXISTS idx_class_members_parent_id ON class_members(parent_id);
CREATE INDEX IF NOT EXISTS idx_events_event_code ON events(event_code);
CREATE INDEX IF NOT EXISTS idx_events_class_code ON events(class_code);
CREATE INDEX IF NOT EXISTS idx_event_photos_event_code ON event_photos(event_code);
CREATE INDEX IF NOT EXISTS idx_event_photos_parent_id ON event_photos(parent_id);
CREATE INDEX IF NOT EXISTS idx_event_photos_matched_parent_id ON event_photos(matched_parent_id);

-- Multi-children support
CREATE TABLE IF NOT EXISTS children (
  child_id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  parent_id VARCHAR(255) NOT NULL,
  child_name VARCHAR(255),
  child_dob TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_children_parent_id ON children(parent_id);

-- One child per existing family
INSERT INTO children (parent_id, child_name, child_dob)
SELECT f.parent_id, f.child_name, f.child_dob
FROM families f
WHERE NOT EXISTS (SELECT 1 FROM children c WHERE c.parent_id = f.parent_id);

-- child_id on matched_photos + backfill
ALTER TABLE matched_photos ADD COLUMN IF NOT EXISTS child_id UUID REFERENCES children(child_id);
UPDATE matched_photos mp SET child_id = c.child_id
FROM children c WHERE mp.parent_id = c.parent_id AND mp.child_id IS NULL;

-- Dedupe camera-roll matches: one row per (child_id, asset_id).
-- NULLs allowed (event/teacher uploads have NULL asset_id / child_id).
ALTER TABLE matched_photos
  ADD CONSTRAINT matched_photos_child_asset_unique UNIQUE (child_id, asset_id);
