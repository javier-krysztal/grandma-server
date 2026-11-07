# Server Branch Notes Index (`devin/server-followups`)

- **Class Members Duplicate Fix & Upload Routing (`devin/fix-class-members`):** see [`docs/fix-class-members.md`](docs/fix-class-members.md)
- **`POST /join-class`, Throttling, IP Handling & Unique Constraint SQL (`devin/join-class`):** see [`docs/join-class.md`](docs/join-class.md)
- **CI Checks & Test Runner (`devin/ci-checks` / `devin/server-followups`):**
  - `npm run lint`: `npx --yes eslint@8 -c .eslintrc.json index.js delete-parent.js test/`
  - `npm test`: `node --test test/` (discovers and runs `fix-class-members.test.js`, `join-class.test.js`, and `server.test.js` via `test/index.js`)
  - `npm run check`: `npm run lint && npm test`
