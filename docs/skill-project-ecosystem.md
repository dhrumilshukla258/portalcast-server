# Project ecosystem

**This repo:** `portalcast-server` — the backend. Node/TypeScript, Hapi,
Sequelize/SQLite. Exposes two parallel API surfaces: `/api/v2/*`
(`src/routes/stalkerV2/`) for full-featured clients, and an Xtream Codes API
emulation (`src/routes/xtream/`) for Xtream-compatible player shells / the
Android TV app.

**How it interacts with sibling projects:**
- `portalcast-webui` (React/Vite web app) talks to `/api/v2/*`. Its built
  output is committed into this repo's `public/` folder — not built by this
  repo's own Docker build, so `public/` must be manually rebuilt+copied (or
  via `portalcast-webui/deploy.sh`) whenever webui source changes.
- `portalcast-tv-android` (Kotlin/Compose-for-TV) talks to this server via
  the Xtream Codes API emulation, not `/api/v2/*`.

See `../../docs/project_ecosystem.md` (shared across all portalcast-* repos)
for the full multi-repo product ecosystem, planned future clients, and
cross-cutting design decisions.
