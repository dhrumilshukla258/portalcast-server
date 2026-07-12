<p align="center">
  <img src="public/portalcast-logo.svg" alt="Portalcast Logo" width="200" />
</p>

<h1 align="center">Portalcast</h1>

<p align="center">
  A Node.js middleware that bridges Stalker portals and Xtream Codes sources to any IPTV player — with a full content management layer and Jellyfin integration.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-20-green?style=for-the-badge&logo=nodedotjs" />
  <img src="https://img.shields.io/badge/Docker-Enabled-blue?style=for-the-badge&logo=docker" />
  <img src="https://img.shields.io/badge/TypeScript-5-blue?style=for-the-badge&logo=typescript" />
  <img src="https://img.shields.io/badge/License-MIT-green?style=for-the-badge" />
</p>

---

## What it does

Connects to a **Stalker portal** or **Xtream Codes API** and re-serves the content in formats your players actually understand — Xtream Codes API, M3U playlists, and XMLTV EPG. On top of raw passthrough it adds a full content management layer, Jellyfin/.strm integration, and several quality-of-life features.

**Core features at a glance:**

- **Dual provider support** — Stalker STB portals and Xtream Codes APIs both supported, configured entirely through the web UI (`/api/profiles`), switchable without restart
- **Mixed-portal series detection** — portals that list series as VOD items with an `is_series`-style flag (configurable via `SERIES_FLAG`), and portals with a genuinely separate series endpoint, are both auto-detected and handled correctly (`portal_series_source` cache row records which kind each portal is)
- **Xtream Codes API** — full protocol emulation (live, VOD, series, EPG, XMLTV)
- **M3U + EPG** — standard playlist and XMLTV endpoints
- **Opaque stream tokens** — every stream URL (`?t=...`) is a random server-side token, never the real upstream address. Nothing a user can copy or inspect ever reveals the portal URL, upstream credentials, or lets an unauthenticated request stream through the server
- **Admin Dashboard** — user stats, live "who's watching what right now" (type, title, category, user, IP, duration), STRM generation trigger — see `/admin` in the web UI
- **Content Manager** — browser UI to rename, hide, move, and reorder content without touching the portal — available both standalone (`/contentmanager`) and as a tab inside the Admin Dashboard
- **Virtual categories** — create custom groupings; move items in from any portal category
- **Cache warming** — incremental background fetching so players always see fresh content
- **VOD category versioning** — tricks free IPTV players into re-fetching updated categories on force-refresh
- **Jellyfin / Emby** — generates `.strm` files with automatic duplicate merging, variant tag detection, orphan pruning, and rename handling
- **TMDB metadata** — optional poster/backdrop enrichment for VOD and series
- **Profiles** — multiple portal accounts, switchable without restart
- **Portal type auto-detection** — handles both mixed VOD+series portals (`SERIES_FLAG`-based split) and portals with a native, separate series endpoint automatically; detected once and cached (`portal_series_source`)
- **Reverse-proxy friendly** — all generated URLs honor `X-Forwarded-Proto`/`X-Forwarded-Host`, so the same server works via LAN `ip:port` and an HTTPS domain simultaneously (Caddy/nginx/Traefik)
- **Client-aware live playback** — browsers get CORS-safe proxied HLS; Smart TVs (Tizen/WebOS) get direct redirects with zero server load
- **HTTPS / TLS** — optional TLS termination built in

---

## Quick Start

```bash
cp portalcast-server.yml docker-compose.yml
# edit credentials, then:
docker compose up -d
```

Open `http://localhost:3000` to configure your portal.
Log in as admin in the web UI and open `/admin` for the full dashboard (stats, live streams, content manager, users, logs) — or `http://localhost:3000/contentmanager` for the standalone content admin panel.

---

## Provider Setup

Both provider types are configured the same way: through the browser UI at `http://localhost:3000` (profile create/edit form), which writes the full config as JSON into the `ConfigProfile.config` column (`src/models/ConfigProfile.ts`) via `POST/PUT /api/profiles`. **No environment variables are required for either provider** — env vars only supply the *default* values a brand-new profile is pre-filled with (see `src/config/server.ts`), nothing more. Switching or editing a profile calls `serverManager.reloadConfig()` — no restart needed.

### Stalker Portal

Fields available in the profile form (with the env var that seeds the default, if any):

| Field | Env var default | Description |
|-------|------------------|-------------|
| Hostname | `STALKER_HOST` | Portal hostname (e.g. `portal.example.com`) |
| Port | `STALKER_PORT` | Portal port (default `80`) |
| HTTPS | `STALKER_HTTPS` | Connect over HTTPS |
| Context path | `STALKER_PATH` | Default `stalker_portal` |
| MAC address | `STALKER_MAC` | Device MAC for STB emulation |
| STB type | `STALKER_STB` | Default `MAG254` |

### Xtream Codes API

Set provider type to **Xtream** in the profile form, then enter host, username, and password — stored per-profile in the database, no env vars involved at all.

---

## Key Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Listen port |
| `JWT_SECRET` | — | **Required.** JWT signing key — server refuses to start if unset |
| `ADMIN_EMAIL` | — | **Required for admin login.** Email address of the admin account |
| `ADMIN_PASSWORD` | — | **Required for admin login.** Admin password — server returns 503 if unset |
| `STREAM_IDLE_TIMEOUT_MS` | `60000` | How long (ms) a stream can go quiet with no request before it's dropped from the "active streams" admin view. Raise this if players buffer ahead and legitimately go quiet between segment fetches |
| `PUBLIC_BASE_URL` | — | Hard override for all generated URLs (e.g. `https://iptv.example.com`). If unset, URLs are derived per-request from `X-Forwarded-Proto`/`X-Forwarded-Host` (reverse proxy) or the request host — leave unset when the server is reached both via LAN ip:port and a proxied domain |
| `SERIES_FLAG` | `is_series` | Only relevant for **mixed-content portals** — ones that return series and movies from the same VOD endpoint, distinguished by a boolean-ish field. Set this to whatever that field is named on your portal if it isn't `is_series`. Portals with a genuinely separate series endpoint are auto-detected and ignore this entirely — see `docs/skill-stalker-provider.md` / `docs/skill-xtream-provider.md` |
| `VOD_CATEGORY_VERSIONING` | `false` | Set `true` to enable category version suffixes (forces IPTV players to re-fetch updated categories) |
| `STRM_MOVIES_PATH` | — | Output directory for movie `.strm` files |
| `STRM_SERIES_PATH` | — | Output directory for series `.strm` files |
| `STRM_BASE_URL` | — | Base URL in `.strm` files — set to the address Jellyfin uses to reach this server (e.g. `http://192.168.1.100:3000`) |
| `STRM_XTREAM_USERNAME` | `ADMIN_EMAIL`, then `"admin"` | Username embedded in `.strm` file stream URLs |
| `STRM_XTREAM_PASSWORD` | `ADMIN_PASSWORD`, then `"admin"` | Password embedded in `.strm` file stream URLs |
| `TMDB_API_READ_TOKEN` | — | TMDB token for poster/backdrop enrichment |
| `OPENSUBTITLES_API_KEY` | — | Enables online subtitle search/download in the player. Without it, search silently returns 0 results (a startup-adjacent warning is logged the first time a search is attempted) |
| `GOOGLE_CLIENT_ID` | — | Google OAuth client ID (enables Google sign-in) |
| `TLS_CERT_PATH` | — | TLS certificate path (enables HTTPS on the server) |
| `TLS_KEY_PATH` | — | TLS key path |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |

Full variable reference and all features → **[docs/features.md](docs/features.md)**

---

## Authentication

One user store (the `Users` table), reachable through several doors:

**Admin** — log in with `ADMIN_EMAIL` + `ADMIN_PASSWORD` through the normal login, or via the password-only admin login `POST /api/auth/admin` (used by the Content Manager). If `ADMIN_EMAIL` is not set, the server runs in **bootstrap mode**: any email + `ADMIN_PASSWORD` logs in as admin, and a startup warning is printed — set `ADMIN_EMAIL` to lock this down.

**Users** — Email/password or Google OAuth via `/api/auth/*`. New users are pending until an admin approves them. TV apps pair via a device code flow: the TV displays a short code, the user enters it in the web UI, and the TV receives a JWT automatically.

All `/api/` and `/v2/` endpoints require a Bearer JWT in the `Authorization` header unless the path is explicitly exempted (stream proxies, auth endpoints, Xtream player paths). Management endpoints (config, profiles, content manager, user admin) and all write operations additionally require the admin role.

The Xtream Codes API layer (`/player_api.php`, `/live/`, `/movie/`, `/series/`, M3U playlists) authenticates with **per-user credentials**: any active user's email + password (the same account used for web login), or the admin env credentials. There is no shared playlist password.

### Stream URL security

Stream endpoints (`/live.m3u8`, `/api/proxy`, `/player/*`, `/api/vod/play`, etc.) can't require a Bearer header — `<video src>` and IPTV player HTTP clients can't attach custom headers. Instead, every stream URL handed to a client carries a random opaque token (`?t=...`) minted server-side, mapping to the real upstream address *and* the requester's identity. There is nothing to reverse-engineer from a copied link — no embedded credentials, no derivable portal URL. This also powers the Admin Dashboard's live "who's watching what" view.

No exceptions — every stream-adjacent route (including downloads and embedded-subtitle extraction) requires a valid token bound to that exact resource on every request, not just the initial one. The single unauthenticated route left is `/api/images/{slug*}` (poster/logo relay) — restricted to real image paths, no credentials or streams reachable through it.

---

## Connecting Players

### Xtream Codes (TiviMate, IPTV Smarters, iPlayer, etc.)

| Field | Value |
|-------|-------|
| URL | `http://your-server:3000` (or your reverse-proxy domain) |
| Username | Your account email (same as web login) |
| Password | Your account password |

### M3U / EPG

Each of these requires your account credentials as query params (same email/password as web login) — they're validated on every request, not just once:

| | URL |
|---|---|
| Live | `http://your-server:3000/playlist.m3u?username=you@example.com&password=yourpassword` |
| VOD | `http://your-server:3000/vod/playlist.m3u?username=you@example.com&password=yourpassword` |
| EPG | `http://your-server:3000/epg.xml?username=you@example.com&password=yourpassword` |

### Jellyfin / Emby

Set `STRM_MOVIES_PATH` and `STRM_SERIES_PATH` to directories your media server scans. Generation is **manual, not automatic** — trigger it from the Admin Dashboard's Stats tab ("Generate STRM Files") or `POST /api/admin/strm/generate`. It is not run on a schedule or on cache warm; if your content changes regularly, you'll want to trigger it yourself on some cadence (e.g. a cron hitting that endpoint).

---

## Reverse Proxy

Works out of the box behind Caddy, nginx, or Traefik. Every generated URL — the Xtream handshake (`server_info`), M3U playlist entries, TV pairing links — is derived **per request** from `X-Forwarded-Proto`/`X-Forwarded-Host`, falling back to the request host. So `https://iptv.example.com` and `http://192.168.1.x:3010` both work at the same time, each client getting URLs that match how it connected.

- **Caddy**: works with a plain `reverse_proxy` directive — it sets the forwarded headers by default
- **nginx**: add `proxy_set_header X-Forwarded-Proto $scheme;` and `proxy_set_header Host $host;`
- Set `PUBLIC_BASE_URL` only if you want to force one canonical address into every URL

---

For **live** streams the server stays a pure proxy — no server-side transcoding. Clients decode HEVC (or whatever codec the source uses) with their own hardware.

FFmpeg is still required in the container (included in the default Docker image) for embedded-subtitle extraction from progressive video files — see `docs/skill-subtitles.md`.

---

## Disclaimer

Middleware proxy only. Does not host or distribute content. Users are responsible for legal access to their configured portal.

## License

MIT
