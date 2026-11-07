# Option B — `POST /join-class` (`devin/join-class`)

## What Was Added / Updated
- `index.js`:
  - **`class_members` existence check & `23505` handling**:
    - Uses `.select('parent_id')` (never `.select('id')`, because the live `class_members` table only has `class_code`, `parent_id`, and `child_name`).
    - Explicitly checks the `error` returned by the `classes` lookup, the `families` lookup, the `class_members` existence select, and the `class_members` insert. Treats Postgres error code `23505` (unique constraint violation from a concurrent double tap) on `class_members` insert as success, and on any other error logs server-side and returns `500 {"error":"server_error"}`.
  - **Input validation & capping**:
    - Validates `classCode` against `/^\d{4}$/` → `400 {"error":"invalid_class_code"}`.
    - Validates `parentId` is a string of 1–100 characters (`isValidParentId`) → `400 {"error":"invalid_parent_id"}` (also enforced in `/create-event` and `/join-event`).
    - Caps `childName` at `100` characters (`.slice(0, 100)`) and stores it in `class_members.child_name`.
  - **`getClientIp(req)`**:
    - Returns the first value of `req.headers['x-real-ip']` if present, otherwise `req.socket.remoteAddress`, or `null` when neither exists.
    - When `getClientIp(req)` returns `null`, `/join-class` skips the per-IP counter instead of lumping callers together under `'unknown'`.
    - `app.set('trust proxy', true)` is left unchanged because the existing global rate limiter depends on it.
  - **Configurable per-IP and per-parent failure limits**:
    - `JOIN_CLASS_MAX_FAILURES_IP = Number(process.env.JOIN_CLASS_MAX_FAILURES_IP) || 20` (20 failed attempts per 10 minutes per IP).
    - `JOIN_CLASS_MAX_FAILURES_PARENT = Number(process.env.JOIN_CLASS_MAX_FAILURES_PARENT) || 5` (5 failed attempts per 10 minutes per `parentId`).
    - `JOIN_CLASS_WINDOW_MS = Number(process.env.JOIN_CLASS_WINDOW_MS) || 10 * 60 * 1000`.
    - Prunes expired entries on every call whenever a failure map has over `1000` entries (verified in tests via `global.__getJoinClassFailureMapSizes()`).

## Important Security & Operational Notes

### 1. Shared IP Addresses (Wi-Fi / Mobile Carrier CGNAT)
- Parents on one school Wi-Fi or one mobile-carrier CGNAT address can share an IP, so `20` per IP and `5` per parent per 10 minutes are untested starting values and are configurable via environment variables.

### 2. `trust proxy`, `X-Forwarded-For`, and `X-Real-IP` on Railway (**UNVERIFIED until tested after deploy**)
- `app.set('trust proxy', true)` takes the left-most `X-Forwarded-For` value, which a client can forge unless the edge overwrites it.
- Railway's staff reply in a forum thread says the edge sets `X-Real-IP` and recommends it for rate limiting, while forum replies conflict about `X-Forwarded-For` handling; **marked UNVERIFIED until tested after deploy**.
- **Follow-up proposal**: The existing global rate limiter (`rateLimitHits`) still uses `req.ip`; once `getClientIp(req)` is verified on Railway, key the global limiter on `getClientIp(req)` as well.

### 3. Per-Parent vs. Per-IP Counter & Multi-Instance Limits
- The per-parent counter is bypassed by new parent IDs, so the per-IP counter is the real protection; counters reset on every deploy and don't work across multiple instances; any caller can supply any `parentId`.

### 4. Missing Unique Constraint on `class_members` (Preview + Dedupe + Constraint SQL — NOT Run)
- **Step 1 — Preview duplicates before modifying anything (NOT run):**
  ```sql
  select class_code, parent_id, count(*) from class_members group by class_code, parent_id having count(*) > 1;
  ```
- **Step 2 — Deduplicate and add unique constraint (NOT run):**
  ```sql
  DELETE FROM class_members a
  USING class_members b
  WHERE a.ctid > b.ctid
    AND a.class_code = b.class_code
    AND a.parent_id = b.parent_id;

  ALTER TABLE class_members
    ADD CONSTRAINT class_members_class_code_parent_id_key UNIQUE (class_code, parent_id);
  ```

### 5. Legacy Events Screen Auto-Created Classes & No Approval Step Yet
- Any class code typed on the Events screen auto-created a class before `/join-class`, so a mistyped code may sit in the wrong class, and there is no approval step yet.
