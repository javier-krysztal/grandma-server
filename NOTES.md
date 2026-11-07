# Teacher Upload Fix (`devin/teacher-upload-fix`, Server Repo)

## What Was Changed
1. **`supabase-schema.sql`**:
   - Added `ALTER TABLE matched_photos ADD COLUMN IF NOT EXISTS class_code TEXT;` with a comment noting that the live database received it on Nov 7, 2026.
2. **`index.js` — `POST /teacher-upload`**:
   - Checks `childRowsError` when `MULTI_CHILD_ENABLED` is enabled.
   - Checks `insertError` on `matched_photos.insert(insertRow)`. When `insertError` occurs, `matches` is not incremented, the error is logged server-side (`console.error('teacher-upload', err)`), and the endpoint returns HTTP `500` with JSON `{"error":"server_error","failed":true,"matches":0}` (never counting a failed insert as a success, and never leaking raw database errors).
   - On success, returns `200` with `{"matches": matches, "totalFaces": matchedExtIds.length, "failed": false}`.
3. **`test/teacher-upload.test.js`**:
   - Uses a strict fake `matched_photos` table that errors when any column outside `allowedMatchedPhotosCols` is inserted or selected.
   - Verifies that when `class_code` is missing from `matched_photos`, `POST /teacher-upload` returns `500 {"error":"server_error","failed":true,"matches":0}` and inserts 0 rows.
   - Verifies that when `class_code` is present on `matched_photos`, `POST /teacher-upload` returns `200 {"matches":1,"totalFaces":1,"failed":false}` and inserts the row.

## App Change Needed for Teacher Upload Summary (Described Only, Not Made)
- Currently in `katan-app` (`App.js`, `TeacherHomeScreen.sendPhotos`), all selected photos are uploaded via `Promise.all(selectedPhotos.map(...))`:
  - If any single `/teacher-upload` call returns HTTP `500`, `Promise.all` rejects immediately and jumps to `catch (error)`, showing a generic error alert (`Alert.alert('שגיאה', ...)`) instead of a summary of how many photos succeeded, how many matched, and how many failed.
- **Required app change in `TeacherHomeScreen.sendPhotos`:**
  - Replace `Promise.all` with a sequential loop (or `Promise.allSettled`) that wraps each `axios.post(\`\${API_BASE}/teacher-upload\`, ...)` in its own `try / catch`.
  - Track `sentCount`, `totalMatches` (`data.matches || 0`), `failedCount` (incremented in `catch` or when `data?.failed`), and `failedPhotos`.
  - Show a summary alert that includes failed count when `failedCount > 0` (e.g. `"נשלחו X תמונות, נמצאו Y התאמות (Z תמונות נכשלו)"`) and keep `failedPhotos` in `selectedPhotos` so the teacher can retry only the failed photos.
