# Subtitles — Skill Reference

Two unrelated subtitle features live in this codebase — don't conflate them.

Related: [[skill-stream-tokens]], [[skill-user-system]], [[skill-video-playback]]

---

## 1. Embedded-subtitle extraction (`src/routes/subtitles.ts`)

For **progressive** (non-`.m3u8`) video files only. The web player probes the file with `ffprobe` for subtitle tracks muxed into the container, then extracts a chosen track as WebVTT with `ffmpeg`.

| Endpoint | Description |
|----------|-------------|
| `GET /api/media/info?url=&t=` | `ffprobe` the file, return `{ duration, videoCodec, audio[], subtitles[] }`. Cached 6h (`node-cache`) keyed by the raw URL |
| `GET /api/media/subtitle?url=&track=&t=` | `ffmpeg -map 0:{track} -f webvtt pipe:1`, streamed back as `text/vtt` |

Both require `?t=` — a **stream token** (see [[skill-stream-tokens]]), not a JWT (an `<video>`/`<track>` element can't attach a Bearer header). The token is identity proof only, reused from the active playback session's own token; `url=` stays caller-supplied because `ffprobe`/`ffmpeg` need real bytes to inspect, not a title — nothing about the resource can be pre-tokenized server-side the way stream URLs are.

This code used to live inside the now-deleted `hls.ts` (VOD transcode proxy). When that feature was removed, these two routes were carved out into their own file because the frontend (`VideoContext.tsx`) genuinely depends on them — unlike the transcode-proxy routes, which had zero callers.

**Frontend gating bug (found and fixed after this file was first written)**: `VideoContext.tsx` decided whether to even *call* these routes by extension-sniffing the stream URL (`.endsWith('.mp4')` etc.) — which stopped working once stream URLs became opaque tokens with no real file extension, meaning `isProgressive` was always `false` and these routes were silently never called at all, for any content. Fixed in `stalker-ui` to check for absence of the `&m3u8=1` tag instead — see `stalker-ui/docs/skill-video-playback.md`. Worth knowing if a future "restored" or "unused" backend route turns out to have a client-side gate silently never triggering it — check the *caller's* trigger condition, not just whether the route itself works.

---

## 2. Online subtitle search (OpenSubtitles) — `src/utils/opensubtitles.ts`

| Endpoint | Auth | Description |
|----------|------|-------------|
| `GET /api/v2/subtitles/search?title=&year=&season=&episode=&lang=` | Standard JWT | Searches OpenSubtitles, sorted by download count |
| `GET /api/v2/subtitles/download?fileId=` | Standard JWT | Resolves the temporary download link and proxies the `.srt`, converted to WebVTT |

These are regular `fetch()` calls from an already-authenticated web UI session, so they just ride the normal Bearer-JWT gate — no stream token needed (unlike #1 above, which the player element itself has to hit without a header).

### Two-tier credential model

- **`OPENSUBTITLES_API_KEY`** (env var, required for anything to work) — identifies your app to OpenSubtitles, sent as `Api-Key` header on every request. If unset, `searchSubtitles()` logs a warning and returns `[]` immediately — **search silently returning nothing is the #1 symptom of a missing key**, check the server log for `[OpenSubtitles] OPENSUBTITLES_API_KEY is not set` first.
- **Per-user OpenSubtitles login** (optional, `User.openSubtitlesUsername`/`openSubtitlesPasswordEnc`) — downloads are quota-limited *per OpenSubtitles account*, not per API key: 20/day free tier, up to 1000/day VIP. Without a linked account, every user of your server shares one anonymous pool off the bare API key. Linking lets each app-user draw from their own OpenSubtitles account's quota instead.

### Linking flow

1. `PUT /api/user/opensubtitles { username, password }` (`src/routes/user.ts`) — attempts `POST /login` against OpenSubtitles immediately to verify the credentials work *before* storing anything (an unusable linked account would be worse than none — downloads would silently keep falling back to the shared pool with no indication why).
2. On success, the password is encrypted with `encryptSecret()` (`src/utils/crypto.ts`, AES-256-GCM, key derived from `JWT_SECRET` via SHA-256 — no second required env var) and stored in `User.openSubtitlesPasswordEnc`. **Must be reversible, not hashed** — OpenSubtitles has no refresh-token flow, only re-login with the original password when the 24h JWT expires.
3. `GET /api/user/opensubtitles` returns `{ linked, username }` only — the encrypted password is never returned to the client.
4. `DELETE /api/user/opensubtitles` clears both fields.

### Session caching

`getUserSession(appUserId)` in `opensubtitles.ts` caches each linked user's OpenSubtitles JWT in an in-memory `Map<userId, OSSession>`, refreshed a little before OpenSubtitles' real 24h expiry (`SESSION_TTL_MS = 23h`). On a 401 from `/download` (session rejected early), the cache entry is dropped and the download is retried once anonymously (shared key) rather than failing outright — a linked-account hiccup shouldn't break downloads entirely.

`resolveSubtitleDownloadUrl(fileId, appUserId?)` — `appUserId` is optional; omit it (or pass a user with no linked account) to fall back to the shared anonymous pool. The `/api/v2/subtitles/download` handler always passes `authCheck(request)?.userId` through.

### Frontend

`stalker-ui/src/components/molecules/OpenSubtitlesModal.tsx` — link/unlink UI, opened from the "Subtitle Account" item in `Header.tsx`'s user dropdown. Calls `GET/PUT/DELETE /api/user/opensubtitles` via the standard authenticated `api` client — no other frontend change needed, since the backend resolves which credential set to use per-request based on the JWT identity already attached to every `/api/v2/subtitles/download` call.

---

## Key Files

- `src/routes/subtitles.ts` — embedded-subtitle probe/extract (token-gated)
- `src/utils/opensubtitles.ts` — OpenSubtitles search, login, per-user session cache, download resolution
- `src/utils/crypto.ts` — reversible `encryptSecret`/`decryptSecret` (AES-256-GCM, key derived from `JWT_SECRET`)
- `src/models/User.ts` — `openSubtitlesUsername`, `openSubtitlesPasswordEnc`
- `src/routes/user.ts` — `/api/user/opensubtitles` link/unlink/status
- `src/routes/stalkerV2.ts` — `/api/v2/subtitles/search`, `/api/v2/subtitles/download`
- `stalker-ui/src/components/molecules/OpenSubtitlesModal.tsx` — link/unlink UI
