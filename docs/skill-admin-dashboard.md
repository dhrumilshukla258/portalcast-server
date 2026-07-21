# Admin Dashboard — Skill Reference

Covers the React-based admin panel (`/admin` in the web UI) added to replace the old standalone `/contentmanager` page for day-to-day use, plus the backend stats/streams endpoints it's built on.

Related: [[skill-stream-tokens]], [[skill-content-manager]], [[skill-auth-system]], [[skill-discover]]

---

## Why `/contentmanager` still exists but isn't the primary UI

`/contentmanager` (`src/routes/contentmanager/`) is a fully self-contained legacy mini-app — its own login (via `POST /api/auth/admin`), own vanilla JS/CSS, ~750 lines, served as one big HTML string. It still works and its backend API (`/api/admin/genres`, `/api/admin/items`, etc. — see [[skill-content-manager]]) is unchanged. But it required visiting a separate, unlinked URL.

The React admin panel (`portalcast-webui`'s `Admin.tsx`) now has a **Content** tab that reimplements the same genre/item CRUD + reordering against the *same* backend endpoints, inside the normal app navigation — no separate URL needed. See portalcast-webui's `skill-admin-panel.md`.

---

## Backend endpoints

### `GET /api/admin/stats` (`src/routes/account/userManagement.ts`)

Admin-only (`authCheck` + `role === "admin"`). Returns:

```ts
{
  users: { total, active, pending, admins, loggedInLast24h, loggedInLast7d },
  recentLogins: { id, name, email, role, lastLogin }[],  // top 10, newest first
  connectedDevices: number,      // socketService.getActiveDeviceCount()
  activeStreams: number,         // streamTracker.count()
  strm: { movies: number, episodes: number },  // StrmMovie/StrmSeries row counts
}
```

`loggedInLast24h`/`loggedInLast7d` and `recentLogins` depend on `User.lastLogin`, set on every successful login path (Google, admin-bootstrap, email/password — see `src/routes/account/auth.ts`). This is a plain additive column, picked up automatically by the existing `sequelize.sync({ alter: true })` migration — no manual `ALTER TABLE` needed.

### `GET /api/admin/streams` (`src/routes/account/userManagement.ts`)

Admin-only. Returns `{ count, sessions: StreamSession[] }` straight from `streamTracker.list()`. See [[skill-stream-tokens]] for the `StreamSession` shape (`type`, `kind`, `label`, `category`, `user`, `ip`, `resource`, `startedAt`, `lastSeen`).

### `GET /api/admin/portal-metrics` (`src/routes/account/userManagement.ts`)

Admin-only. Returns `requestMetrics.snapshot()` (`src/services/RequestMetrics.ts`) — outbound request volume *to the upstream Stalker/Xtream portal*, not viewer activity (that's `/api/admin/streams`/`streamTracker`, a separate signal). Answers "how hard are we hitting the portal", useful for diagnosing portal-side rate limiting (429s) or spotting load before it becomes a problem:

```ts
{
  totalRequests: number, totalErrors: number, since: string,        // ISO timestamp, process start
  byCategory: { live, movie, series, epg, auth, other },             // running totals
  timeline: { bucket, count, errorCount }[],                         // 1-min buckets, 6h retained
  recent: PortalRequestEvent[],                                      // last 200, seeds the live view
}
```

In-memory only (bounded ring buffer + rolling bucket window — doesn't survive a restart, can't grow unbounded). This REST call only seeds the *initial* page load — the live feed after that comes over Socket.IO (see below), not repeated polling of this endpoint.

### Live Socket.IO feeds — server logs & portal metrics (`src/services/SocketService.ts`)

Two admin-only live streams, same pattern for both: client emits a `start_*` event carrying the admin JWT (checked via `isAdminToken()`, since socket connections themselves are otherwise unauthenticated — device pairing/casting needs to keep working without a token), joins a room, and receives push events until it emits the matching `stop_*` event or disconnects.

- **Server logs** — `start_logging`/`stop_logging` → room `"logging"` → `server_log` events (`{ level, message, timestamp }`). Fed by `src/infra/logger.ts`, which wraps every `logger.info/warn/error/debug/fatal` call and also broadcasts it over the socket via `socketService.broadcastLog()` (set through `setLogBroadcaster()` to avoid a circular import between the logger and the socket service). This is the "logs" tab in the Admin Dashboard — there is no REST endpoint for it, it's socket-only.
- **Portal metrics live feed** — `start_portal_metrics`/`stop_portal_metrics` → room `"portal-metrics"` → `portal_request` events, emitted by `requestMetrics.record()` on every tracked portal call. Pairs with the `GET /api/admin/portal-metrics` snapshot above (snapshot for initial paint, socket room for everything after).

### User management — `GET/POST /api/admin/users`, `PUT/DELETE /api/admin/users/{id}` (`src/routes/account/userManagement.ts`)

Admin-only CRUD over the `Users` table — this is what backs the Admin Dashboard's Users tab (approve pending signups, promote/demote role, disable, reset password, delete):

- `GET /api/admin/users` — list all users, newest-first. Strips `passwordHash`/`salt`/`openSubtitlesPasswordEnc` from every row.
- `POST /api/admin/users` — admin-created user (email/name required; role defaults to `"user"`; `isActive` defaults to `true` — i.e. admin-created users skip the normal pending-approval flow that self-registered users go through).
- `PUT /api/admin/users/{id}` — update name/role/isActive/password. Flipping `isActive` false→true (approving a pending signup) fires `sendUserApprovedEmail()`. **Self-protection guardrails**: an admin cannot deactivate their own account or demote their own role via this endpoint.
- `DELETE /api/admin/users/{id}` — also blocked against self-deletion.

### `POST /api/admin/strm/generate` / `POST /api/admin/strm/reset` (`src/routes/contentmanager/strm.ts`)

`generate` — fire-and-forget trigger for `.strm` regeneration. Has a **concurrency guard** at the `strmGenerator.ts` level — a second call while one is already running is a no-op with a log warning, rather than two generations racing on the same DB rows/files. See [[skill-content-manager]] for the generation logic itself.

`reset` — clears the `StrmMovie`/`StrmSeries` tracking tables so the next `generate` call treats every title as brand-new and rewrites the whole output library from scratch. **Destructive-adjacent, gated behind a confirmation step**: calling without `?confirm=true` returns 400 with a warning (row counts + an explicit reminder to manually delete the on-disk `.strm` folders first, or the old files become orphaned with no tracking row). Only actually clears DB rows — never touches the filesystem itself.

### Content metadata enrichment — `POST /api/admin/content-meta/enrich`, `GET /api/admin/content-meta/status` (`src/routes/contentmanager/metaEnrichment.ts`)

Part of the Discover feature ([[skill-discover]]), surfaced here because it's the same kind of manual-trigger-only admin action as STRM generation. `enrich` fire-and-forget triggers a full TMDB catalog backfill (`enrichContentMeta()` — hours-long at the throttled rate, hence manual-only, never automatic). `status` returns `{ total, byType, bySource }` counts from `ContentMeta` so the dashboard can show enrichment progress without polling the (potentially hours-long) enrich call itself.

---

## `socketService.getActiveDeviceCount()` (`src/services/SocketService.ts`)

Small public getter added on top of the existing (pre-existing) `devices` Map, which tracks Socket.IO connections tagged `receiver`/`controller` via the `register` event — this is **app-open / paired-device state**, not "currently playing a stream" (that's `streamTracker`, a completely separate signal). Don't conflate the two when reading `/api/admin/stats`'s `connectedDevices` vs `activeStreams`.

---

## Design decisions worth knowing

- **"Active streams" identity is IP+resource-keyed, not session-keyed** — see [[skill-stream-tokens]] for why (HLS has no clean start/end event). The idle timeout (`STREAM_IDLE_TIMEOUT_MS`, default 60s) controls how "sticky" the live view is; too short and actively-playing streams flicker out of the list if the player buffers ahead and goes quiet.
- **Frontend refresh rate for the Live Streams table is user-configurable** (free-text seconds input, persisted to `localStorage`), not hardcoded — deliberately, since different deployments have different tolerance for polling frequency vs. freshness. Changing it only affects how often the browser re-fetches; it never clears currently-displayed data (`setStreams(response)` is a single atomic replace, no flicker).
- **Movie/series titles shown in the streams table come from the frontend**, not resolved server-side from any ID — see [[skill-stream-tokens]]'s Lessons #2. The backend just stores whatever `title`/`category` query params arrive on the `movie-link`/`channel-link` request.

---

## Key Files

- `src/routes/account/userManagement.ts` — `/api/admin/stats`, `/api/admin/streams`, `/api/admin/portal-metrics`, user CRUD
- `src/services/RequestMetrics.ts` — portal request-volume tracking backing `/api/admin/portal-metrics` and the `portal_request` socket feed
- `src/services/SocketService.ts` — `getActiveDeviceCount()`, live logs (`start_logging`/`server_log`) and live portal-metrics (`start_portal_metrics`/`portal_request`) rooms, `isAdminToken()`
- `src/infra/logger.ts` — wraps `logger.*` calls to also broadcast over the `"logging"` socket room
- `src/models/User.ts` — `lastLogin` column
- `src/routes/account/auth.ts` — where `lastLogin` gets set
- `src/routes/contentmanager/strm.ts` — `/api/admin/strm/generate`, `/api/admin/strm/reset`
- `src/content/strmGenerator.ts` — generation logic + concurrency guard (see [[skill-content-manager]])
- `src/routes/contentmanager/metaEnrichment.ts` — `/api/admin/content-meta/enrich`, `/api/admin/content-meta/status` (see [[skill-discover]])
