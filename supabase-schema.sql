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
