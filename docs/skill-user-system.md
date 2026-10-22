# User System — Skill Reference

Covers the user data model, progress tracking, preferences, and admin user management. All implemented in `feature/dual-portal-xtream-support` (commit `54846ea`).

Related: [[skill-auth-system]] for login/tokens, [[skill-admin-dashboard]] for how `lastLogin` is surfaced, [[skill-subtitles]] for the OpenSubtitles account-linking fields.

---

## Models

### User (`src/models/User.ts`)

| Field | Type | Notes |
|-------|------|-------|
| `id` | INTEGER PK | Auto-increment |
| `email` | STRING | Unique, normalized to lowercase |
| `name` | STRING | Display name |
| `role` | STRING | `"admin"` or `"user"` |
| `isActive` | BOOLEAN | `false` until admin approves |
| `avatarUrl` | STRING | Google profile picture URL |
| `passwordHash` | STRING | PBKDF2 hash (null for Google-only users) |
| `salt` | STRING | Salt for password hashing |
| `preferences` | JSON | `{ preferredContentType, favorites[], recentChannels[], videoFitMode, lastSelectedCategory, lastSelectedCategoryTitle, recentCategories, pinnedCategories, categoryOrder, recentSearches, lastSelectedTvGroup, lastSelectedTvChannel }` — see [[#Preferences Structure]] |
| `lastLogin` | DATE | Set on every successful login (Google, admin-bootstrap, email/password — see `src/routes/account/auth.ts`). Powers the Admin Dashboard's "logged in last 24h/7d" stats and recent-logins list — see [[skill-admin-dashboard]] |
| `openSubtitlesUsername` | STRING | OpenSubtitles account username, if the user has linked one — see [[skill-subtitles]] |
| `openSubtitlesPasswordEnc` | TEXT | AES-256-GCM encrypted (reversible, not hashed — OpenSubtitles has no refresh-token flow, only re-login) via `src/auth/crypto.ts` |

`passwordHash` and `salt` are stripped from all API responses — never returned to clients. `openSubtitlesPasswordEnc` is likewise never returned; only `linked: boolean` and the username are exposed via `GET /api/user/opensubtitles`.

### UserProgress (`src/models/UserProgress.ts`)

Tracks per-user, per-profile watch progress.

| Field | Type | Notes |
|-------|------|-------|
| `userId` | INTEGER FK | References User |
| `profileId` | INTEGER | Active ConfigProfile at time of update |
| `mediaId` | STRING | Stream/movie/episode ID |
| `progress` | FLOAT | Playback position (seconds or %) |
| `completed` | BOOLEAN | Whether the item was fully watched |
| `meta` | JSON | Extra data (e.g. episode info) |

Upserted on each progress update (userId + profileId + mediaId is the unique key).

**Viewer store (`src/content/viewers.ts`, 2026-10-22).** Every viewer's rows are kept in memory and read from there (`GET /api/user/progress`, recommendations, Home rows next). It is the only writer of the table (`test/ownership.test.ts`): a write goes to SQLite, then the stored row is read back into memory, so memory equals the table, timestamps included; writes to one row run one at a time; bulk changes (pruned title, merged duplicates, sealing old stream links) reload the store. Loaded at start. 78 rows / 5 viewers on the live data. Checked against the table after new rows, updates, 20 concurrent saves, deletes, repoint, prune and clearing a viewer: equal at every step. `onViewerChange` tells derived data (Home rows) that a viewer's progress changed.

`mediaId` shares the same `movie_{id}`/`series_{id}` shape as `ContentMeta`'s primary key. When content is pruned as no-longer-present on the portal, any `UserProgress` row pointing at it is deleted too (otherwise it'd be a permanently orphaned Continue Watching entry) — see [[skill-content-lifecycle]].

### ContentCache (`src/models/ContentCache.ts`)

Generic response cache keyed by a string hash of query arguments.

| Field | Type | Notes |
|-------|------|-------|
| `cacheKey` | STRING PK | Hash of query args |
| `profileId` | INTEGER | Profile the cache belongs to |
| `response` | JSON | Cached payload |
| `expiresAt` | DATE | TTL timestamp |

Used as a generic API response cache. Check `expiresAt` before serving — expired entries should be refreshed.

---

## User API Routes (`src/routes/account/user.ts`)

All routes require a valid JWT (any role).

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/user/profile` | Returns `{ id, email, name, role, avatarUrl, preferences }` |
| `PUT` | `/api/user/preferences` | Merge-updates `user.preferences` (shallow merge, allowlisted keys only — see below). Pushes `preferences_changed` to the user's other sessions — see [[#Real-time preference sync]] |
| `GET` | `/api/user/progress` | All progress records for active profile. Re-proxies `meta.screenshot_uri` through `proxiedImageUrl` on every read (see note below). Adds `backdrop_path` per row (the title's backdrop, read from the catalog by `meta.catalogId` when answering, never stored) for the wide Continue Watching cards (design Phase 6) |
| `PUT` | `/api/user/progress` | Upsert progress: `{ mediaId, progress, completed, meta }` |
| `DELETE` | `/api/user/progress/{mediaId}` | Remove one progress record |
| `POST` | `/api/user/clear-history` | Deletes all progress for active profile + clears `recentChannels`. Also pushes `preferences_changed` — see [[#Real-time preference sync]] |
| `GET` | `/api/user/opensubtitles` | `{ linked, username }` — link status only, never the password |
| `PUT` | `/api/user/opensubtitles` | `{ username, password }` — verifies the login works *before* storing (encrypted), see [[skill-subtitles]] |
| `DELETE` | `/api/user/opensubtitles` | Unlink |

Progress is **profile-scoped** — switching active profile shows different history.

### `meta.screenshot_uri` re-proxying

The webui saves `meta.screenshot_uri` verbatim from whatever item was in memory at playback time (`useProgressTracking.ts`), so old rows saved before the `proxiedImageUrl` (`src/providers/portalAssets.ts`) image-proxy scheme existed still carry a raw upstream portal/CDN URL — this never self-heals since the row isn't rebuilt from the catalog. `GET /api/user/progress` re-applies `proxiedImageUrl` to `meta.screenshot_uri` on every read so old "Continue Watching" rows don't keep serving a raw `http://` URL (mixed-content errors on an HTTPS deployment). Same "store real, convert at serve time" pattern used everywhere images cross this API — see `enrichArtworkFromTmdb` (`src/routes/stalkerV2/shared.ts`), `mapChannel` (same file), and Discover's `toMediaItem` (`src/routes/discover/index.ts`).

---

## Admin User Management Routes (`src/routes/account/userManagement.ts`)

All routes require `role === "admin"`.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/admin/users` | List all users (ordered by createdAt DESC) |
| `POST` | `/api/admin/users` | Create user: `{ email, name, role, isActive, password? }` |
| `PUT` | `/api/admin/users/{id}` | Update user — activating triggers approval email |
| `DELETE` | `/api/admin/users/{id}` | Delete user (cannot delete self) |

### Self-protection guards (PUT)
- Cannot set `isActive: false` on own account
- Cannot change own `role` away from `admin`

### Approval email trigger
When `PUT /api/admin/users/{id}` flips a user from `isActive: false` → `true`, `sendUserApprovedEmail` fires asynchronously (errors are logged, not surfaced to the caller).

---

## Preferences Structure

```json
{
  "preferredContentType": "movie",
  "favorites": [],
  "recentChannels": [],
  "videoFitMode": "contain",
  "lastSelectedCategory": { "provider1_movie": "42" },
  "lastSelectedCategoryTitle": { "provider1_movie": "Action" },
  "recentCategories": { "provider1_movie": ["42", "7"] },
  "pinnedCategories": { "provider1_movie": ["42"] },
  "categoryOrder": { "provider1_movie": ["42", "7", "13"] },
  "recentSearches": ["batman"],
  "lastSelectedTvGroup": { "provider1": "3" },
  "lastSelectedTvChannel": { "provider1": "1091" }
}
```

`PUT /api/user/preferences` shallow-merges, so sending `{ "preferredContentType": "series" }` only updates that field. Sequelize requires `user.changed("preferences", true)` after mutating a JSON column — already handled in the route. New top-level keys need no migration — `preferences` is a plain JSON column, so any new field just appears the first time it's saved.

**Key allowlist (defense-in-depth, added in an uncommitted hardening pass):** the route now filters incoming payload keys through `ALLOWED_PREF_KEYS` before merging, instead of spreading the raw client payload — keeps the JSON column limited to keys `User.preferences` actually declares rather than accepting arbitrary client-supplied junk. `ALLOWED_PREF_KEYS` is `preferredContentType`, `favorites`, `recentChannels`, `videoFitMode`, `lastSelectedCategory`, `lastSelectedCategoryTitle`, `lastSelectedTvGroup`, `lastSelectedTvChannel`, `recentCategories`, `pinnedCategories`, `categoryOrder`, `recentSearches` — kept in sync with the `preferences` type in `src/models/User.ts`.

(Earlier draft of this allowlist copied only the first 8 keys from a stale `User.ts` type that had never been updated to match the 4 fields — `recentCategories`, `pinnedCategories`, `categoryOrder`, `recentSearches` — the webui added back in July; that gap was harmless while the route did a raw spread, but would have silently broken sync for those fields once the allowlist went live. Fixed 2026-08-05 by adding the missing keys to both the model type and the allowlist — see [[project_security_hardening]].)

`lastSelectedTvGroup`/`lastSelectedTvChannel` are keyed by `providerKey` (mirrors `lastSelectedCategory`'s keying) and record which TV group/channel the user last had focused in the live-TV grid (`useChannelListNav.ts` in `portalcast-webui`) — added so switching devices restores TV-grid position, not just the browse category, across sessions.

---

## Real-time preference sync

Preferences used to be pull-only: fetched on login, and (as of this session) re-fetched on tab focus/`visibilitychange`. They now also push instantly to a user's other open sessions:

1. **Client → server room join**: on socket connect, once a JWT is available, the webui (`SocketContext.tsx`) emits `join_user_room` with the token. `src/services/SocketService.ts` verifies it and joins that socket to room `user:{userId}` (token passed in the event payload, not the connection handshake — same pattern as the existing admin-only `start_logging`/`start_portal_metrics` events, since this socket has no auth gate at connect time).
2. **Server → push**: after `PUT /api/user/preferences` or `POST /api/user/clear-history` successfully saves, the route calls `socketService.broadcastPreferencesChanged(user.id, user.preferences)`, which emits `preferences_changed` to room `user:{userId}` only — never broadcast-to-all, so there's no cross-account leakage.
3. **Client → apply**: the webui listens for `preferences_changed` and calls `refreshProfile()` (the same function the focus/visibility pull path uses) rather than trusting the pushed payload directly — it re-fetches the canonical profile instead.

Net effect: change a favorite/category/TV-channel selection (or clear history) on one device, and any other logged-in session for that account picks it up near-instantly, without waiting for a tab to regain focus. See `src/services/SocketService.ts` (`join_user_room`, `broadcastPreferencesChanged`) and `portalcast-webui`'s `SocketContext.tsx`.

---

## Key Files

- `src/models/User.ts`
- `src/models/UserProgress.ts`
- `src/models/ContentCache.ts`
- `src/routes/account/user.ts`
- `src/routes/account/userManagement.ts`