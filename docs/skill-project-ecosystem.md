# Project ecosystem

**This repo:** `portalcast-server` — the backend. Node/TypeScript, Hapi,
Sequelize/SQLite. Exposes one client-facing API surface: `/api/v2/*`
(`src/routes/stalkerV2/`), gated by the server's own login system
(`src/routes/account/auth.ts` — email/password, Google, and the device-code
pairing flow for TVs).

**How it interacts with sibling projects:**
- `portalcast-webui` (React/Vite web app) talks to `/api/v2/*`. Its built
  output is committed into this repo's `public/` folder — not built by this
  repo's own Docker build, so `public/` must be manually rebuilt+copied (or
  via `portalcast-webui/deploy.sh`) whenever webui source changes.
- `portalcast-tv-android` (Kotlin/Compose-for-TV) signs in with the
  device-code pairing flow and uses `/api/v2/*` like the webui. Its field-level
  contract is `portalcast-tv-android/docs/api-contract.md`: change an `/api/v2`
  shape and check it there (and in the webui's `src/api/types`).
- Fields added for both clients on 2026-10-19/20: `network`/`network_logo`,
  `description` on Discover cards, `networks` facet (series), `title_key`/
  `clean_name` on catalog items (Search grouping), TMDB episode data, sealed
  `cmd` values (`sealed:…`, hand back as is — never play), one rating per card
  (`rating_best` + `rating_source`, IMDb first) plus `rt_rating`/`metascore` on Discover cards, creators in `director` for series ("Created by").

See `../../docs/project_ecosystem.md` (shared across all portalcast-* repos)
for the full multi-repo product ecosystem, planned future clients, and
cross-cutting design decisions.

## Changes that affect sibling repos

- 2026-10-18: the third-party-player compatibility layer was removed from
  this server — Xtream Codes API emulation (`src/routes/xtream/`), M3U/XMLTV
  playlist export, `/api/vod/play`, Jellyfin `.strm` generation and VOD
  category versioning. Third-party IPTV players (TiviMate, Smarters,
  Jellyfin) are no longer supported; every client must log in through the
  server's own user system and use `/api/v2/*`. The admin stats response
  dropped its `strm` block, and the `xtream:{username}` stream-session label
  no longer occurs.
