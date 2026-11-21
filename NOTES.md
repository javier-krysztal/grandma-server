# Server Branch Notes Index

- **Class Members Duplicate Fix & Upload Routing (`devin/fix-class-members`):** see [`docs/fix-class-members.md`](docs/fix-class-members.md)
- **`POST /join-class`, Throttling, IP Handling & Unique Constraint SQL (`devin/join-class`):** see [`docs/join-class.md`](docs/join-class.md)
- **Teacher Upload `matched_photos.class_code` & Error Handling (`devin/teacher-upload-fix`):** see [`docs/teacher-upload-fix.md`](docs/teacher-upload-fix.md)
- **Short-Code Failed-Lookup Throttling (`devin/grandma-throttle`):** see [`docs/grandma-throttle.md`](docs/grandma-throttle.md)
- **CI Checks & Test Runner (`devin/ci-checks` / `devin/server-followups`):**
  - `npm run lint`: `npx --yes eslint@8 -c .eslintrc.json index.js delete-parent.js test/`
  - `npm test`: `node --test test/` (discovers and runs all `*.test.js` files under `test/` via `test/index.js`)
  - `npm run check`: `npm run lint && npm test`
- **Unique 4-Digit Code Retry on `23505` in `/create-class` and `/create-event` (`devin/create-class-event-retry`):** Retries up to 10 times with a newly generated 4-digit code on Postgres `23505` unique-constraint collision in both `POST /create-class` and `POST /create-event`, returning a clear error message if all 10 attempts collide (tested in `test/create-class-event-retry.test.js`).
