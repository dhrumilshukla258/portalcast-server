<p align="center">
  <img src="public/portalcast-logo.svg" alt="Portalcast Logo" width="200" />
</p>

<h1 align="center">Portalcast</h1>

<p align="center">
  A Node.js middleware that bridges Stalker portals and Xtream Codes sources to its own web and TV apps — with a full content management layer.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-20-green?style=for-the-badge&logo=nodedotjs" />
  <img src="https://img.shields.io/badge/Docker-Enabled-blue?style=for-the-badge&logo=docker" />
  <img src="https://img.shields.io/badge/TypeScript-5-blue?style=for-the-badge&logo=typescript" />
  <img src="https://img.shields.io/badge/License-MIT-green?style=for-the-badge" />
</p>

---

## What it does

Connects to a **Stalker portal** or **Xtream Codes API** and re-serves the content through its own JSON API (`/api/v2/*`) to the bundled web UI and the Portalcast TV apps. On top of raw passthrough it adds a full content management layer, TMDB-enriched Discover browsing, and several quality-of-life features.

Third-party IPTV players are **not** supported: the Xtream Codes API emulation, M3U/XMLTV playlist export and Jellyfin `.strm` generation were removed on 2026-10-18. Every client logs in through the server's own user system.

**Core features at a glance:**

- **Dual provider support** — Stalker STB portals and Xtream Codes APIs both supported, configured entirely through the web UI (`/api/profiles`), switchable without restart
- **Mixed-portal series detection** — portals that list series as VOD items with an `is_series`-style flag (configurable via `SERIES_FLAG`), and portals with a genuinely separate series endpoint, are both auto-detected and handled correctly (`portal_series_source` cache row records which kind each portal is)
- **Discover** — Netflix-style genre/country/language/theme browse plus "Because You Watched" recommendations, built on a TMDB-enriched catalog cache that de-duplicates language/dub variants of the same title into one card — see `docs/skill-discover.md`
- **Opaque stream tokens** — every stream URL (`?t=...`) is a random server-side token, never the real upstream address. Nothing a user can copy or inspect ever reveals the portal URL, upstream credentials, or lets an unauthenticated request stream through the server
- **Admin Dashboard** — user stats, live "who's watching what right now" (type, title, category, user, IP, duration), content-metadata enrichment trigger — see `/admin` in the web UI
- **Content Manager** — browser UI to rename, hide, move, and reorder content without touching the portal — available both standalone (`/contentmanager`) and as a tab inside the Admin Dashboard
- **Virtual categories** — create custom groupings; move items in from any portal category
- **Cache warming** — incremental background fetching so players always see fresh content, plus an automatic rotating sweep that detects and cleans up content the portal has since removed (metadata, Discover tags, and any orphaned Continue Watching entry) — see `docs/skill-content-lifecycle.md`
- **Real-time multi-device sync** — favorites, recent channels, and last-selected category/TV channel sync instantly across every device a user is logged into via Socket.IO, not just on next login
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

### Install without Docker

Each [GitHub Release](https://github.com/dhrumilshukla258/portalcast-server/releases) has native packages with Node.js bundled — nothing else to install:

| Platform | File | Runs as |
|---|---|---|
| Debian / Ubuntu / Raspberry Pi OS (x64, arm64) | `portalcast-server_<version>_<arch>.deb` | systemd service `portalcast` |
| Windows 10/11 (x64) | `portalcast-server-<version>-windows-x64-setup.exe` | startup task, runs at boot |
| macOS (Apple silicon, Intel) | `portalcast-server-<version>-macos-<arch>.dmg` | login agent, opens the browser |
| Any of the above, portable | `.tar.gz` / `.zip` | run `node/bin/node launcher.js` |

The first start creates the config file with a random JWT secret and admin password and writes the sign-in details to `FIRST-RUN.txt` next to it:

- Linux: `/etc/portalcast/portalcast.env` (data in `/var/lib/portalcast`); `sudo systemctl restart portalcast` after edits
- Windows: `C:\ProgramData\PortalCast\portalcast.env`
- macOS: `~/Library/Application Support/PortalCast/portalcast.env`

Optional: install `ffmpeg` for HEVC live / VOD transcoding. Packages are built by
`.github/workflows/release.yml` on every `v*` tag (see `packaging/`).

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
| `ADMIN_EMAIL` | — | **Required for admin login.** Email address of the admin account. If unset (and `ADMIN_EMAILS` is also unset), the server runs in bootstrap mode — logged at startup, refused entirely in production |
| `ADMIN_EMAILS` | — | Comma-separated list of additional admin emails (alternative/addition to `ADMIN_EMAIL`) |
| `ADMIN_PASSWORD` | — | **Required for admin login.** Admin password — server returns 503 if unset |
| `STREAM_IDLE_TIMEOUT_MS` | `60000` | How long (ms) a stream can go quiet with no request before it's dropped from the "active streams" admin view. Raise this if players buffer ahead and legitimately go quiet between segment fetches |
| `PUBLIC_BASE_URL` | — | Hard override for all generated URLs (e.g. `https://iptv.example.com`). If unset, URLs are derived per-request from `X-Forwarded-Proto`/`X-Forwarded-Host` (reverse proxy) or the request host — leave unset when the server is reached both via LAN ip:port and a proxied domain |
| `SERIES_FLAG` | `is_series` | Only relevant for **mixed-content portals** — ones that return series and movies from the same VOD endpoint, distinguished by a boolean-ish field. Set this to whatever that field is named on your portal if it isn't `is_series`. Portals with a genuinely separate series endpoint are auto-detected and ignore this entirely — see `docs/skill-stalker-provider.md` / `docs/skill-xtream-provider.md` |
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

**Admin** — log in with `ADMIN_EMAIL` (or any address in `ADMIN_EMAILS`) + `ADMIN_PASSWORD` through the normal login, or via the password-only admin login `POST /api/auth/admin` (used by the Content Manager). If neither `ADMIN_EMAIL` nor `ADMIN_EMAILS` is set, the server runs in **bootstrap mode**: any email + `ADMIN_PASSWORD` logs in as admin, and a startup warning is printed (the server refuses to start this way in production) — set `ADMIN_EMAIL` to lock this down.

**Users** — Email/password or Google OAuth via `/api/auth/*`. New users are pending until an admin approves them. TV apps pair via a device code flow: the TV displays a short code, the user enters it in the web UI, and the TV receives a JWT automatically.

All `/api/` and `/v2/` endpoints require a Bearer JWT in the `Authorization` header unless the path is explicitly exempted (stream proxies, auth endpoints). Management endpoints (config, profiles, content manager, user admin) and all write operations additionally require the admin role.

### Stream URL security

Stream endpoints (`/live.m3u8`, `/api/proxy`, `/player/*`, etc.) can't require a Bearer header — `<video src>` can't attach custom headers. Instead, every stream URL handed to a client carries a random opaque token (`?t=...`) minted server-side, mapping to the real upstream address *and* the requester's identity. There is nothing to reverse-engineer from a copied link — no embedded credentials, no derivable portal URL. This also powers the Admin Dashboard's live "who's watching what" view.

No exceptions — every stream-adjacent route (including downloads and embedded-subtitle extraction) requires a valid token bound to that exact resource on every request, not just the initial one. The single unauthenticated route left is `/api/images/{slug*}` (poster/logo relay) — restricted to real image paths, no credentials or streams reachable through it.

---

## Clients

- **Web UI** — the compiled `portalcast-webui` bundle served from `public/` (also packaged as a Samsung Tizen app). Logs in with email/password or Google.
- **TV apps** — pair through the device-code flow (`POST /api/auth/device/code` → enter the code in the web UI) and then use the same `/api/v2/*` API.

Third-party IPTV players (TiviMate, Smarters, Jellyfin and the like) are not supported — the compatibility layer that served them was removed on 2026-10-18.

---

## Reverse Proxy

Works out of the box behind Caddy, nginx, or Traefik. Every generated URL — stream and image proxy URLs, password-reset and TV pairing links — is derived **per request** from `X-Forwarded-Proto`/`X-Forwarded-Host`, falling back to the request host. So `https://iptv.example.com` and `http://192.168.1.x:3010` both work at the same time, each client getting URLs that match how it connected.

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
