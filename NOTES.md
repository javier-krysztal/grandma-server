# Task 2 — Phase B SQL & Plan (`devin/phase-b-sql`, Server Repo)

## Files Added
- `migrations/001_phase_b_up.sql`: Idempotent Phase B (B1 + B2) schema and backfill script.
  - Populates `children` from the union of `families` and `matched_photos`.
  - Moves `child_id` to `class_members_v2` with `UNIQUE (class_id, child_id)` and `role IN ('admin', 'member')`.
  - Adds `install_tokens`, `grandma_tokens`, `classes_v2`, `class_members_v2` (with `consent_version`, `consented_at`), `join_attempts` (with `ip`), `events_v2`, `event_pool` (with `status`, `starred_by`, `starred_at`), `saves`, `highlights` (with `pool_id`), `child_privacy`, `hidden_photos`, `reports` (with `status`), and `reko_calls`.
  - Enables Row Level Security (`ENABLE ROW LEVEL SECURITY`) with **no policies** on every new table.
- `migrations/002_phase_b_activate.sql`: Idempotent flag-activation script that drops `matched_photos_parent_asset_key` / `idx_matched_photos_parent_asset` and adds `matched_photos_child_asset_unique UNIQUE (child_id, asset_id)` only when flipping the flags.
- `migrations/003_phase_b_undo_DESTRUCTIVE.sql`: Complete rollback script clearly labeled `DESTRUCTIVE` at the top.
- `docs/phase-b-plan.md`: Full Phase B1 + B2 architecture, endpoint list, Rekognition collection design, effort estimates, and two-account single-phone test plan.

## Verification Status
- **Not run against any live database** (per instructions: no SQL or migrations executed against Supabase).
- **Unverified on live Postgres**: SQL syntax and idempotency reviewed statically; live execution against Supabase is intentionally deferred until approval.
