# Teacher Pool & Retroactive Class Backfill (`devin/teacher-pool-backfill`)

## What Was Added
1. **30-Day Teacher Class Pool (`teacher-pool/${classCode}/${hash}.jpg`):**
   - `POST /teacher-upload` saves every valid class upload once per `(classCode, hash)` to `teacher-pool/${classCode}/${hash}.jpg`, including when the class has no members yet (`"No families in this class yet"` early return) or when 0 current members match.
   - `ensureTeacherPoolLifecycle()` configures an S3 bucket lifecycle rule (`ID: 'expire-teacher-pool-30d'`, `Prefix: 'teacher-pool/'`, `Expiration: { Days: 30 }`) once per server start.
2. **Retroactive Class Backfill (`backfillClassPhotosForParent`):**
   - Triggered in the background after `POST /join-class` and `POST /save-reference`.
   - Collects up to 50 candidate photos from the last 30 days across `teacher-pool/${classCode}/` (Part B) and `matched_photos` for `classCode` (Part A), newest first.
   - Deduplicates by 16-char SHA-256 content hash before calling Rekognition and again before inserting into `matched_photos`.
   - Uses S3-to-S3 `rekognition.compareFaces` against `references/${parentId}.jpg` (and each child's reference when `MULTI_CHILD_ENABLED` is enabled) with `SimilarityThreshold = FACE_MATCH_THRESHOLD` (`90`).
   - If `compareFaces` returns 0 matches on a group photo with `>= 15` faces (`FaceMatches.length + UnmatchedFaces.length >= 15`), falls back to `findMatchingFaces` (crop-based search) so smaller faces beyond Rekognition's 15-face `CompareFaces` target limit are still matched.
   - Copies matched photos to `teacher-photos/${classCode}/${parentId}/${hash}.jpg` and stores `photo_url` in the exact same `publicS3Url` format as `/teacher-upload`.
   - Marks `teacherBackfillState` as `'done'` only after completion without error, allowing retries if a transient failure occurs.
