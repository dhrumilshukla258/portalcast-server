<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/brand/portalcast-logo.svg">
    <img src="docs/brand/portalcast-logo-on-light.svg" alt="PortalCast" width="320">
  </picture>
</p>

<p align="center"><b>PortalCast Server</b> turns the IPTV subscription you already have into one clean, private app for the whole house, and runs beside your Jellyfin so your own films and shows join it.</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-20-339933?style=flat-square&logo=nodedotjs&logoColor=white" alt="Node.js 20">
  <img src="https://img.shields.io/badge/TypeScript-7-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript 7">
  <img src="https://img.shields.io/badge/Docker-ready-2496ED?style=flat-square&logo=docker&logoColor=white" alt="Docker">
  <img src="https://img.shields.io/badge/license-MIT-22C55E?style=flat-square" alt="MIT">
</p>

<p align="center">
  <a href="https://portalcast.stream">Website</a> ·
  <a href="https://github.com/dhrumilshukla258/portalcast-server/releases/latest">Download</a> ·
  <b>Server</b> ·
  <a href="https://github.com/dhrumilshukla258/portalcast-webui">Web app</a> ·
  <a href="https://github.com/dhrumilshukla258/portalcast-tv-android">Android TV app</a>
</p>

---

## How it fits

PortalCast runs at home (on a NAS, a Raspberry Pi or any PC), next to Jellyfin if you have one:

- **Your IPTV provider** (a Stalker portal, Xtream Codes or an M3U playlist): PortalCast signs in, keeps the catalog and TV guide cached, cleans up the names and matches every title on TMDB.
- **Your Jellyfin** (optional): Jellyfin keeps doing the scanning, metadata and transcoding. PortalCast reads its movie and show libraries with an API key, the way Jellyseerr sits beside Jellyfin.
- **Your screens**: the [web app](https://github.com/dhrumilshukla258/portalcast-webui) (built into this server), the [Android TV app](https://github.com/dhrumilshukla258/portalcast-tv-android) and the LG TV app show both in one Home, one card per title.

Everything goes through one API (`/api/v2/*`). Apps never see the provider: every stream, image and link is relayed by the server.

## Features

- **Home made for each viewer**: Continue Watching, "Because you watched", top picks, trending and top rated, built per profile from what was watched. One card per title across all its language and quality versions.
- **Works with Jellyfin**: add its address and an API key under **Admin › Settings › Jellyfin**. Its libraries join the catalog: a film you have in both is one card with the IPTV versions and your Jellyfin copy, shown with Jellyfin's own details and artwork, played from Jellyfin, re-read every night. "Sign in with Jellyfin" (off by default) lets people use their Jellyfin login. Without Jellyfin, PortalCast runs on the IPTV alone.
- **Discover and filters**: a TMDB-enriched catalog with genre, language, country, channel/platform and mood filters, plus the provider's own IPTV categories and **My library** (your Jellyfin's films and shows).
- **Live TV** with the guide, catch-up, favourites and recent channels synced across devices.
- **Sports**: the next 30 days of the leagues each viewer chooses, from a free schedule and from your provider's TV guide (cricket, kabaddi, NBA, NHL…), with the channel showing each match.
- **Cast**: actors, actresses, directors, creators and writers with photos, ranked by what each viewer watched; every person's page lists what can be played.
- **Clean titles**: channel and platform prefixes ("Zee5 : …", "HUM TV : …"), quality and language tags come off the names and show as badges. TMDB is matched by title and year, never on a guess.
- **Series done properly**: TMDB episode stills, titles, descriptions and runtimes; air dates read out of episode names.
- **Subtitles**: OpenSubtitles, SubDL and Gestdown search merged with Jellyfin's own, embedded tracks from video files, per-user accounts and API keys. Every file is stored once, and the one viewers kept (with its timing) is listed first next time.
- **Title menu**: hold a title (TV, phone) or right-click it (PC) for My List, Mark as watched or Not interested. My List keeps saved titles, watched ones, hidden ones and favourite channels, each with undo.
- **Measured quality**: players report the real resolution and frame rate, so a mislabelled "CAM" title shows its true quality.
- **Admin dashboard**: a setup guide, live viewers, users and approvals, a content manager (rename, hide, move, virtual categories), broken streams, the security log and server logs.
- **Fast**: in-memory indexes for Discover, search and category lists, an optional in-memory catalog, a TMDB image cache with one stored copy per image, and apps that open on the last Home they saw. Answers come in milliseconds on catalogs of 100k+ titles.

## Apps

| Where | How |
|---|---|
| Browsers, phones, tablets | Built in: open `http://<server>:3000` and add it to the home screen. Runs on browsers from 2018 on |
| Android TV and Google TV | The [Android TV app](https://github.com/dhrumilshukla258/portalcast-tv-android/releases/latest) (APK), signed in with a pairing code |
| LG TVs from 2020 | The `.ipk` on the [web app's latest release](https://github.com/dhrumilshukla258/portalcast-webui/releases/latest), installed with LG's Developer Mode app |
| Samsung TVs | The TV's browser, in TV mode |
| Your own player | "Open in…" hands a title to VLC, Infuse, mpv, MX Player and others |

## Get started

**Docker**: an image for Linux x64 and ARM64 (Raspberry Pi, most NAS) is published on every change: `ghcr.io/dhrumilshukla258/portalcast-server`.

```bash
curl -O https://raw.githubusercontent.com/dhrumilshukla258/portalcast-server/main/docker-compose.example.yml
cp docker-compose.example.yml docker-compose.yml   # edit the lines marked EDIT
docker compose up -d
```

Update: `docker compose pull && docker compose up -d`. `:latest` is the newest build of `main`; a version tag such as `:1.6.1` stays on that release. Keep your `docker-compose.yml` private: it may hold your keys.

To help test the next version before it is released, use `:beta` instead of `:latest` (pre-release packages are on the [releases](https://github.com/dhrumilshukla258/portalcast-server/releases) page, marked *Pre-release*). Beta builds may change the database in ways the current release has not seen yet: back up your data folder first, and switch back to `:latest` once that release is out.

To build the image yourself (for example from your own fork), point the compose file at the repository and run `docker compose build` before `up`:

```yaml
    build:
      context: https://github.com/dhrumilshukla258/portalcast-server.git#main
```

**Without Docker**: the [latest release](https://github.com/dhrumilshukla258/portalcast-server/releases/latest) has installers with Node.js included: `.exe` (Windows, runs at boot), `.dmg` (macOS, Apple silicon and Intel), `.deb` (Debian, Ubuntu, Raspberry Pi OS; x64 and ARM64, a systemd service) and `.tar.gz` / `.zip` for running it by hand. To update, install the newer one over the old one; settings and data stay where they are (Windows `C:\ProgramData\PortalCast`, macOS `~/Library/Application Support/PortalCast`, Linux `/var/lib/portalcast`).

**Then** open `http://<server>:3000` and create the admin account (the first visit does, so do it right after installing). **Admin › Overview** walks you through the rest: your IPTV provider (a Stalker portal, Xtream Codes or an M3U playlist with an optional XMLTV guide; profiles switch without a restart), Jellyfin, TMDB artwork, subtitles, users and the apps.

The first fill of the catalog and TV guide is deliberately slow, so the provider is never flooded: one request at a time with a pause between, and a longer pause whenever the provider answers "too many requests". On a big provider it takes a few hours (progress is in the server log); playback works meanwhile. The pace is **Admin › Settings › Provider tuning › Pause between background portal requests**.

## Security

- Provider credentials and addresses never reach a client: streams are opaque, short-lived tokens relayed by the server, upstream links are sealed, and artwork goes through a signed image proxy.
- Sign-in through the server's own accounts (email/password, Google, TV pairing code, or Jellyfin when switched on); refresh tokens rotate, and a replayed token revokes the session.
- Suspicious requests are logged under **Admin › Security**, and repeat offenders are banned automatically.
- Uploads and relayed files are checked by their content, not their extension.

## Configuration

Almost everything is set in **Admin › Settings**: API keys and connections (TMDB, OMDb, OpenSubtitles, SubDL, Jellyfin), email, sign-in, security limits, network and backups. A value saved there wins over the environment variable of the same name, which still works as the fallback. Secrets are stored encrypted and never shown in full.

Only what the server needs before it starts stays in the compose file:

| Variable | Purpose |
|---|---|
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | Optional. Without them the first visit to the web page creates the admin account; the password stays an emergency way back in |
| `SQLITE_DB_PATH` | Data folder: database, generated key, uploads, backups (Docker: the `/app/data` volume) |
| `PORT`, `TLS_CERT_PATH`, `TLS_KEY_PATH` | Listen port and optional HTTPS |
| `JWT_SECRET` | Optional. Without it the server generates a key once and keeps it in the data folder |

Memory: about 1 GB is enough. With the in-memory catalog (**Admin › Settings › Catalog**, off by default) on a large catalog, give the container about 1.5 GB (`mem_limit: 1536m`, `NODE_OPTIONS=--max-old-space-size=1024`): its copy of a 130k-title catalog is about 200 MB, and a rebuild briefly needs about 450 MB more.

Every variable, with defaults: [docs/features.md](docs/features.md#environment-variables); how settings work: [docs/skill-settings.md](docs/skill-settings.md). Behind Caddy, nginx or Traefik the server builds every URL from the forwarded headers, so a LAN address and an HTTPS domain work side by side; that is also the way to watch away from home (or your own VPN).

## Docs

- [docs/features.md](docs/features.md): the full feature and API reference
- `docs/skill-*.md`: one page per subsystem (Discover, Jellyfin and the library, stream tokens, subtitles, auth, database, providers, …)

## Disclaimer

PortalCast is software only. It does not provide, host or distribute any content; you connect it to a provider you are entitled to use and, if you like, to your own Jellyfin server. PortalCast is not affiliated with Jellyfin.

## License

MIT, see [LICENSE](LICENSE).
