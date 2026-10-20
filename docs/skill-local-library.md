# Local library (NAS movies) — Skill Reference

Movies from folders on the NAS, scanned, matched to TMDB and served byte for byte (no transcoding) next to IPTV. Phase 1 of the local-library plan, built 2026-10-20: movies only; series, NAS image storage and the browser fallback come in later phases.

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

## How the apps see it

No app change is needed to browse and play:

| Request | Local answer |
|---|---|
| `GET /api/v2/movie-groups` | `{ id: "local", title: "My Library" }` first, when there is at least one local movie |
| `GET /api/v2/movies?category=local&page=` | Pages of local titles, ids `L<itemId>`, IPTV item shape plus `is_local: 1`, `quality` |
| `GET /api/v2/movies?movieId=L<id>` | The title's files, ids `LF<fileId>`, best first, with `variantLabel` ("4K · HDR10"), `audio_tracks`, `subtitle_tracks` |
| `GET /api/v2/movie-link?id=LF<id>` | `{ js: { cmd: "/api/local/stream?t=<token>" } }` |

Discover cards for a local representative open with category `local`, which takes the same path.

## Streaming

`/api/local/stream?t=`: the stream token's resource is `local:<fileId>`; the path never leaves the server. Range requests give 206 with `Content-Range`; HEAD works. Each request counts as "now watching" (`streamTracker`), so background jobs yield. Tokens are network-pinned like every stream token. `/api/local/subtitle?t=&s=<index>` serves a sidecar subtitle as WebVTT (SRT directly, ASS/SSA through FFmpeg). Embedded tracks use `/api/media/info` and `/api/media/subtitle`, which accept local files' tokens.

## TV app

ExoPlayer plays MKV/MP4 directly. Audio the TV cannot decode (DTS, TrueHD) falls back to FFmpeg (`org.jellyfin.media3:media3-ffmpeg-decoder`, extension renderer mode ON: the TV's decoders and passthrough first). The player's Up panel lists audio tracks when there are several.

## Not yet (later phases)

Series and episodes; local titles in the global Search; per-title progress across versions; images and NFO files stored on the NAS; "Local" badges; the browser fallback for audio the browser cannot play (MKV with AC3/DTS).
