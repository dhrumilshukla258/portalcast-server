# Admin Dashboard — Skill Reference

Covers the React-based admin panel (`/admin` in the web UI) added to replace the old standalone `/contentmanager` page for day-to-day use, plus the backend stats/streams endpoints it's built on.

Related: [[skill-stream-tokens]], [[skill-content-manager]], [[skill-auth-system]]

---

## Why `/contentmanager` still exists but isn't the primary UI

`/contentmanager` (`src/routes/contentmanager/`) is a fully self-contained legacy mini-app — its own login (via `POST /api/auth/admin`), own vanilla JS/CSS, ~750 lines, served as one big HTML string. It still works and its backend API (`/api/admin/genres`, `/api/admin/items`, etc. — see [[skill-content-manager]]) is unchanged. But it required visiting a separate, unlinked URL.

The React admin panel (`stalker-ui`'s `Admin.tsx`) now has a **Content** tab that reimplements the same genre/item CRUD + reordering against the *same* backend endpoints, inside the normal app navigation — no separate URL needed. See stalker-ui's `skill-admin-panel.md`.

---

## Backend endpoints

### `GET /api/admin/stats` (`src/routes/userManagement.ts`)

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

`loggedInLast24h`/`loggedInLast7d` and `recentLogins` depend on `User.lastLogin`, set on every successful login path (Google, admin-bootstrap, email/password — see `src/routes/auth.ts`). This is a plain additive column, picked up automatically by the existing `sequelize.sync({ alter: true })` migration — no manual `ALTER TABLE` needed.

### `GET /api/admin/streams` (`src/routes/userManagement.ts`)

Admin-only. Returns `{ count, sessions: StreamSession[] }` straight from `streamTracker.list()`. See [[skill-stream-tokens]] for the `StreamSession` shape (`type`, `kind`, `label`, `category`, `user`, `ip`, `resource`, `startedAt`, `lastSeen`).

### `POST /api/admin/strm/generate` (`src/routes/contentmanager/`, pre-existing)

Fire-and-forget trigger for `.strm` regeneration. Now also has a **concurrency guard** at the `strmGenerator.ts` level — a second call while one is already running is a no-op with a log warning, rather than two generations racing on the same DB rows/files. See [[skill-content-manager]] for the generation logic itself.

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

- `src/routes/userManagement.ts` — `/api/admin/stats`, `/api/admin/streams`, user CRUD
- `src/services/SocketService.ts` — `getActiveDeviceCount()`
- `src/models/User.ts` — `lastLogin` column
- `src/routes/auth.ts` — where `lastLogin` gets set
- `src/content/strmGenerator.ts` — generation logic + concurrency guard (see [[skill-content-manager]])
