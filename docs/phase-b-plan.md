# Phase B Architecture & Implementation Plan (B1 + B2)

## Overview & Feature Flags
- **`MULTI_CHILD_ENABLED`** (default `false`) and **`CLASS_SHARING_ENABLED`** (default `false`) keep all existing v1 endpoints working for installed builds until migrations and face re-indexing complete.
- All new or breaking behavior lives under **`/v2/*`** routes (or behind a `x-client-version: 2` header). Existing v1 endpoints remain untouched.

---

## 1. Security, Auth & Storage Rules (B1)
1. **Per-install Auth Token (`install_tokens`)**:
   - On first launch (or account creation), the app generates a 32-byte cryptographically random token and stores the raw token in `AsyncStorage`.
   - The server stores only `SHA-256(token)` in `install_tokens(parent_id, token_hash, created_at, last_used_at, revoked_at)`.
   - Every mutating `/v2/*` endpoint verifies `Authorization: Bearer <token>` against `install_tokens` and checks that `parent_id` matches the resource owner.
2. **Opaque S3 Keys**:
   - All new S3 keys use `photos/<random-uuid>.jpg` (and `refs/<random-uuid>.jpg`).
   - S3 keys **never** contain `parent_id` or `child_id`; ownership mapping lives strictly in Supabase.
3. **Row Level Security (RLS)**:
   - Every new table in `migrations/001_phase_b_up.sql` has `ENABLE ROW LEVEL SECURITY` with **no policies**, blocking all PostgREST `anon` key access while allowing the server's `service_role` key to operate normally.

---

## 2. Database Schema & Migration Sequence
- **`migrations/001_phase_b_up.sql`** (idempotent, safe to run while v1 is live):
  - Populates `children` from the **UNION** of `families.parent_id` and `matched_photos.parent_id` so parents without a `families` row are still migrated.
  - Creates `install_tokens`, `grandma_tokens`, `classes_v2` (5-digit code, `class_name`, `rekognition_collection_id`, no `child_id`), `class_members_v2` (`UNIQUE (class_id, child_id)`, `role IN ('admin','member')`, `status IN ('pending','approved')`, `display_name`, `consent_version`, `consented_at`), `join_attempts` (throttled by `parent_id` AND `ip`), `events_v2` (6-digit code, optional `class_id`), `event_pool` (`status IN ('active','held','deleted')`, `starred_by`, `starred_at`, 30-day `expires_at`), `saves`, `highlights` (with `pool_id` FK), `child_privacy`, `hidden_photos`, `reports` (with `status`), and `reko_calls`.
- **`migrations/002_phase_b_activate.sql`** (run only at flag flip):
  - Drops `matched_photos_parent_asset_key` / `idx_matched_photos_parent_asset` and adds `matched_photos_child_asset_unique UNIQUE (child_id, asset_id)` so siblings in the same family can both match the same photo.
- **`migrations/003_phase_b_undo_DESTRUCTIVE.sql`** (labeled `DESTRUCTIVE`):
  - Drops all Phase B tables, columns, and constraints in reverse dependency order and restores `idx_matched_photos_parent_asset`.

---

## 3. Rekognition Collections & Matching (B1)
- **Personal Collection per Parent Account**: `katan-parent-<hash(parent_id)>` used for solo camera-roll scans (`/v2/check-photo`), with faces indexed under `ExternalImageId = child_id`.
- **Class Collection per Class**: `katan-class-<class_id>` created when a class is created.
  - A child's reference face is indexed into `katan-class-<class_id>` only when membership is **approved** (`status = 'approved'`), and deleted immediately on **leave** or **member removal**.
  - Updating a child's reference photo re-indexes that child's face in the parent's personal collection and every approved class collection for that child.
- **Shared Pool Retirement**: Legacy `grandma-app` collection remains intact until all active users have `personal_collection_indexed = true`, then is retired during activation.
- **Crop & Burst Optimization**:
  - Uses shared `detectFaces` + `sharp` crop pipeline against the target collection only (`MaxFaces: 4096`, `FACE_MATCH_THRESHOLD = 90`).
  - Caps searched faces per photo (max 20), skips tiny faces (<64px bounding box), and deduplicates photo bursts before calling Rekognition.
- **Daily Ceiling**: Server tracks calls in `reko_calls` and pauses Rekognition processing at **20,000 calls/day** with a friendly status message while logging blocked attempts.

---

## 4. Phase Split & Effort Estimates

### Phase B1 (~5–6 days)
Includes everything except the private event pool, highlights pipeline, moderation, and 30-day expiry:
1. Per-install auth tokens (`install_tokens`) + middleware + opaque S3 keys (`0.5d`).
2. Migration `001_phase_b_up.sql` + `002_phase_b_activate.sql` + multi-child activation (`0.5d`).
3. Personal per-parent Rekognition collection + per-class Rekognition collection lifecycle (`1d`).
4. Class lifecycle (`/v2/create-class`, `/v2/class-info/:code`, `/v2/request-join` with IP+parent throttling and consent recording, `/v2/approve-member`, `/v2/reject-member`, `/v2/pending-requests` admin badge, `/v2/my-classes`, `/v2/leave-class`, `/v2/remove-member`) (`1.5d`).
5. Events v2 (6-digit code, optional class, read-only `"Sharing with: <class> (N families)"` header, date-filtered picker, attributions `"<display name>, <child>'s parent"`) (`1d`).
6. Grandma long-token SMS link + throttled code fallback + `/v2/send-to-grandma` (`0.5d`).
7. Safeguards in B1: per-(child, class) privacy switches (`child_privacy`), family-local hide (`hidden_photos`), rate limits (200/share, 500/day/member, 20k/day global ceiling), consent screen (Hebrew), and **EAS Update** configuration on preview profile (`1d`).

### Phase B2 (~4 days)
1. Private `event_pool` storage (content-hash deduped, visible only to uploader) + 30-day S3 lifecycle rule + scheduled DB cleanup (`1d`).
2. `DetectModerationLabels` on shared uploads (`status = 'held'`, visible only to uploader, auto-deleted after 7 days, no human review queue; ~$1/1,000 images) (`0.75d`).
3. Highlights pipeline (`highlights`, `saves`, `/v2/star-photo`): up to 5 per event per class — ordered by (1) uploader stars (max 3, with Skip), (2) teacher/creator stars within 7 days, (3) saves & hearts, (4) auto-fill by face sharpness + burst dedupe + time-slice spread; excludes opted-out children; rendered in separate `"מהאירוע"` strip with `"שלח לסבתא"` button (`1.5d`).
4. Uploader batch delete (`/v2/my-uploads`), `reports` endpoint, extended `delete-parent.js` and new `delete-class.js` (`0.75d`).

---

## 5. Two-Account Single-Phone Test Plan
1. **Account A (Admin)**: Create parent account + child → create class (5-digit code) → verify admin role.
2. **Switch User → Account B (Member)**: Create second parent + child → enter 5-digit class code → review Hebrew consent screen → submit join request (verify IP/parent throttle on bad codes).
3. **Switch User → Account A**: See pending-requests badge → approve Account B → verify B's child face is indexed into `katan-class-<class_id>`.
4. **Event & Group Match**: Account A creates 6-digit event linked to class → Account B opens event, sees `"משתף עם: <class> (2 משפחות)"`, uploads group photo containing both children → verify both families receive the matched photo labeled with event name and sender attribution.
5. **Privacy & Removal**: Account B toggles `no_match_in_others` → re-test upload → verify B's child is excluded; test leaving class removes face from class collection.
