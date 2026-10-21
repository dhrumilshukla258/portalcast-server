# Broken Streams (Stream Failures) — Skill Reference

Tracks titles the portal still **lists** but whose stream is **dead**, auto-hides movies after 3 failed attempts where the upstream answered "not found" (404/410; connection-limit errors, 5xx, timeouts and network drops are listed but never hide), and gives the admin a "Broken streams" view to test/unhide/dismiss them. Owner's rule: *"after 3 tries hide it and give admin a view of failed urls so they can try and fix it."*

Related: [[skill-stream-tokens]], [[skill-content-manager]], [[skill-content-lifecycle]], [[skill-database]], [[skill-admin-dashboard]]

---

## Why this exists

Verified against the owner's real Stalker portal: some titles stay listed but their CDN file is gone. `movie-link` succeeds and mints `/api/proxy?t=…`, then `GET /api/proxy` returns `404 {"error":"Failed to fetch stream"}` because the upstream fetch fails. The content-lifecycle sweep ([[skill-content-lifecycle]]) only removes titles the portal stops *listing* — nothing handled listed-but-dead titles.

Live channels fail too (`500 {"error":"Failed to generate URL"}` from `/live.m3u8`) but **intermittently** (portal connection limits), so live is never auto-hidden.

---

## Identity: what a token carries (`StreamTokenMeta`, `src/services/StreamTokens.ts`)

| Field | Meaning |
|-------|---------|
| `itemType` | `"movie"` \| `"episode"` \| `"live"` |
| `itemId` | The **list** item id the client browses by (the `ContentOverride` key) — not the file id |
| `profileId` | Active profile at mint time (falls back to the active profile when absent, e.g. `mapChannel`) |
| `hideable` | `false` when `itemId` is an unverified fallback — recorded, never auto-hidden |
| `resolve` | `{id, series, cmd}` needed to re-resolve the link for the admin **Test** action. Server-side only (cmd can embed upstream credentials) |
| `attemptId` | Set automatically by `mintStreamToken` to the top-level token's own id when `itemId` is present; inherited by every child token |

Producers:
- `/api/v2/movie-link` — accepts new optional query params **`itemId`** and **`itemType`** (`movie`/`episode`). Without them (older TV clients): `itemId = id` (file id), `itemType` from `series`, and `hideable` only if the id is a movie in the in-memory catalog (`catalogUnion.catalogItem`, i.e. verifiably a movie list id).
- `mapChannel` (`stalkerV2/shared.ts`) — `itemType:"live"`, `itemId: channel.id`.
- `/api/v2/channel-link` — `itemType:"live"` only when the client sends `id`; the cmd is never used as an itemId (it can hold credentials).

Child tokens (sub-playlists, segments, the `/api/proxy` → `/live.m3u8` hand-off, `/player` segments) use **`inheritTokenMeta(entry)`** so they keep the identity and `attemptId`. Never pass a whole entry as meta ([[skill-stream-tokens]] Lessons #1).

---

## Attempt counting & the 3 strikes (`src/services/StreamFailures.ts`)

- **One attempt = one top-level token** (one `movie-link` call). ExoPlayer/hls.js retries of the same URL, and failures on any segment of that playback, share the `attemptId` → count once. `attemptTokens` keeps the last 10 attempt ids in the window.
- **Live** tokens come from the channel list and are reused for every play, so live attempts are bucketed per 10 minutes (`<token>@<bucket>`).
- **Window**: 24 h. If `lastFailedAt` is older than that, the count/attempts reset before counting the new one.
- **Threshold**: a `movie` with `hideable` reaching **3** attempts → `ContentOverride.hidden = true` for `movie_<parseInt(itemId)>` (same key `applyPortalItemOverrides` uses), `autoHidden = true`, and the `movies_%` `ContentCache` rows for that profile are deleted so list pages refresh immediately. **Episodes and live: record only.**
- **Manual hides are never marked**: if the override is already `hidden`, the row is not flagged `autoHidden`, so **Unhide** can never undo an admin's manual decision. `autoHidden` on the row *is* the marker (no new ContentOverride column).
- **Success** (`recordSuccess`): only when bytes actually flow — a `/api/proxy`/`/api/proxy/stream` byte stream with status < 400, or a `/player` segment served. A playlist loading is **not** success (a playlist can be fine while every segment 404s — counting it would reset the strikes on every attempt). `/live.m3u8` playlist success counts for `live` only. Success resets `failureCount` unless `autoHidden`.
- **Hot-path cost**: an in-memory `healthy` map (attemptKey → expiry: 6 h VOD, 10 min live) short-circuits every request after the first success, so the DB is touched at most once per attempt. A failure on an already-healthy VOD attempt is ignored (transient mid-play error, not a strike).
- All DB work is serialized per item (in-process promise chain) and fire-and-forget — it never delays or breaks the stream response. Rows are created with find-then-create, not `findOrCreate` (which wraps a transaction and held SQLite's single write lock long enough to hit `SQLITE_BUSY` in testing).

Hooks: `proxy.ts` (`handleProxyStream` status, `/api/proxy` playlist non-2xx, both catch blocks), `live.ts` (`/live.m3u8` wraps `serveLivePlaylist` and records any ≥ 400 response; `/player` segment successes).

---

## `StreamFailure` model (`stream_failures`)

`id, profileId, itemType, itemId, title, category, failureCount, attemptTokens (JSON), lastStatus, lastError, upstreamHost, resolveParams (JSON, never returned), hideable, firstFailedAt, lastFailedAt, autoHidden, autoHiddenAt, dismissed`, unique on `(profileId, itemType, itemId)`. Created by the plain `sync()` loop (new table). Any later column needs a manual `ALTER TABLE` in `initDB()` ([[skill-database]]).

- `upstreamHost` is the **host only** — never store/return the full URL (can carry credentials). `lastError` passes through `sanitizeError()` (URLs replaced with `<url>`, 300 chars).
- `ContentOverride` is not profile-scoped (pre-existing), so an auto-hide applies to that item key on every profile.
- Discover ([[skill-discover]]) does not apply `ContentOverride.hidden` at all (pre-existing) — an auto-hidden movie can still surface there.

---

## Admin API (`src/routes/streaming/streamFailures.ts`, admin-only)

| Method | Path | Behaviour |
|--------|------|-----------|
| `GET` | `/api/admin/stream-failures?status=active\|hidden\|all` | `{status, items}`, newest `lastFailedAt` first, max 500. `active` = not dismissed, not auto-hidden, `failureCount > 0`; `hidden` = `autoHidden` |
| `POST` | `/api/admin/stream-failures/{id}/test` | Re-resolves via the same provider call movie-link/channel-link uses, GETs the first 4 KB (follows up to 2 HLS levels so a dead segment fails), returns `{ok, status, error, item}`. OK → count reset (stays hidden until Unhide). Refuses if the row's profile isn't active |
| `POST` | `/api/admin/stream-failures/{id}/unhide` | Only when `autoHidden` (else 409). Removes the override (or just clears `hidden` if it also carries a rename/move/sort), resets the count, invalidates movie list cache |
| `DELETE` | `/api/admin/stream-failures/{id}` | `dismissed = true` + count reset; a new failed attempt re-opens it |

Cleanup: `runDbCleanup` (`src/server.ts`) deletes non-`autoHidden` rows with `updatedAt` older than 30 days (`purgeStaleFailures`).

---

## Client contract (web UI / TV)

Send `itemId` (the list item's `id` — for movies the card id used as `movieId`) and `itemType` (`movie` or `episode`) on `/api/v2/movie-link`; send `id` on `/api/v2/channel-link`. All optional — older clients keep working with the fallbacks above. The web UI sends them from `resolveStreamUrl` (portalcast-webui).

---

## Key Files

- `src/services/StreamFailures.ts` — record/threshold/auto-hide/test/unhide/dismiss/purge
- `src/models/StreamFailure.ts`
- `src/routes/streaming/streamFailures.ts` — admin API
- `src/services/StreamTokens.ts` — `StreamTokenMeta`, `inheritTokenMeta`, `attemptId`
- `src/routes/streaming/proxy.ts`, `src/routes/streaming/live.ts` — hooks
- `src/routes/stalkerV2/movies.ts` (movie-link), `shared.ts` (mapChannel), `channels.ts` (channel-link) — producers
