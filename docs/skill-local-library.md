# Local library (NAS movies and series) — Skill Reference

Movies and series from folders on the NAS, scanned, matched to TMDB and served byte for byte (no transcoding) next to IPTV. Phases 1 and 2 of the local-library plan, built 2026-10-20 and 21. NAS image storage and the browser fallback come in later phases.

Related: [[skill-settings]], [[skill-titles-and-tmdb]], [[skill-stream-tokens]], [[skill-discover]]

## Files

| File | What it does |
|---|---|
| `src/models/Library.ts`, `LocalItem.ts`, `MediaFile.ts` | A library (folders), a title (folder or lone file), a file (version) with its probe result |
| `src/content/library/naming.ts` | Jellyfin naming: `Name (Year) [tmdbid-123]`, versions `Name (Year) - 2160p.mkv`, sidecar subtitles `Name.en.forced.srt`, NFO ids, extras |
| `src/content/library/probe.ts` | ffprobe: duration, size, HDR, codecs, audio and subtitle tracks |
| `src/content/library/scanner.ts` | The scan, matching, missing files, "Fix match" |
| `src/content/library/catalog.ts` | Local titles through the existing movie endpoints |
| `src/routes/library/stream.ts` | `/api/local/stream` (range requests) and `/api/local/subtitle` (sidecar subtitles) |
| `src/routes/library/admin.ts` | `/api/admin/libraries*`: CRUD, folder browser, scan, titles, TMDB search, fix match |

## Mounts and roots

The NAS is mounted read-only into the container (for example `/srv/mergerfs/datapool:/media:ro`). The `mediaRoots` setting (default `/media`) lists the folders libraries may use; the admin folder browser shows only directories under them, and a library folder outside them is refused (paths are resolved with `realpath`, so a symlink cannot escape).

## The scan

`scanLibraries(id?)`: run on library creation, from **Admin › Libraries › Scan**, and nightly at 03:00 by the job runner (waits while someone watches).

1. Walk each folder (depth 6). A folder whose videos share its name is one title with versions; otherwise each video is its own title. Extras folders (`Featurettes`, `Trailers`, ...) and files (`trailer.mp4`, `-sample`) are skipped. `movie.nfo` / `<file>.nfo` give the title, year, TMDB or IMDb id.
2. A file is probed only when it is new or its size or modified time changed. Between files the scan waits while someone is watching.
3. A title is matched when new, renamed, or unmatched (retried at most daily): the pinned "Fix match" id, else the id from the folder name or NFO (an IMDb id is looked up on TMDB), else a TMDB search with the parsed name and year. `enrichLocalTitle()` (`content/metaEnrichment.ts`) stores it as `content_meta` `movie_L<itemId>` with `portalCategoryId = "local"`, so it groups with IPTV versions of the same title (same `groupKey`), and `recomputeRepresentatives()` prefers a matched local version as the card.
4. Files not seen get `missingSince`; titles missing for 7 days are removed with their catalog row (watch progress is kept). A library folder that is missing or empty while it had files is skipped for that scan, so an offline disk never empties the library.

## Series libraries

A library of kind `series`: each top-level folder is a show (`tvshow.nfo` for ids). Episodes are found anywhere inside it: `S01E02`, `S01E02E03` (multi-episode), `1x02`, or `E05` / `05 - Title` inside a season folder (`Season 05`, `Staffel 5`, ...); `Specials` is season 0. Files with no episode number outside a season folder are left out. Episode titles come from the file name, or from TMDB season data when the show is matched. The catalog row is `series_L<itemId>`.

## How the apps see it

No app change is needed to browse and play:

| Request | Local answer |
|---|---|
| `GET /api/v2/movie-groups` | `{ id: "local", title: "My Library" }` first, when there is at least one local movie |
| `GET /api/v2/movies?category=local&page=` | Pages of local titles, ids `L<itemId>`, IPTV item shape plus `is_local: 1`, `quality` |
| `GET /api/v2/movies?movieId=L<id>` | The title's files, ids `LF<fileId>`, best first, with `variantLabel` ("4K · HDR10"), `audio_tracks`, `subtitle_tracks` |
| `GET /api/v2/movie-link?id=LF<id>` | `{ js: { cmd: "/api/local/stream?t=<token>" } }` |

Series, the same way:

| Request | Local answer |
|---|---|
| `GET /api/v2/series-groups` | "My Library" first, when there is a local show |
| `GET /api/v2/series?category=local` | Shows, `series_id` `L<itemId>`, `is_series: 1`, `is_local: 1` |
| `GET /api/v2/series?movieId=L<id>` | Seasons `L<id>S<n>` (`number`, `season_number`, `is_season`), Specials last |
| `GET /api/v2/series?movieId=L<id>&seasonId=L<id>S<n>` | Episodes. An episode's `id` is its file id `LF<n>` (with `episode_num`, `series_number` = season), so progress, resume and "next episode" work unchanged. Two copies of one episode: the larger picture is listed |
| `GET /api/v2/movies?movieId=L<id>&episodeId=LF<n>` | That one file (the apps' "resolve the episode file" call) |

Discover cards for a local representative open with category `local`, which takes the same path. Global search (`movies`/`series` with `category=*&search=`) lists local matches first. List items and Discover cards carry `is_local: 1` (and `quality`); both apps draw a **Local** badge (**Local · 4K** when the best file is 4K).

## NFO files as a metadata source

`src/content/library/nfo.ts` reads Kodi/Jellyfin NFO files fully (title, plot, tagline, ids incl. `imdb_id`/`uniqueid`, rating, age rating, runtime, premiered, genres, countries, studios, directors, writers, actors with roles, collection, `lockdata`). The scan stores a title's NFO on the `LocalItem` (`nfo`) and an episode's on its `MediaFile` (`nfo`, plus `thumb`: Jellyfin's `metadata/<file>.jpg` or Kodi's `<file>-thumb.jpg`). After every match `applyNfoMeta()` fills what TMDB did not give (description, cast, crew, genres, countries, IMDb id, the detail fields, people); a locked NFO (your edits in Jellyfin) wins over TMDB. Episodes use their NFO title (file names like `show.s01e01.720p.web.dl` carry none), plot, air date and rating, and their own thumbnail, which TMDB stills never replace (`local_still`). Measured on the owner's library (2026-10-21): 392 of 393 movies have an NFO, 379 with a TMDB id; every episode has one.

## Folder artwork

`src/content/library/art.ts`: artwork beside a title (Jellyfin's names: `folder.jpg`/`poster.jpg`, `backdrop.jpg`/`fanart.jpg`, `logo.png`/`clearlogo.png`) wins over TMDB's for that title. The scanner records it on the `LocalItem` (`art`) and, after every match, points the catalog row's `poster`/`backdrop` at a marker `local-art:<itemId>:<kind>:<version>`. Every image that goes out turns the marker into a signed absolute URL, `/api/images/local?a=<itemId>.<kind>.<version>&s=<sig>` (`proxiedImageUrl`, Discover, `withArtUrls` on local items): signed so the ids cannot be walked, absolute because both apps prefix relative image paths, versioned by the file's mtime so a replaced image is a new URL (served with a one-year cache). `proxiedImageUrl` also rebases this server's own signed `/api/images/...` URLs (saved in watch progress) instead of relaying them through the image proxy.

## Streaming

`/api/local/stream?t=`: the stream token's resource is `local:<fileId>`; the path never leaves the server. Range requests give 206 with `Content-Range`; HEAD works. Each request counts as "now watching" (`streamTracker`), so background jobs yield. Tokens are network-pinned like every stream token. `/api/local/subtitle?t=&s=<index>` serves a sidecar subtitle as WebVTT (SRT directly, ASS/SSA through FFmpeg). Embedded tracks use `/api/media/info` and `/api/media/subtitle`, which accept local files' tokens.

## TV app

ExoPlayer plays MKV/MP4 directly. Audio the TV cannot decode (DTS, TrueHD) falls back to FFmpeg (`org.jellyfin.media3:media3-ffmpeg-decoder`, extension renderer mode ON: the TV's decoders and passthrough first). The player's Up panel lists audio tracks when there are several.

## Not yet (later phases)

Per-title progress across versions (resume an IPTV start from the NAS copy); TMDB artwork cached on the NAS, custom uploads and NFO writing (folder artwork is already used); the browser fallback for audio the browser cannot play (MKV with AC3/DTS).
