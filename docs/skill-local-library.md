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

## Jellyfin (2026-10-28)

The owner's decision: Jellyfin stays the media server, PortalCast reads it. **Settings › Jellyfin** (`jellyfinUrl`, `jellyfinApiKey` secret; env `JELLYFIN_URL`, `JELLYFIN_API_KEY`); **Test connection** calls `GET /api/admin/jellyfin/test`. Saving either setting starts a sync a few seconds later.

| File | What it does |
|---|---|
| `src/content/library/jellyfin.ts` | The client (key in the `Authorization: MediaBrowser Token=` and `X-Emby-Token` headers, never in a URL), Jellyfin data in our shapes (`fileFieldsOf`, `nfoOf`, `artOf`), paths for stream, subtitle, image and HLS, `needsJellyfinTranscode` |
| `src/content/library/jellyfinSync.ts` | `ensureJellyfinLibraries` (each Jellyfin movies/tvshows library becomes a `Library` with `source = "jellyfin"`, `folders = [its Jellyfin id]`; one removed in Jellyfin is switched off), `syncJellyfinLibrary` |

- **Rows**: `LocalItem` root `jellyfin`, relPath = Jellyfin item id; `MediaFile` root `jellyfin`, relPath = `<item id>/<media source id>`, `remotePath` = the path Jellyfin reports. Tracks, size, resolution, HDR and duration come from Jellyfin's media streams (no ffprobe). TMDB/IMDb ids from `ProviderIds` drive the match, so it merges with IPTV copies by id. **Jellyfin's details and artwork win wherever it has them; TMDB fills only what Jellyfin lacks** (owner 2026-10-28): `applyNfoMeta` treats a Jellyfin title like a locked NFO (`nfoOf` gives the NFO shape). Its cast list and roles are Jellyfin's, each person given TMDB's photo and person page when TMDB's list for the title has the same name. Episodes without a number are left out, as in the folder scan.
- **Ids are kept**: a file is found by its Jellyfin ids, else by `remotePath` (Jellyfin re-created the item), else it **takes over** a folder-library file whose path below its library folder ends Jellyfin's path (longest wins). The title and file keep their ids, so progress, My List and cards stay. A taken-over title's folder files Jellyfin does not have get `missingSince`.
- **While Jellyfin is set up, folder libraries are not scanned** (their titles stay as they are); without it, Jellyfin libraries are not read.
- **Unreachable or empty**: nothing is marked missing (as with an offline disk).
- **Playback**: `/api/local/stream` relays `/Videos/<id>/stream?static=true` with the range passed on. The webui gets `/api/local/jf/master.m3u8?t=` (Jellyfin's H.264/AAC HLS, relayed by `/api/local/jf/part?t=&p=`, every playlist address rewritten to point back here; only relative Jellyfin paths are accepted) when `needsJellyfinTranscode` (video not H.264/VP9/AV1, audio not AAC/MP3/Opus/Vorbis/FLAC, or another container). The TV always gets the file.
- **Subtitles**: embedded tracks by index and external ones (`sidecars` relPath `jf:<index>`) as Jellyfin's `Stream.vtt`; `/api/media/info` answers from the stored tracks.
- **Artwork**: `art` = which images Jellyfin has (`Primary`, `Backdrop`, `Logo`) and a version from their tags; `/api/images/local` relays them (`w` becomes Jellyfin's `maxWidth`). Episode stills: `thumb = "jellyfin"`.
- Admin: a Jellyfin library has no folder editing; "Remove" empties it and switches it off (deleted, the next sync would add it back).
- Test: `test/jellyfin-sync.test.ts` (stand-in Jellyfin through `setJellyfinTransport`).

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

## Progress across versions

`src/content/progressMirror.ts`: `GET /api/user/progress` adds mirror rows so every version of a title (IPTV copies, the NAS file, its `LF` file ids) resumes at the newest position in its group. Mirrors keep the original meta ids, so both apps still show the title once in Continue Watching. Movies mirror fully; a series mirrors its series-level row only (episode ids differ between versions). Nothing is written.

## Offline mode

`src/services/portalHealth.ts` checks the portal every minute (two failures = offline); `GET /api/v2/health/iptv`. Both apps poll it, show "IPTV is offline · your library still plays" and dim IPTV cards; local titles stay bright.

## Image cache

`src/content/imageCache.ts`: every TMDB image URL that goes out becomes `/api/images/tmdb/<size>/<file>`; the server downloads it once into the image cache folder (setting, default `<data>/image-cache`) and serves it with a one-year cache header. Cap setting `imageCacheGb` (default 20, 0 = off); nightly job "Trim the image cache" removes least recently used images.

## Custom images

`src/content/customArt.ts`, `src/routes/admin/titleImages.ts`: an admin picks a TMDB alternative or uploads a poster, backdrop or logo (webui detail page, "Edit images"). Stored in the custom images folder (setting `customArtFolder`, default `<data>/custom-art`) under `<contentId>/`, applied to every version of the title, locked in `content_meta.artLocked` so enrichment, folder art, NFO logos and the backdrop backfill never replace it; reset brings the automatic image back. Served by the signed local-art route (`c<contentId>` ids).

## Browser fallback

`src/content/library/remux.ts`: the webui sends `client=web` to `movie-link`; an H.264 file whose audio a browser cannot play (AC3, DTS, TrueHD...) or in an AVI-like container comes back as `/api/local/hls/index.m3u8`. Segments of about 6 s start on the file's own keyframes (read once with ffprobe, stored in `media_files.keyframes`); each segment copies the video and converts only the audio to AAC stereo (measured: 0.17 s per 6 s segment). HEVC files are not remuxed (copying does not help a browser). Setting `browserFallback` (default on). The TV always plays the original file.

## Not built

Writing NFO files: the owner's library already has Jellyfin's NFOs, and nightly database backups cover recovery, so PortalCast reads NFOs but does not write them.

## Artwork sizes (Phase 4, 2026-10-22)

`/api/images/local?a=&s=` takes an optional `w` (342, 780, 1280): a JPEG scaled to that width, made once with ffmpeg and kept in `<image cache folder>/local/` under the signed address and width (a changed file has a new version in its address, so a new copy). At most two conversions at a time; without ffmpeg or on failure the original is served (`content/library/artSizes.ts`, `test/art-sizes.test.ts`). The TV and webui ask for `w` on cards (342) and backdrops (780/1280). NAS posters are often 2-5 MB.
