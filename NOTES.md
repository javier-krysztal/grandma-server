# Fix `class_members` Duplicates (`devin/fix-class-members`, Server Repo)

## Root Cause of the 9 Duplicate Rows in `class_members`
- In `ensureClassMember` (`index.js` line 703 on `origin/main`), the existence check ran:
  ```js
  const { data: existing } = await supabase
    .from('class_members')
    .select('id')
    .eq('class_code', classCode)
    .eq('parent_id', parentId)
    .limit(1);
  ```
- Because the live `class_members` table only has columns `(class_code, parent_id, child_name)` and no `id` column, `.select('id')` returned a Postgres column-not-found error (`data: null, error: ...`).
- `ensureClassMember` ignored `error`, treated `existing` as empty, and inserted a new duplicate `(class_code, parent_id, child_name)` row on every `/create-event` and `/join-event` call.

## Findings on `/teacher-upload` and `/event-upload` Photo Routing
- **`/teacher-upload` (`origin/main` lines 637–690) and `/event-upload` (`origin/main` lines 834–915)**:
  - Both endpoints query `class_members.select('parent_id').eq('class_code', ...)` (lines 638–640 and 835–837) and build `const parentIdsInClass = new Set(classMembers.map(m => m.parent_id))` (lines 659 and 877), then loop over `for (const externalId of matchedExtIds)` (lines 667 and 885).
  - Because the loop iterates over `matchedExtIds` (`findMatchingFaces` returns unique `ExternalImageId`s) and checks `parentIdsInClass.has(ownerParentId)`, duplicate `class_members` rows alone did not cause the loop body to execute multiple times when a parent had a single `ExternalImageId`.
  - **However**, if two different `ExternalImageId`s in `matchedExtIds` mapped to the same `ownerParentId` (via `childToParent[externalId] || externalId` at lines 669 and 887 — e.g. a parent with both a legacy `parent_id` face and a `child_id` face, or two children of the same parent when `MULTI_CHILD_ENABLED` is off), the loop wrote duplicate `event_photos` (lines 892–900) and `matched_photos` (lines 678–685 and 902–910) rows for the same recipient.
  - Added `seenRecipients = new Set()` in both `/teacher-upload` and `/event-upload` alongside `parentIdsInClass = new Set((classMembers || []).map(m => m.parent_id).filter(Boolean))` so each recipient receives at most one row per uploaded photo.

## What Was Fixed
1. `ensureClassMember`:
   - Uses check-then-insert on `classes` (`.select('class_code')`) and `class_members` (`.select('parent_id')`, never `.select('id')`).
   - Checks every Supabase error (`classSelectError`, `classInsertError`, `familyError`, `memberSelectError`, `memberInsertError`) and throws on any error before inserting.
2. `/create-event` and `/join-event`:
   - Check every Supabase error and return `500 {"error":"server_error"}` without leaking `err.message` or inserting partial rows.
3. `/teacher-upload` and `/event-upload`:
   - Deduplicate `parentIdsInClass` and `seenRecipients` with `Set`s before inserting `event_photos` / `matched_photos`.
4. `test/fix-class-members.test.js`:
   - Uses a strict fake `class_members` table that allows only `class_code`, `parent_id`, and `child_name` and returns an error for any other column.
   - Verifies `/create-event` + repeated `/join-event` calls insert no duplicate rows, failing existence selects return `500 {"error":"server_error"}` and insert nothing, and 9 duplicate `class_members` rows route only once in `/event-upload` and `/teacher-upload`.
