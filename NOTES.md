# Option B — `POST /join-class` (`devin/join-class`, Server Repo)

## What Was Added / Updated
- `index.js`:
  - **`class_members` existence check & error handling**:
    - Uses `.select('parent_id')` (never `.select('id')`, because the live `class_members` table only has `class_code`, `parent_id`, and `child_name`).
    - Explicitly checks the `error` returned by the `classes` lookup, the `families` lookup, the `class_members` existence select, and the `class_members` insert. On any error, logs the full error server-side (`console.error('join-class', err)`), inserts nothing, and returns `500 {"error":"server_error"}`.
  - **`getClientIp(req)`**:
    - Returns the first value of `req.headers['x-real-ip']` if present, otherwise `req.socket.remoteAddress`, or `null` when neither exists.
    - When `getClientIp(req)` returns `null`, `/join-class` skips the per-IP counter instead of lumping callers together under a single `'unknown'` key.
    - `app.set('trust proxy', true)` is left unchanged because the existing global rate limiter depends on it.
  - **Configurable per-IP and per-parent failure limits**:
    - `JOIN_CLASS_MAX_FAILURES_IP = Number(process.env.JOIN_CLASS_MAX_FAILURES_IP) || 20` (20 failed attempts per 10 minutes per IP).
    - `JOIN_CLASS_MAX_FAILURES_PARENT = Number(process.env.JOIN_CLASS_MAX_FAILURES_PARENT) || 5` (5 failed attempts per 10 minutes per `parentId`).
    - `JOIN_CLASS_WINDOW_MS = Number(process.env.JOIN_CLASS_WINDOW_MS) || 10 * 60 * 1000`.
    - Prunes expired entries on every call whenever a failure map has over `1000` entries.
  - **Input validation & capping**:
    - Validates `classCode` against `/^\d{4}$/` and returns `400 {"error":"invalid_class_code"}` otherwise.
    - Caps `childName` at `100` characters (`.slice(0, 100)`) and stores it in `class_members.child_name`.
- `package.json` & `test/index.js`:
  - `"test": "node --test test/"` runs all `*.test.js` files under `test/` via `test/index.js`.
  - `"lint": "npx --yes eslint@8 -c .eslintrc.json index.js delete-parent.js test/"`
  - `"check": "npm run lint && npm test"`

## Important Security & Operational Notes

### 1. Shared IP Addresses (Wi-Fi / Mobile Carrier CGNAT)
- Parents at a school meeting on the same Wi-Fi network, or on the same mobile carrier behind CGNAT, can share a single public IP address. Therefore, `20` failed attempts per 10 minutes per IP and `5` per `parentId` are **untested starting values** and are exposed as environment variables (`JOIN_CLASS_MAX_FAILURES_IP`, `JOIN_CLASS_MAX_FAILURES_PARENT`, `JOIN_CLASS_WINDOW_MS`) so they can be tuned without a code change.

### 2. `trust proxy`, `X-Forwarded-For`, and `X-Real-IP` on Railway (**UNVERIFIED until tested after deploy**)
- Express's `app.set('trust proxy', true)` causes `req.ip` to read the **left-most** entry of `X-Forwarded-For`, which a client can forge unless the edge proxy overwrites it.
- Railway's staff reply in a forum thread says the edge sets `X-Real-IP` and recommends it for rate limiting, while forum replies conflict about `X-Forwarded-For` handling; **marked UNVERIFIED until tested on Railway after deploy**.
- **Follow-up proposal**: The existing global rate limiter (`rateLimitHits`) still uses `req.ip`; once `getClientIp(req)` is verified on Railway, key the global limiter on `getClientIp(req)` as well.

### 3. Per-Parent vs. Per-IP Counter & Multi-Instance Limits
- Because any caller can supply any `parentId` (and generate new random `parentId`s), the per-parent counter is bypassed by new parent IDs; **the per-IP counter is the real protection**.
- In-memory counters reset on every deploy and do not share state across multiple server instances.

### 4. Missing Unique Constraint on `class_members` (Preview + Dedupe + Constraint SQL — NOT Run)
- `class_members` currently has no unique constraint on `(class_code, parent_id)`, so concurrent joins can still race and create duplicate rows.
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
