# Short-Code Failed-Lookup Throttling (`devin/grandma-throttle`, Server Repo)

## Complete List of Endpoints Accepting Short Guessable Codes

| Endpoint | Short Code Accepted | Returns Data or Changes State | Throttle Applied on Definitive Not-Found? |
|---|---|---|---|
| `GET /grandma-feed/:grandmaCode` | 4-digit `grandmaCode` | Returns signed S3 photo URLs and child info for the family | **Yes** (`!family` → counts failure; valid code polls never counted) |
| `GET /grandma-children/:code` | 4-digit `code` (`grandma_code`) | Returns children list for the family when `MULTI_CHILD_ENABLED` is on | **Yes** (`!family` → counts failure; valid code never counted) |
| `POST /grandma-heart` | 4-digit `grandmaCode` | Looks up family by `grandma_code` and sends WhatsApp heart message via Twilio | **Yes** (`!family` → counts failure; valid code never counted) |
| `POST /join-class` | 4-digit `classCode` | Looks up `classes` and adds parent to `class_members` | **Yes** (`!cls` → counts per-IP and per-parent failure) |
| `POST /join-event` | 4-digit `eventCode` | Looks up `events`, adds parent to `class_members`, returns `eventName` & `classCode` | **Yes** (`!event` → counts failure; valid code never counted) |
| `POST /event-upload` | 4-digit `eventCode` | Looks up `events`, uploads photo to S3, and routes matches to class members | **Yes** (`!event` → counts failure; valid code never counted) |
| `GET /event-feed/:eventCode` | 4-digit `eventCode` | Returns signed S3 photo URLs for the event | **Yes** (when `event_photos` is empty and `events` has no matching `event_code` → counts failure while preserving `[]` response for valid codes) |
| `POST /teacher-upload` | 4-digit `classCode` | Looks up `class_members` for `classCode` and routes matched photos | **Yes** (when `class_members` is empty and `classes` has no matching `class_code` → counts failure) |
| `POST /create-class` | 4-digit `classCode` | Inserts a new class with a teacher-chosen 4-digit code (creation, not lookup) | N/A (not a lookup) |
| `POST /create-event` | 4-digit `classCode` | Auto-creates class/member via `ensureClassMember` and generates a random 4-digit `event_code` | N/A (not a lookup) |

## Throttle Design & Configuration
- **Keyed on `getClientIp(req)`** (`req.headers['x-real-ip']` first value if present, otherwise `req.socket.remoteAddress`, or `null` if neither exists — skipping the per-IP counter when `null`).
- **Configurable via environment variables**:
  - `SHORT_CODE_MAX_FAILURES_IP` / `JOIN_CLASS_MAX_FAILURES_IP` (default `20` failures per window per IP).
  - `SHORT_CODE_WINDOW_MS` / `JOIN_CLASS_WINDOW_MS` (default `600000` ms = 10 minutes).
- **Counts only definitive not-found lookups**, never successful lookups or database errors (`500`).
- **When throttled**: returns HTTP `429` with JSON `{"error":"too_many_attempts"}`.
- **Response bodies for valid codes**: completely unchanged.
