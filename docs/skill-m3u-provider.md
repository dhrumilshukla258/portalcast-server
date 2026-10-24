# M3U provider — Skill Reference

Profile type `m3u` (owner, 2026-10-24: "we allow stalker, xtream and m3u"): a playlist link and,
optionally, an XMLTV guide link instead of a portal. One active profile at a time, like the
others; with the multi-source plan it becomes one of the sources.

Related: [[skill-xtream-provider]], [[skill-profiles-epg]], [[skill-stalker-provider]]

## Files

| File | What it does |
|---|---|
| `src/providers/m3u/parse.ts` | `M3uParser` (line by line), `kindOf`, `episodeOf`, `buildLibrary`, `idOf` |
| `src/providers/m3u/xmltv.ts` | `XmltvReader` (chunk by chunk), `xmltvTime` |
| `src/providers/m3u/provider.ts` | `M3uProvider` (IProvider): download, cache, refresh, Xtream-shaped answers |
| `test/m3u.test.ts` | parser, library, guide, and the provider end to end through `data:` links |

## Config

`providerType: "m3u"`, `m3uUrl`, `xmltvUrl` (optional; else the playlist's `url-tvg` /
`x-tvg-url`). Both links are encrypted at rest (`config/providerSecrets.ts`): M3U links usually
hold the account's username and password. Logs show only the host. The admin form (webui
`ConnectionForm`, `CreateProfileModal`) shows the two links instead of host/port/credentials.

## How entries are sorted

Xtream-style paths decide first (`/live/`, `/movie/`, `/series/`), then a `tvg-type` attribute,
then the link's file type (video files are VOD, anything else live). VOD named like an episode
(`S01E02`, `S01 E02`, `1x02`) is an episode, grouped by show name and season; otherwise a movie.
Groups come from `group-title` (or `#EXTGRP`), per kind.

Ids are 48-bit FNV-1a numbers of kind + group + name (+ season/episode), never of the link:
some providers change links at every refresh, and ids carry progress, My List and TMDB matches.
The same name twice in a group gets its own id (`|1`, `|2`…).

## Serving

- Same shapes as `XtreamClient` (14 per page, search, alphabetic sort), so routes, the catalog
  warm, TMDB matching and both apps need nothing new. Links are direct: `directLinks()`
  (`config/server.ts`) is true for Xtream and M3U, so streams are relayed with a player
  User-Agent as Xtream's are.
- The library is kept in memory with id tables, and saved to `<data>/m3u/library-<hash>.json`
  so a restart serves at once; refreshed when a day old (checked hourly, in the background); a
  failed download keeps the previous library. Limits: 512 MB playlist, 1 GB guide, 120 s idle.
- The guide is read 6 h back to 2 days ahead, refreshed every 6 h, de-duplicated; channels match
  by `tvg-id`, else by display name. `localGuide` tells the guide fetch to skip the pacing pauses
  meant for portals.
- `/api/v2/provider-key` hashes the playlist link; the portal health check pings its host.

Checked on real data (2026-10-24): the iptv-org playlist (11,320 entries, 184 groups) parsed and
built in 0.2 s with unique ids; its 38 MB XMLTV guide read in 1.4 s (1,245 channels, 43k
programmes kept).
