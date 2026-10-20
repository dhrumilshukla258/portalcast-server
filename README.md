<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/brand/portalcast-logo.svg">
    <img src="docs/brand/portalcast-logo-on-light.svg" alt="PortalCast" width="320">
  </picture>
</p>

<p align="center"><b>PortalCast Server</b> turns a Stalker portal or Xtream Codes account into a clean, private catalog for your own web and TV apps.</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-20-339933?style=flat-square&logo=nodedotjs&logoColor=white" alt="Node.js 20">
  <img src="https://img.shields.io/badge/TypeScript-7-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript 7">
  <img src="https://img.shields.io/badge/Docker-ready-2496ED?style=flat-square&logo=docker&logoColor=white" alt="Docker">
  <img src="https://img.shields.io/badge/license-MIT-22C55E?style=flat-square" alt="MIT">
</p>

<p align="center">
  <b>Server</b> ·
  <a href="https://github.com/dhrumilshukla258/portalcast-webui">Web app</a> ·
  <a href="https://github.com/dhrumilshukla258/portalcast-tv-android">Android TV app</a>
</p>

---

## What it does

The server signs in to your provider, keeps its catalog cached, and serves it through one API (`/api/v2/*`) to the [PortalCast web app](https://github.com/dhrumilshukla258/portalcast-webui) (bundled in `public/`) and the [Android TV app](https://github.com/dhrumilshukla258/portalcast-tv-android). Clients never see the provider: every stream, image and link goes through the server.

## Features

- **Discover** — one card per title across all its language and quality versions, a TMDB-enriched catalog with genre, language, country, channel/platform and mood filters, "Because you watched" recommendations, descriptions, cast and backdrops.
- **Clean titles** — channel and platform prefixes ("Zee5 : …", "HUM TV : …"), quality and language tags come off names and show as badges; TMDB is matched by title and year, never on a guess.
- **Series done properly** — TMDB episode stills, titles, descriptions and runtimes; air dates read out of episode names.
- **Live TV** with EPG, catch-up, favourites and recent channels synced across devices.
- **Subtitles** — OpenSubtitles and SubDL search merged, embedded tracks from video files, per-user accounts and API keys.
- **Measured quality** — players report the real resolution and frame rate, so a mislabelled "CAM" title shows its true quality.
- **Admin dashboard** — live viewers, users and approvals, content manager (rename, hide, move, virtual categories), broken streams, security log, server logs.
- **Fast** — in-memory indexes for Discover, search and category lists; responses in milliseconds on catalogs of 100k+ titles.

## Security

- Provider credentials and addresses never reach a client: streams are opaque, short-lived tokens relayed by the server, upstream links are sealed, artwork goes through a signed image proxy.
- Sign-in through the server's own accounts (email/password, Google, TV pairing code); refresh tokens rotate, and a replayed token revokes the session.
- Suspicious requests are logged under **Admin › Security** and repeat offenders are banned automatically.
- Uploads and relayed files are checked by their content, not their extension.

## Get started

**Docker**

```bash
cp portalcast-server.yml docker-compose.yml   # set JWT_SECRET, ADMIN_EMAIL, ADMIN_PASSWORD
docker compose up -d
```

**Without Docker** — each [release](https://github.com/dhrumilshukla258/portalcast-server/releases) ships native packages with Node.js included: `.deb` (Debian/Ubuntu/Raspberry Pi, systemd service), `.exe` (Windows, runs at boot) and `.dmg` (macOS). The first start writes the admin sign-in to `FIRST-RUN.txt` next to the config file.

Then open `http://<server>:3000`, sign in as admin, and add your provider under **Admin › Profiles** (Stalker portal or Xtream Codes). Profiles switch without a restart.

## Configuration

| Variable | Purpose |
|---|---|
| `JWT_SECRET` | **Required.** Signing key for sessions |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | **Required.** The admin account |
| `TMDB_API_READ_TOKEN` | TMDB metadata, artwork and episode data |
| `OPENSUBTITLES_API_KEY`, `SUBDL_API_KEY` | Online subtitle search |
| `GOOGLE_CLIENT_ID` | Google sign-in |
| `TRUSTED_PROXIES` | Set to `private` behind a reverse proxy, so bans and rate limits see real addresses |
| `PORT` | Listen port (default `3000`) |

Every variable, with defaults: [docs/features.md](docs/features.md#environment-variables). Behind Caddy, nginx or Traefik the server builds every URL from the forwarded headers, so a LAN address and an HTTPS domain work side by side.

## Docs

- [docs/features.md](docs/features.md) — full feature and API reference
- `docs/skill-*.md` — one page per subsystem (Discover, stream tokens, subtitles, auth, database, providers, …)

## Disclaimer

PortalCast is software only. It does not provide, host or distribute any content; you connect it to a provider you are entitled to use.

## License

MIT — see [LICENSE](LICENSE).
