import { ServerRoute } from "@hapi/hapi";
import {
  writeJSON,
  readChannels,
  writeChannels,
  readGenres,
  writeGenres,
  upsertGenres,
} from "@/utils/storage";
import { initialConfig, seriesFlag } from "@/config/server";
import { serverManager } from "@/serverManager";
import axios from "axios";
import { ConfigProfile } from "@/models/ConfigProfile";
import { ContentCache } from "@/models/ContentCache";
import { stalkerApi } from "@/utils/stalker";
import { Readable } from "stream";
import { XtreamCache } from "@/models/XtreamCache";
import { ContentOverride } from "@/models/ContentOverride";
import { warmVodCache, warmSeriesCache, warmSeriesInfoCache, cleanupGenres, catchupScan, xtreamCache, getOrRefreshVodStreams, getOrRefreshSeriesList } from "@/routes/xtream";
import { logger } from "@/utils/logger";
import { authCheck } from "@/utils/jwt";
import { mintStreamToken, proxyUrlFor, streamTokenFromRequest } from "@/services/StreamTokens";
import {
  applyGenreOverrides,
  applyChannelOverrides,
  applyPortalItemOverrides,
} from "@/utils/overrides";

// Resolves a stable, human-readable identity label for the "active streams"
// admin view from the request's JWT — undefined for unauthenticated requests
// (stream URLs then carry no uid and show up by IP only).
const streamUserLabel = (request: any): string | undefined => {
  const payload = authCheck(request);
  return payload ? (payload.email || `user:${payload.userId}`) : undefined;
};

// `/api/v2/download` can't require a Bearer header — it's opened via
// `window.open`, a plain navigation. So the download target (id/series/cmd/
// path) is encoded into a token's resource server-side, behind a JWT-gated
// mint step, instead of trusting client-supplied id/cmd/path query params
// directly (which previously let anyone fetch+stream an arbitrary URL with
// zero auth — a real open-proxy/SSRF gap).
interface DownloadPayload {
  id?: string;
  series?: string;
  isSeries?: boolean;
  cmd?: string;
  path?: string;
  title?: string;
}

const mintDownloadToken = (payload: DownloadPayload, userLabel: string): string =>
  mintStreamToken(JSON.stringify(payload), userLabel, undefined, {
    kind: payload.isSeries ? "series" : "movie",
    label: payload.title,
  });
import crypto from "crypto";
import { getEpgCache, fetchAndCacheEpg } from "@/utils/epg";
import { getPublicOrigin } from "@/utils/publicUrl";
import { getM3uV2, getVodM3uV2 } from "@/utils/getM3uUrls";
import { channelLogoPath, proxiedLogoPath } from "@/utils/portalAssets";
import { fetchMovieMeta, fetchTVMeta } from "@/utils/tmdb";
import { searchSubtitles, resolveSubtitleDownloadUrl } from "@/utils/opensubtitles";

const CACHE_DURATION_MS = 4 * 60 * 60 * 1000; // 4 hours

const resolveStalkerUrl = (stalker: any, urlPath: string): string => {
  if (!urlPath) return "";
  
  let cleanedPath = urlPath.trim();
  const httpMatch = cleanedPath.match(/(https?:\/\/[^\s"']+)/);
  if (httpMatch) {
    cleanedPath = httpMatch[1];
  } else {
    const spaceIndex = cleanedPath.indexOf(" ");
    if (spaceIndex !== -1) {
      const parts = cleanedPath.split(/\s+/);
      const pathPart = parts.find(p => p.startsWith("/") || p.includes("."));
      if (pathPart) {
        cleanedPath = pathPart;
      }
    }
  }

  if (cleanedPath.startsWith("http://") || cleanedPath.startsWith("https://")) {
    return cleanedPath;
  }
  
  const baseHost = `http://${initialConfig.hostname}:${initialConfig.port}`;
  const context = initialConfig.contextPath ? `/${initialConfig.contextPath}` : "";
  const normalizedPath = cleanedPath.startsWith("/") ? cleanedPath : `/${cleanedPath}`;
  
  if (context && normalizedPath.startsWith(context)) {
    return `${baseHost}${normalizedPath}`;
  }
  return `${stalker.getBaseUrl()}${normalizedPath}`;
};

// Resolves an HLS playlist to its ordered list of absolute media-segment URLs,
// following one level of master->variant redirection if the playlist has no segments of its own.
const resolveHlsSegmentUrls = async (
  playlistUrl: string,
  headers: Record<string, any>,
  params: Record<string, any>,
): Promise<string[]> => {
  const res = await axios({
    method: "get",
    url: playlistUrl,
    headers,
    params,
    responseType: "text",
    validateStatus: () => true,
  });
  if (res.status !== 200 && res.status !== 206) {
    throw new Error(`HLS playlist fetch failed (${res.status}): ${playlistUrl}`);
  }
  const text = typeof res.data === "string" ? res.data : String(res.data);
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);

  // Many CDNs gate every segment (not just the master playlist) behind the same
  // ?token=...&filter=... query string, which relative segment URIs don't carry on their
  // own — so it has to be forwarded onto each resolved segment/variant URL.
  const queryIndex = playlistUrl.indexOf("?");
  const baseNoQuery = queryIndex === -1 ? playlistUrl : playlistUrl.slice(0, queryIndex);
  const playlistQuery = queryIndex === -1 ? "" : playlistUrl.slice(queryIndex + 1);
  const baseUrl = baseNoQuery.substring(0, baseNoQuery.lastIndexOf("/") + 1);

  const resolveUri = (uri: string): string => {
    const absolute = uri.startsWith("http") ? uri : `${baseUrl}${uri}`;
    if (!playlistQuery || absolute.includes("?")) return absolute;
    return `${absolute}?${playlistQuery}`;
  };

  const variantLine = lines.find((l) => !l.startsWith("#") && l.includes(".m3u8"));
  if (variantLine) {
    return resolveHlsSegmentUrls(resolveUri(variantLine), headers, params);
  }

  const segmentLines = lines.filter((l) => !l.startsWith("#"));
  if (segmentLines.length === 0) {
    throw new Error("HLS playlist contained no segments");
  }
  return segmentLines.map(resolveUri);
};

// Lazily fetches and yields each segment in order, one at a time — the server never
// holds more than one segment in memory, and the client reassembles the file as it downloads.
async function* streamHlsSegments(
  segmentUrls: string[],
  headers: Record<string, any>,
  params: Record<string, any>,
): AsyncGenerator<Buffer> {
  for (const segUrl of segmentUrls) {
    const segRes = await axios({
      method: "get",
      url: segUrl,
      headers,
      params,
      responseType: "stream",
      validateStatus: () => true,
    });
    if (segRes.status !== 200 && segRes.status !== 206) {
      throw new Error(`HLS segment fetch failed (${segRes.status}): ${segUrl}`);
    }
    for await (const chunk of segRes.data as Readable) {
      yield chunk;
    }
  }
}

// Enriches web UI items with TMDB data alongside whatever the portal already provides.
// Images (poster/backdrop) prefer TMDB first, then the portal's own image, then empty —
// TMDB artwork is simply higher quality/more consistent than most portals'. Text details
// (cast/director/overview) go the other way: prefer the portal's own data, and only fall
// back to TMDB when the portal doesn't have it. Results are cached per item (including
// "not found") so this is only a one-time cost per catalog item, not per page load.
//
// Cache misses are NOT awaited — the response returns immediately with whatever's already
// known, and the TMDB lookup runs in the background to populate the cache for next time.
// This keeps every page load fast regardless of TMDB's response time; the trade-off is a
// brand-new (never-viewed) item may show without its TMDB image until a later reload.
async function enrichArtworkFromTmdb(items: any[], kind: "movie" | "series"): Promise<any[]> {
  return Promise.all(
    items.map(async (item: any) => {
      const itemId = item.id ?? item.stream_id ?? item.series_id;
      if (!itemId) return item;

      // mapSeriesItem also sets `backdrop_path` to an Xtream-protocol array ([] or
      // [url]) on the same cached object — an empty array is truthy in JS, so a plain
      // `||` would let it silently win over a real TMDB backdrop string. Only accept it
      // here if it's actually a non-empty string.
      const existingBackdrop = typeof item.backdrop_path === "string" && item.backdrop_path
        ? item.backdrop_path
        : undefined;

      const cacheKey = `tmdb_web_${kind}_${itemId}`;
      const meta = await xtreamCache.get<any>(cacheKey);

      if (meta === undefined || meta === null) {
        if (!(item.screenshot_uri && existingBackdrop && item.actors && item.director)) {
          const name = item.name || item.title || "";
          const year = String(item.year || item.releaseDate || item.added || "").slice(0, 4);
          const lookup = kind === "movie" ? fetchMovieMeta(name, year) : fetchTVMeta(name, year);
          lookup
            .then((fetched) => xtreamCache.set(cacheKey, fetched ?? { _not_found: true }))
            .catch(() => {});
        }
        return { ...item, backdrop_path: existingBackdrop };
      }

      if (meta && !meta._not_found) {
        return {
          ...item,
          screenshot_uri: meta.poster || item.screenshot_uri,
          backdrop_path: meta.backdrop || existingBackdrop,
          description: item.description || meta.overview || item.description,
          actors: item.actors || meta.cast || item.actors,
          director: item.director || meta.director || item.director,
          trailer_key: meta.trailerKey || undefined,
        };
      }
      return { ...item, backdrop_path: existingBackdrop };
    }),
  );
}

const getActiveProfileId = async () => {
  const activeProfile = await ConfigProfile.findOne({
    where: { isActive: true },
  });
  return activeProfile?.id;
};

// Generates dynamic deterministic keys for parameters
const generateCacheKey = (type: string, queryParams: any): string => {
  const sortedString = JSON.stringify(
    queryParams,
    Object.keys(queryParams).sort(),
  );
  return `${type}_${crypto.createHash("md5").update(sortedString).digest("hex")}`;
};

// origin is the public base URL of this server (reverse-proxy aware), so the
// returned cmd is a complete playable URL that can be copied into any player.
// For BOTH provider types, channel.cmd at this point is the real upstream
// stream URL (for xtream it even embeds the admin's real upstream Xtream
// credentials in plaintext) — never hand that to the client. Route it through
// our own /live.m3u8 behind an opaque token instead.
const mapChannel = (channel: any, origin: string, userLabel?: string, genreTitle?: string) => {
  let cmdUrl: string;
  let logo = channel.logo || channel.screenshot_uri || "";
  if (userLabel) {
    const token = mintStreamToken(channel.cmd, userLabel, undefined, {
      kind: "live",
      label: channel.name,
      category: genreTitle,
    });
    cmdUrl = `${origin}/live.m3u8?t=${token}&id=${channel.id}&proxy=1`;
  } else {
    // No resolved identity — omit the token entirely; /live.m3u8 will 401.
    cmdUrl = `${origin}/live.m3u8?id=${channel.id}&proxy=1`;
  }
  if (initialConfig.providerType === "stalker") {
    // Frontend prefixes non-http values with /api/images — hand it a portal-root path
    logo = channelLogoPath(logo);
  }
  return {
    ...channel,
    cmd: cmdUrl,
    screenshot_uri: logo,
    isPortal: initialConfig.providerType === "stalker",
  };
};

export const stalkerV2: ServerRoute[] = [
  {
    method: "GET",
    path: "/api/images/{slug*}",
    handler: async (request, h) => {
      try {
        const { slug } = request.params;

        // This is a poster/logo relay to the active portal, not a general
        // proxy — it's the one route left unauthenticated (an <img src>
        // can't attach a Bearer header or a stream token). Without these
        // checks it becomes an open, unauthenticated GET relay to the
        // portal's entire HTTP surface: no extension check meant any path
        // (e.g. an internal load.php endpoint) could be reached through us,
        // and no traversal/query-string check meant the target path wasn't
        // actually pinned to a real image resource at all.
        if (slug.includes("..") || slug.includes("?") || slug.includes("#")) {
          return h.response({ success: false, message: "Invalid path" }).code(400);
        }
        if (!/\.(png|jpe?g|webp|gif|svg|bmp|ico)$/i.test(slug)) {
          return h.response({ success: false, message: "Not an image" }).code(400);
        }

        const proto = initialConfig.https ? "https" : "http";
        const targetUrl = `${proto}://${initialConfig.hostname}:${initialConfig.port}/${slug}`;
        const response = await fetch(targetUrl);

        if (!response.ok || !response.body) {
          return h
            .response({ success: false, message: "Image not found" })
            .code(404);
        }

        const contentType =
          response.headers.get("content-type") || "image/jpeg";
        const nodeStream = Readable.fromWeb(response.body as any);

        return h
          .response(nodeStream)
          .type(contentType)
          .header("cache-control", "max-age=3600");
      } catch (err) {
        logger.error({ err }, "Piping error");
        return h
          .response({ success: false, error: "An unexpected error occurred." })
          .code(500);
      }
    },
  },
  {
    method: "GET",
    path: "/api/v2/refresh-groups",
    handler: async (request, h) => {
      try {
        const profileId = await getActiveProfileId();
        const category = await serverManager.getProvider().getChannelGroups();
        const filteredCategory = category.js.filter(
          (group) => initialConfig.playCensored || group.censored != 1,
        );
        await writeGenres(filteredCategory, "channel", profileId);
        return filteredCategory;
      } catch (err) {
        logger.error({ err }, "error");
        return h
          .response({ success: false, error: "Failed to refresh groups." })
          .code(500);
      }
    },
  },
  {
    method: "GET",
    path: "/api/v2/groups",
    handler: async (request, h) => {
      try {
        const profileId = await getActiveProfileId();
        const { all } = request.query as { all?: string };
        const groups = await readGenres("channel", profileId);

        if (groups.length === 0) {
          return h.redirect("/api/v2/refresh-groups");
        }

        if (all === "true") {
          return groups;
        }

        const filteredGroups = await applyGenreOverrides(
          groups.filter(
            (group) =>
              initialConfig.groups.length === 0 ||
              initialConfig.groups.includes(group.title),
          ),
          "channel",
        );
        return filteredGroups;
      } catch (err) {
        logger.error({ err }, "error");
        return h
          .response({ success: false, error: "Failed to retrieve groups." })
          .code(500);
      }
    },
  },
  {
    method: "GET",
    path: "/api/v2/refresh-channels",
    handler: async (request, h) => {
      try {
        const profileId = await getActiveProfileId();
        const channels = await serverManager.getProvider().getChannels();
        const filteredChannels = channels.js.data.filter(
          (channel) =>
            initialConfig.playCensored || String(channel.censored) !== "1",
        );
        await writeChannels(filteredChannels, profileId);
        const origin = getPublicOrigin(request);
        const userLabel = streamUserLabel(request);
        const genres = await readGenres("channel", profileId);
        const genreTitleMap = new Map(genres.map((g: any) => [g.id, g.title]));
        const mappedChannels = filteredChannels.map((c) =>
          mapChannel(c, origin, userLabel, genreTitleMap.get(c.tv_genre_id)),
        );
        if (genres.length === 0) {
          return mappedChannels ?? [];
        }
        return (mappedChannels ?? []).filter((channel) => {
          const genre = genres.find(
            (r) => r.id === String(channel.tv_genre_id),
          );
          return (
            genre &&
            (initialConfig.groups.length === 0 ||
              initialConfig.groups.includes(genre.title))
          );
        });
      } catch (err) {
        logger.error({ err }, "error");
        return h
          .response({ success: false, error: "Failed to refresh channels." })
          .code(500);
      }
    },
  },
  {
    method: "GET",
    path: "/api/v2/channels",
    handler: async (request, h) => {
      try {
        const profileId = await getActiveProfileId();
        const channels = await readChannels(profileId);
        if (channels.length === 0) {
          return h.redirect("/api/v2/refresh-channels");
        }
        const genres = await readGenres("channel", profileId);
        const originalTitleMap = new Map(genres.map((g: any) => [g.id, g.title]));
        const visibleGenres = await applyGenreOverrides(genres, "channel");
        const visibleGenreIds = new Set(visibleGenres.map((g: any) => g.id));
        const overriddenChannels = await applyChannelOverrides(channels);
        const origin = getPublicOrigin(request);
        const userLabel = streamUserLabel(request);
        return overriddenChannels
          .filter((channel) => visibleGenreIds.has(channel.tv_genre_id) &&
            (initialConfig.groups.length === 0 ||
              initialConfig.groups.includes(originalTitleMap.get(channel.tv_genre_id) ?? "")))
          .map((channel) => mapChannel(channel, origin, userLabel, originalTitleMap.get(channel.tv_genre_id)))
          .sort((a, b) => a.name.localeCompare(b.name));
      } catch (err) {
        logger.error({ err }, "error");
        return h
          .response({ success: false, error: "Failed to retrieve channels." })
          .code(500);
      }
    },
  },
  {
    method: "GET",
    path: "/api/v2/refresh-movie-groups",
    handler: async (request, h) => {
      try {
        const profileId = await getActiveProfileId();
        const groups = await serverManager.getProvider().getMoviesGroups();
        const allCats = (Array.isArray(groups.js) ? groups.js : []).filter(
          (ch: any) => initialConfig.playCensored || ch.censored != 1,
        );

        await upsertGenres(allCats, "movie", profileId);
        await xtreamCache.delete("vod_cats");
        warmVodCache().catch((e) => logger.error({ err: e }, "[warm-xtream-vod]"));
        return allCats;
      } catch (err) {
        logger.error({ err }, "error");
        return h
          .response({
            success: false,
            error: "Failed to refresh movie groups.",
          })
          .code(500);
      }
    },
  },
  {
    method: "GET",
    path: "/api/v2/movie-groups",
    handler: async (request, h) => {
      try {
        const profileId = await getActiveProfileId();
        const channels = await readGenres("movie", profileId);
        if (channels.length === 0) {
          return h.redirect("/api/v2/refresh-movie-groups");
        }
        return {
          success: true,
          page: Number(1),
          pageAtaTime: Number(1),
          total_items: channels.length,
          actual_length: channels.length,
          total_loaded: channels.length,
          data: await applyGenreOverrides(channels, "movie"),
          errors: false,
          isPortal: initialConfig.providerType === "stalker",
        };
      } catch (err) {
        logger.error({ err }, "error");
        return h
          .response({
            success: false,
            error: "Failed to retrieve movie groups.",
          })
          .code(500);
      }
    },
  },
  {
    method: "GET",
    path: "/api/v2/reset-movies",
    handler: async (request, h) => {
      try {
        const groups = await serverManager.getProvider().getMoviesGroups();
        const filteredChannels = groups.js.filter(
          (channel) => initialConfig.playCensored || channel.censored != 1,
        );
        return { success: true, data: filteredChannels };
      } catch (err) {
        logger.error({ err }, "error");
        return h
          .response({ success: false, error: "Failed to reset movies." })
          .code(500);
      }
    },
  },
  {
    method: "GET",
    path: "/api/v2/movies",
    handler: async (request, h) => {
      try {
        const profileId = (await getActiveProfileId()) || 0;
        const query = request.query as any;
        const {
          category = 0,
          movieId = 0,
          seasonId = 0,
          episodeId = 0,
          page = 1,
          search = "",
        } = query;

        if (category == 0 && movieId == 0) {
          return h.redirect("/api/v2/movie-groups");
        }

        const itemsPerApiPage = 14;
        const startApiPage = Number(page);
        const cacheKey = generateCacheKey("movies", query);
        const getVodCache = (catId: string) =>
          xtreamCache.get<any[]>(`vod_streams_${catId}`).then((v) => v ?? []);

        // ContentCache check — skip if searching or drilling into a specific item
        if (!search && Number(movieId) === 0) {
          const cachedRecord = await ContentCache.findOne({ where: { profileId, cacheKey } });
          if (cachedRecord && new Date() < cachedRecord.expiresAt) {
            return cachedRecord.response;
          }
        }

        // Virtual categories — serve from xtreamCache overrides
        if (String(category).startsWith("vcat_") && Number(movieId) === 0) {
          const movedIn = await ContentOverride.findAll({
            where: { item_type: "movie", target_category_id: String(category) },
            raw: true,
          });
          const allItems: any[] = [];
          for (const ov of movedIn) {
            if (ov.hidden || !ov.original_category_id) continue;
            const itemId = ov.item_key.replace("movie_", "");
            const srcItems = (await xtreamCache.get<any[]>(`vod_streams_${ov.original_category_id}`)) ?? [];
            const srcItem = srcItems.find((i: any) => String(i.stream_id) === itemId);
            if (!srcItem) continue;
            allItems.push({ ...srcItem, id: itemId, name: ov.display_name ?? srcItem.name });
          }
          const offset = (startApiPage - 1) * itemsPerApiPage;
          const pageData = allItems.slice(offset, offset + itemsPerApiPage);
          return h.response({
            success: true,
            page: Number(page),
            pageAtaTime: 1,
            total_items: allItems.length,
            actual_length: itemsPerApiPage,
            total_loaded: pageData.length,
            data: pageData,
            errors: false,
            isPortal: initialConfig.providerType === "stalker",
          });
        }

        // Prefer already-warmed DB data over a live portal call for category browsing —
        // same getOrRefreshVodStreams() the Xtream player API uses, so both surfaces get
        // identical staleness/refresh behavior instead of the web UI trusting stale rows forever.
        if (Number(movieId) === 0 && !search) {
          const cachedMovies = await getOrRefreshVodStreams(String(category));
          if (cachedMovies && cachedMovies.length > 0) {
            // Items cached before screenshot_uri/description/etc. were added to mapVodItem
            // only have the older Xtream-shaped fields — stream_icon is already a complete,
            // working image URL (same one Xtream players render), so fall back to it instead
            // of requiring every old cache entry to be rebuilt from the portal.
            const allNormalized = cachedMovies.map((m: any) => ({
              ...m,
              id: String(m.stream_id),
              screenshot_uri: m.screenshot_uri || m.stream_icon || "",
            }));
            const allOverridden = await applyPortalItemOverrides(allNormalized, "movie", String(category), getVodCache);
            const offset = (startApiPage - 1) * itemsPerApiPage;
            const pageData = allOverridden.slice(offset, offset + itemsPerApiPage);
            const responsePayload = {
              success: true,
              page: Number(page),
              pageAtaTime: 1,
              total_items: allOverridden.length,
              actual_length: itemsPerApiPage,
              total_loaded: pageData.length,
              data: await enrichArtworkFromTmdb(pageData, "movie"),
              errors: false,
              isPortal: initialConfig.providerType === "stalker",
            };
            await ContentCache.upsert({
              profileId,
              cacheKey,
              response: responsePayload,
              expiresAt: new Date(Date.now() + CACHE_DURATION_MS),
            });
            return responsePayload;
          }
        }

        const sortParam = query.sort === "alphabetic" ? "name" : "added";
        const res = await serverManager.getProvider().getMovies({
          category,
          page: Number(page),
          movieId,
          seasonId,
          episodeId,
          search,
          token: query.token,
          sort: sortParam,
        });

        if (res && res.js && Array.isArray(res.js.data)) {
          const isSeasonContext = !!seasonId && !episodeId;
          const isSeriesContext = !!movieId && !seasonId && !episodeId;
          res.js.data = res.js.data.map((item: any) => {
            const isEpisode = isSeasonContext || !!item.series_number || item.is_episode;
            const isSeason = isSeriesContext && !isEpisode;
            return {
              ...item,
              is_episode: isEpisode ? 1 : item.is_episode,
              ...(isSeason && { is_season: true }),
            };
          });
        }

        let firstPageData = res?.js?.data ?? [];

        // At top level exclude series so only movies show
        if (Number(movieId) === 0) {
          firstPageData = firstPageData.filter((item: any) => item[seriesFlag] != 1);
        }

        // For episode-level requests refresh cmd via create_link (stale CDN URLs)
        if (Number(episodeId) > 0) {
          for (const item of firstPageData as any[]) {
            try {
              const link = await serverManager.getProvider().getMovieLink({
                series: item.series_number ?? "0",
                id: Number(item.id),
                download: 0,
              });
              const freshCmd = link?.js?.cmd;
              if (freshCmd && typeof freshCmd === "string") {
                item.cmd = freshCmd.startsWith("ffrt ") ? freshCmd.slice(5) : freshCmd;
              }
            } catch (err) {
              logger.error(`[episode link] failed for id=${item.id}: ${err}`);
            }
          }
        }

        const actualTotalItems = (res?.js && Number(res.js.total_items)) ?? 0;

        const overriddenMovieData = Number(movieId) === 0
          ? await applyPortalItemOverrides(firstPageData, "movie", String(category), getVodCache)
          : firstPageData;

        const responsePayload = {
          success: true,
          page: Number(page),
          pageAtaTime: 1,
          total_items: actualTotalItems,
          actual_length: itemsPerApiPage,
          total_loaded: firstPageData.length,
          data: await enrichArtworkFromTmdb(overriddenMovieData, "movie"),
          errors: false,
          isPortal: initialConfig.providerType === "stalker",
        };

        if (!search && res?.js) {
          await ContentCache.upsert({
            profileId,
            cacheKey,
            response: responsePayload,
            expiresAt: new Date(Date.now() + CACHE_DURATION_MS),
          });
        }

        return responsePayload;
      } catch (err) {
        logger.error({ err }, "error");
        return h
          .response({ success: false, error: "Failed to retrieve movies." })
          .code(500);
      }
    },
  },
  {
    method: "GET",
    path: "/api/v2/series",
    handler: async (request, h) => {
      try {
        const profileId = (await getActiveProfileId()) || 0;
        const query = request.query as any;
        const {
          category = 0,
          movieId = 0,
          seasonId = 0,
          episodeId = 0,
          page = 1,
          search = "",
          sort,
          ...others
        } = query;

        if (category == 0 && movieId == 0) {
          return h.redirect("/api/v2/series-groups");
        }

        const cacheKey = generateCacheKey("series", query);
        const itemsPerApiPage = 14;
        const startApiPage = Number(page);
        const getSeriesCache = (catId: string) =>
          xtreamCache.get<any[]>(`series_list_${catId}`).then((v) => v ?? []);

        // ContentCache check — skip if searching or drilling into a specific item
        if (!search && Number(movieId) === 0) {
          const cachedRecord = await ContentCache.findOne({ where: { profileId, cacheKey } });
          if (cachedRecord && new Date() < cachedRecord.expiresAt) {
            return cachedRecord.response;
          }
        }

        // Virtual categories — serve from xtreamCache overrides
        if (String(category).startsWith("vcat_") && Number(movieId) === 0) {
          const movedIn = await ContentOverride.findAll({
            where: { item_type: "series", target_category_id: String(category) },
            raw: true,
          });
          const allItems: any[] = [];
          for (const ov of movedIn) {
            if (ov.hidden || !ov.original_category_id) continue;
            const itemId = ov.item_key.replace("series_", "");
            const srcItems = (await xtreamCache.get<any[]>(`series_list_${ov.original_category_id}`)) ?? [];
            const srcItem = srcItems.find((i: any) => String(i.series_id) === itemId);
            if (!srcItem) continue;
            allItems.push({ ...srcItem, id: itemId, name: ov.display_name ?? srcItem.name, [seriesFlag]: 1 });
          }
          const offset = (startApiPage - 1) * itemsPerApiPage;
          const pageData = allItems.slice(offset, offset + itemsPerApiPage);
          return h.response({
            success: true,
            page: Number(page),
            pageAtaTime: 1,
            total_items: allItems.length,
            actual_length: itemsPerApiPage,
            total_loaded: pageData.length,
            data: pageData,
            errors: false,
            isPortal: initialConfig.providerType === "stalker",
          });
        }

        const sourceRow = await XtreamCache.findOne({ where: { key: "portal_series_source" } });
        const isNativeSeries = sourceRow ? JSON.parse(sourceRow.value) === "native" : false;

        // Prefer already-warmed DB data over a live portal call for category browsing —
        // same getOrRefreshSeriesList() the Xtream player API uses, so both surfaces get
        // identical staleness/refresh behavior instead of the web UI trusting stale rows forever.
        if (Number(movieId) === 0 && !search) {
          const cachedSeries = await getOrRefreshSeriesList(String(category));
          if (cachedSeries && cachedSeries.length > 0) {
            // Existing cached series entries already carry rich data under Xtream-shaped
            // field names (cover/plot/cast/genre) — map them to what the web UI expects
            // instead of requiring every cache entry to be rebuilt from the portal.
            const allNormalized = cachedSeries.map((s: any) => ({
              ...s,
              id: String(s.series_id),
              [seriesFlag]: 1,
              screenshot_uri: s.screenshot_uri || s.cover || "",
              description: s.description || s.plot || "",
              actors: s.actors || s.cast || "",
              genres_str: s.genres_str || s.genre || "",
            }));
            const allOverridden = await applyPortalItemOverrides(allNormalized, "series", String(category), getSeriesCache);
            const offset = (startApiPage - 1) * itemsPerApiPage;
            const pageData = allOverridden.slice(offset, offset + itemsPerApiPage);
            const responsePayload = {
              success: true,
              page: Number(page),
              pageAtaTime: 1,
              total_items: allOverridden.length,
              actual_length: itemsPerApiPage,
              total_loaded: pageData.length,
              data: await enrichArtworkFromTmdb(pageData, "series"),
              errors: false,
              isPortal: initialConfig.providerType === "stalker",
            };
            await ContentCache.upsert({
              profileId,
              cacheKey,
              response: responsePayload,
              expiresAt: new Date(Date.now() + CACHE_DURATION_MS),
            });
            return responsePayload;
          }
        }

        const sortParam = sort === "alphabetic" ? "name" : "added";
        const portalCategory = String(category).startsWith("vcat_") ? "*" : category;
        const res = isNativeSeries
          ? await serverManager.getProvider().getSeries({ category: portalCategory, page: Number(page), movieId, seasonId, episodeId, search, token: query.token, sort: sortParam, ...others })
          : await serverManager.getProvider().getMovies({ category: portalCategory, page: Number(page), movieId, seasonId, episodeId, search, token: query.token, sort: sortParam });

        if (res?.js?.data && Array.isArray(res.js.data)) {
          res.js.data = res.js.data.map((item: any) => {
            const isEpisode = !!seasonId || !!item.series_number || item.is_episode;
            return { ...item, is_episode: isEpisode ? 1 : item.is_episode };
          });
        }

        const rawData = res?.js?.data ?? [];
        let firstPageData = Number(movieId) === 0
          ? (isNativeSeries ? rawData : rawData.filter((item: any) => item[seriesFlag] == 1))
          : rawData;

        const portalTotal = res?.js?.total_items ?? 0;
        const ratio = isNativeSeries ? 1 : (rawData.length > 0 ? firstPageData.length / rawData.length : 1);
        const actualTotalItems = Number(movieId) === 0 ? Math.ceil(portalTotal * ratio) : portalTotal;

        const overriddenSeriesData = Number(movieId) === 0
          ? await applyPortalItemOverrides(firstPageData, "series", String(category), getSeriesCache)
          : firstPageData;

        const responsePayload = {
          success: true,
          page: Number(page),
          pageAtaTime: 1,
          total_items: actualTotalItems,
          actual_length: itemsPerApiPage,
          total_loaded: firstPageData.length,
          data: await enrichArtworkFromTmdb(overriddenSeriesData, "series"),
          errors: false,
          isPortal: initialConfig.providerType === "stalker",
        };

        if (!search && res?.js) {
          await ContentCache.upsert({
            profileId,
            cacheKey,
            response: responsePayload,
            expiresAt: new Date(Date.now() + CACHE_DURATION_MS),
          });
        }

        return responsePayload;
      } catch (err) {
        logger.error({ err }, "error");
        return h
          .response({ success: false, error: "Failed to retrieve series." })
          .code(500);
      }
    },
  },
  {
    method: "GET",
    path: "/api/v2/movie-link",
    handler: async (request, h) => {
      try {
        const {
          series = "",
          id = "",
          download = 0,
          token,
          cmd,
        } = request.query;
        const { title, category } = request.query as { title?: string; category?: string };
        const isSeries =
          series && series !== "0" && series !== "false" && series !== "";
        let movieLink: any;
        if (isSeries) {
          movieLink = await serverManager.getProvider().getSeriesLink({
            series: series as string,
            id: Number(id),
            download: Number(download),
            cmd: cmd as string,
          });
        } else {
          movieLink = await serverManager.getProvider().getMovieLink({
            series: series as string,
            id: Number(id),
            download: Number(download),
            cmd: cmd as string,
          });
        }

        if (movieLink && (download == 1 || download === "1")) {
          const rawUrl = movieLink?.js?.cmd || movieLink?.cmd;
          if (
            typeof rawUrl === "string" &&
            (rawUrl.startsWith("/") || rawUrl.includes("get_download_link.php"))
          ) {
            const userLabel = streamUserLabel(request);
            if (!userLabel) {
              logger.error("[movie-link] No resolvable identity for download link — refusing to mint token");
              return h.response({ error: "Unauthorized" }).code(401);
            }
            const downloadToken = mintDownloadToken(
              { path: rawUrl, isSeries: Boolean(isSeries), title: title as string | undefined },
              userLabel
            );
            const proxiedDownloadUrl = `/api/v2/download?t=${downloadToken}`;
            if (movieLink.js) {
              movieLink.js.cmd = proxiedDownloadUrl;
            } else {
              movieLink.cmd = proxiedDownloadUrl;
            }
          }
        }

        // getMovieLink/getSeriesLink always return the real, absolute upstream
        // URL (for xtream this even embeds the admin's real portal
        // credentials in plaintext) — never hand that to the client directly.
        // Wrap it behind an opaque token so the client only ever sees
        // /api/proxy?t=<random>, with the real URL kept server-side only.
        const rawUrl = movieLink?.js?.cmd || movieLink?.cmd;
        if (typeof rawUrl === "string" && !(download == 1 || download === "1")) {
          const userLabel = streamUserLabel(request);
          if (!userLabel) {
            // Must never fall through to returning the raw upstream URL —
            // if we can't resolve identity here, fail closed instead of
            // silently leaking it to the client.
            logger.error("[movie-link] No resolvable identity for authenticated request — refusing to return raw URL");
            return h.response({ error: "Unauthorized" }).code(401);
          }
          const tokenizedUrl = proxyUrlFor(rawUrl, userLabel, {
            kind: isSeries ? "series" : "movie",
            label: title,
            category,
          });
          if (movieLink.js) movieLink.js.cmd = tokenizedUrl;
          else movieLink.cmd = tokenizedUrl;
        }

        return movieLink;
      } catch (err) {
        logger.error({ err }, "error");
        return h
          .response({ success: false, error: "Failed to retrieve movie link." })
          .code(500);
      }
    },
  },
  {
    // JWT-gated (not in the auth-exempt list) — mints the token `/api/v2/download`
    // requires. The frontend calls this first, then `window.open()`s the returned
    // URL, since the download itself is a plain navigation that can't carry a
    // Bearer header.
    method: "GET",
    path: "/api/v2/download-link",
    handler: async (request, h) => {
      const userLabel = streamUserLabel(request);
      if (!userLabel) return h.response({ error: "Unauthorized" }).code(401);

      const { id, series, isSeries, cmd, title } = request.query as {
        id?: string;
        series?: string;
        isSeries?: string;
        cmd?: string;
        title?: string;
      };
      if (!id) return h.response({ error: "Missing id" }).code(400);

      const downloadToken = mintDownloadToken(
        {
          id,
          series,
          isSeries: isSeries === "1" || isSeries === "true",
          cmd,
          title,
        },
        userLabel
      );
      return h.response({ url: `/api/v2/download?t=${downloadToken}` });
    },
  },
  {
    // Rewrites legacy portal-prefixed stream_icon values stored in the
    // live_streams_* XtreamCache entries to the proxied /api/images format.
    // One-shot in-place migration — nothing is deleted.
    method: "POST",
    path: "/api/v2/debug/fix-live-icons",
    handler: async (_request, h) => {
      try {
        const { Op } = await import("sequelize");
        const rows = await XtreamCache.findAll({
          where: { key: { [Op.like]: "live_streams_%" } },
        });
        const portalPrefix = `${initialConfig.https ? "https" : "http"}://${initialConfig.hostname}:${initialConfig.port}`;
        let entriesUpdated = 0;
        let iconsRewritten = 0;

        for (const row of rows) {
          let list: any;
          try { list = JSON.parse(row.value); } catch { continue; }
          if (!Array.isArray(list)) continue;

          let changed = false;
          const fixed = list.map((c: any) => {
            const icon = c?.stream_icon;
            if (typeof icon === "string" && icon.startsWith(portalPrefix)) {
              const rawLogo = icon.slice(portalPrefix.length).replace(/^\//, "");
              changed = true;
              iconsRewritten++;
              return { ...c, stream_icon: proxiedLogoPath(rawLogo) };
            }
            return c;
          });

          if (changed) {
            row.value = JSON.stringify(fixed);
            await row.save();
            entriesUpdated++;
          }
        }

        return h.response({
          success: true,
          cacheEntriesScanned: rows.length,
          cacheEntriesUpdated: entriesUpdated,
          iconsRewritten,
        });
      } catch (err: any) {
        return h.response({ success: false, error: err.message }).code(500);
      }
    },
  },
  {
    method: "GET",
    path: "/api/v2/debug/epg",
    handler: async (request, h) => {
      const { id } = request.query as { id?: string };
      if (!id) return h.response({ error: "id required" }).code(400);
      try {
        const epg = await serverManager.getProvider().getEPG(id);
        return h.response({ channelId: id, count: epg?.js?.length ?? 0, programs: epg?.js?.slice(0, 3) });
      } catch (err: any) {
        return h.response({ error: err.message }).code(500);
      }
    },
  },
  {
    method: "GET",
    path: "/api/v2/debug/vod-item",
    handler: async (request, h) => {
      try {
        const { id } = request.query as { id?: string };
        if (!id) return h.response({ error: "id required" }).code(400);
        const data = await serverManager.getProvider().getMovies({ category: "*", page: 1, movieId: parseInt(id) });
        return h.response({ raw: data?.js?.data || [] });
      } catch (err: any) {
        return h.response({ error: err.message }).code(500);
      }
    },
  },
  {
    method: "GET",
    path: "/api/v2/debug/episode-fetch",
    handler: async (request, h) => {
      const { seriesId, seasonId, category = "*" } = request.query as { seriesId?: string; seasonId?: string; category?: string };
      if (!seriesId || !seasonId) return h.response({ error: "seriesId and seasonId required" }).code(400);
      const provider = serverManager.getProvider();
      const results: any = {};

      const summarise = (r: any) => ({
        jsKeys: Object.keys(r?.js || {}),
        total_items: r?.js?.total_items,
        data_length: r?.js?.data?.length ?? 0,
        first_item: r?.js?.data?.[0] ?? null,
        raw_js: r?.js,
      });

      try {
        results.A_vod_movie_series_season = summarise(
          await provider.getMovies({ category, page: 1, movieId: parseInt(seriesId), seasonId: parseInt(seasonId) })
        );
      } catch (e: any) { results.A_vod_movie_series_season = { error: e.message }; }

      try {
        results.B_vod_movie_season_only = summarise(
          await provider.getMovies({ category, page: 1, movieId: parseInt(seasonId) })
        );
      } catch (e: any) { results.B_vod_movie_season_only = { error: e.message }; }

      try {
        results.C_series_movie_series_season = summarise(
          await provider.getSeries({ category, page: 1, movieId: parseInt(seriesId), seasonId: parseInt(seasonId) })
        );
      } catch (e: any) { results.C_series_movie_series_season = { error: e.message }; }

      try {
        results.D_series_movie_season_only = summarise(
          await provider.getSeries({ category, page: 1, movieId: parseInt(seasonId) })
        );
      } catch (e: any) { results.D_series_movie_season_only = { error: e.message }; }

      return h.response(results);
    },
  },
  {
    method: "GET",
    path: "/api/v2/refresh-series-groups",
    handler: async (request, h) => {
      try {
        const profileId = await getActiveProfileId();

        // Try native series API first (Type 2 portal)
        const nativeGroups = await serverManager.getProvider().getSeriesGroups();
        const nativeCats = (Array.isArray(nativeGroups?.js) ? nativeGroups.js : []).filter(
          (ch: any) => initialConfig.playCensored || ch.censored != 1,
        );

        if (nativeCats.length > 0) {
          await upsertGenres(nativeCats, "series", profileId);
          await XtreamCache.upsert({ key: "portal_series_source", value: JSON.stringify("native"), expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) });
          await xtreamCache.delete("series_cats");
          warmSeriesCache().catch((e) => logger.error({ err: e }, "[warm-xtream-series]"));
          return nativeCats;
        }

        // Portal A — series are mixed into VOD with is_series flag.
        // Don't pre-populate series genres here; warmVodCache will scan each
        // VOD category and call upsertGenre("series") for any that contain series.
        await XtreamCache.upsert({ key: "portal_series_source", value: JSON.stringify("vod"), expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) });
        await xtreamCache.delete("series_cats");
        warmVodCache().catch((e) => logger.error({ err: e }, "[warm-xtream-vod]"));
        return await readGenres("series", profileId);
      } catch (err) {
        logger.error({ err }, "error");
        return h
          .response({
            success: false,
            error: "Failed to refresh series groups.",
          })
          .code(500);
      }
    },
  },
  {
    method: "POST",
    path: "/api/v2/catchup-scan",
    handler: async (_request, h) => {
      catchupScan().catch((e) => logger.error(`[catchup-scan] ${e}`));
      return h.response({ success: true, message: "Catch-up scan started in background." });
    },
  },

  {
    method: "GET",
    path: "/api/v2/series-groups",
    handler: async (request, h) => {
      try {
        const profileId = await getActiveProfileId();
        const channels = await readGenres("series", profileId);
        if (channels.length === 0) {
          return h.redirect("/api/v2/refresh-series-groups");
        }
        return {
          success: true,
          page: Number(1),
          pageAtaTime: Number(1),
          total_items: channels.length,
          actual_length: channels.length,
          total_loaded: channels.length,
          data: await applyGenreOverrides(channels, "series"),
          errors: false,
          isPortal: initialConfig.providerType === "stalker",
        };
      } catch (err) {
        logger.error({ err }, "error");
        return h
          .response({
            success: false,
            error: "Failed to retrieve series groups.",
          })
          .code(500);
      }
    },
  },
  {
    method: "GET",
    path: "/api/v2/channel-link",
    handler: async (request, h) => {
      try {
        const channelLink: any = await serverManager
          .getProvider()
          .getChannelLink(request.query.cmd as any);

        // getChannelLink resolves to the real upstream URL — never hand that
        // to the client directly (see /api/v2/movie-link for the same fix).
        const rawUrl = channelLink?.js?.cmd || channelLink?.cmd;
        if (typeof rawUrl === "string") {
          const userLabel = streamUserLabel(request);
          if (!userLabel) {
            logger.error("[channel-link] No resolvable identity for authenticated request — refusing to return raw URL");
            return h.response({ error: "Unauthorized" }).code(401);
          }
          const tokenizedUrl = proxyUrlFor(rawUrl, userLabel, { kind: "live" });
          if (channelLink.js) channelLink.js.cmd = tokenizedUrl;
          else channelLink.cmd = tokenizedUrl;
        }

        return channelLink;
      } catch (err) {
        logger.error({ err }, "error");
        return h
          .response({
            success: false,
            error: "Failed to retrieve channel link.",
          })
          .code(500);
      }
    },
  },
  {
    method: "GET",
    path: "/api/v2/epg",
    handler: async (request, h) => {
      try {
        const cache = await getEpgCache();
        if (cache) return cache;
        return [];
      } catch (err) {
        logger.error({ err }, "error");
        return h
          .response({ success: false, error: "Failed to retrieve EPG." })
          .code(500);
      }
    },
  },
  {
    method: "POST",
    path: "/api/v2/refresh-epg",
    handler: async (_request, h) => {
      fetchAndCacheEpg().catch((e) => logger.error(`[refresh-epg] ${e}`));
      return h.response({ success: true, message: "EPG refresh started in background." });
    },
  },
  {
    method: "GET",
    path: "/api/v2/expiry",
    handler: async (request, h) => {
      try {
        const expiry = await serverManager.getProvider().getExpiry();
        return { success: true, expiry };
      } catch (err) {
        logger.error({ err }, "error");
        return h
          .response({
            success: false,
            error: "Failed to retrieve expiry date.",
          })
          .code(500);
      }
    },
  },
  {
    method: "GET",
    path: "/api/v2/get-token",
    handler: async (request, h) => {
      try {
        const tokenResponse = await stalkerApi.fetchNewToken();
        if (tokenResponse && tokenResponse.token) {
          stalkerApi.addToken(tokenResponse.token);
          const activeProfile = await ConfigProfile.findOne({
            where: { isActive: true },
          });
          if (activeProfile) {
            activeProfile.config.tokens = initialConfig.tokens;
            activeProfile.changed("config", true);
            await activeProfile.save();
          }
          return { success: true, token: tokenResponse.token };
        }
        return h
          .response({ success: false, error: "Failed to fetch token" })
          .code(500);
      } catch (err) {
        logger.error({ err }, "Error fetching new token");
        return h
          .response({ success: false, error: "Failed to fetch new token." })
          .code(500);
      }
    },
  },
  {
    method: "POST",
    path: "/api/v2/clear-tokens",
    handler: async (request, h) => {
      try {
        initialConfig.tokens = [];
        const activeProfile = await ConfigProfile.findOne({
          where: { isActive: true },
        });
        if (activeProfile) {
          activeProfile.config.tokens = [];
          activeProfile.changed("config", true);
          await activeProfile.save();
        }
        return { success: true, message: "All tokens cleared." };
      } catch (err) {
        logger.error({ err }, "Error clearing tokens");
        return h
          .response({ success: false, error: "Failed to clear tokens." })
          .code(500);
      }
    },
  },
  {
    method: "POST",
    path: "/api/v2/warm-xtream-vod",
    handler: async (_request, h) => {
      warmVodCache().catch((e) => logger.error({ err: e }, "[warm-xtream-vod]"));
      return { success: true, message: "VOD cache warming started in background." };
    },
  },

  {
    method: "POST",
    path: "/api/v2/warm-xtream-series",
    handler: async (_request, h) => {
      warmSeriesCache().catch((e) => logger.error({ err: e }, "[warm-xtream-series]"));
      warmSeriesInfoCache().catch((e) => logger.error({ err: e }, "[warm-xtream-series-info]"));
      return { success: true, message: "Series cache warming started in background." };
    },
  },

  {
    method: "POST",
    path: "/api/v2/cleanup-genres",
    handler: async (_request, h) => {
      await cleanupGenres();
      return { success: true, message: "Genre cleanup complete." };
    },
  },

  {
    method: "DELETE",
    path: "/api/v2/clear-xtream-cache",
    handler: async (request, h) => {
      try {
        const { prefix } = request.query as { prefix?: string };
        const { Op } = await import("sequelize");
        const count = await XtreamCache.destroy({
          where: prefix ? { key: { [Op.like]: `${prefix}%` } } : {},
        });
        return { success: true, message: `Cleared ${count} xtream cache entries.` };
      } catch (err) {
        logger.error({ err }, "Error clearing xtream cache");
        return h
          .response({ success: false, error: "Failed to clear xtream cache." })
          .code(500);
      }
    },
  },

  {
    method: "DELETE",
    path: "/api/v2/clear-content-cache",
    handler: async (_request, h) => {
      try {
        const count = await ContentCache.destroy({ where: {} });
        return { success: true, message: `Cleared ${count} content cache entries.` };
      } catch (err) {
        logger.error({ err }, "Error clearing content cache");
        return h
          .response({ success: false, error: "Failed to clear content cache." })
          .code(500);
      }
    },
  },

  {
    method: "GET",
    path: "/api/v2/subtitles/search",
    handler: async (request, h) => {
      try {
        const { title, year, season, episode, lang } = request.query as {
          title?: string;
          year?: string;
          season?: string;
          episode?: string;
          lang?: string;
        };
        if (!title) return h.response({ error: "Missing title" }).code(400);

        const results = await searchSubtitles({
          title,
          year,
          season: season ? Number(season) : undefined,
          episode: episode ? Number(episode) : undefined,
          language: lang,
        });
        return { success: true, results };
      } catch (err) {
        logger.error({ err }, "Subtitle search error");
        return h.response({ success: false, error: "Subtitle search failed." }).code(500);
      }
    },
  },

  {
    method: "GET",
    path: "/api/v2/subtitles/download",
    handler: async (request, h) => {
      try {
        const { fileId } = request.query as { fileId?: string };
        if (!fileId) return h.response({ error: "Missing fileId" }).code(400);

        // Draws from the caller's own linked OpenSubtitles quota when they
        // have one (see [[skill-user-system]] / opensubtitles.ts), falling
        // back to the shared API-key-only pool otherwise.
        const userPayload = authCheck(request);
        const link = await resolveSubtitleDownloadUrl(Number(fileId), userPayload?.userId);
        if (!link) return h.response({ error: "Failed to resolve subtitle download link" }).code(502);

        const response = await axios({
          method: "get",
          url: link,
          responseType: "text",
          validateStatus: () => true,
        });

        // The player renders subtitle tracks via a plain HTML <track> element, which only
        // understands WebVTT — not SRT (different timestamp separator: "," vs "."). OpenSubtitles
        // only serves .srt, so convert it here rather than touching the player's track handling.
        const vtt = "WEBVTT\n\n" + String(response.data).replace(
          /(\d{2}:\d{2}:\d{2}),(\d{3})/g,
          "$1.$2",
        );

        return h.response(vtt)
          .header("Content-Type", "text/vtt; charset=utf-8")
          .code(response.status);
      } catch (err) {
        logger.error({ err }, "Subtitle download error");
        return h.response({ success: false, error: "Subtitle download failed." }).code(500);
      }
    },
  },

  {
    method: "GET",
    path: "/api/v2/download",
    handler: async (request, h) => {
      try {
        // Can't require a Bearer header here — this URL is opened via
        // `window.open`, a plain navigation. So the target (id/series/cmd/
        // path) is resolved from a server-minted token instead of trusting
        // client-supplied query params directly, see mintDownloadToken above.
        const entry = streamTokenFromRequest(request);
        if (!entry) return h.response({ error: "Unauthorized" }).code(401);
        let downloadPayload: DownloadPayload;
        try {
          downloadPayload = JSON.parse(entry.resource);
        } catch {
          return h.response({ error: "Invalid token" }).code(400);
        }
        const { id, series, cmd, path } = downloadPayload;
        const isSeries = downloadPayload.isSeries ? "1" : undefined;
        const title = downloadPayload.title;

        // Sanitize the title for use as a filename (strip path-unsafe characters), falling
        // back to `movie_<id>`/`episode_<id>` when no title was supplied.
        const buildFilename = (isSeriesFlag: boolean, ext: string) => {
          const safeTitle = title ? title.replace(/[<>:"/\\|?*\x00-\x1f]/g, "").trim() : "";
          const base = safeTitle || `${isSeriesFlag ? "episode" : "movie"}_${id}`;
          return `${base}.${ext}`;
        };

        const provider = serverManager.getProvider();

        // If direct resolution parameters are provided
        if (id) {
          const isSeriesBoolTop = isSeries === "1" || isSeries === "true";

          if (initialConfig.providerType === "stalker") {
            const stalker = provider as any;
            let token = stalker.cache.get("auth_token");
            if (!token) {
              token = await stalker.getToken(false);
            }

            const isSeriesBool = isSeries === "1" || isSeries === "true";

            // The frontend's `cmd` may be an already-resolved external CDN URL cached from
            // whenever this item was last listed — its token/session is often long expired
            // by the time "download" is clicked. create_link needs an internal path/id, not
            // a stale external link, so only forward `cmd` here if it isn't one; otherwise
            // let the portal derive its own (fresh) cmd from `id`.
            const internalCmd = cmd && !/^https?:\/\//i.test(cmd) ? cmd : undefined;

            // Try download mode (download=1)
            let linkData: any;
            if (isSeriesBool) {
              linkData = await stalker.getSeriesLink({
                series: series || "0",
                id: Number(id),
                download: 1,
                cmd: internalCmd,
              });
            } else {
              linkData = await stalker.getMovieLink({
                series: series || "0",
                id: Number(id),
                download: 1,
                cmd: internalCmd,
              });
            }

            let resolvedUrl = linkData?.js?.cmd || linkData?.cmd;
            if (resolvedUrl) {
              resolvedUrl = resolveStalkerUrl(stalker, resolvedUrl);
            }

            // If we got a valid download link, let's request it
            if (resolvedUrl && !resolvedUrl.includes("error=nothing_to_play") && !(linkData?.js?.error === "nothing_to_play")) {
              const config = stalker._getAxiosRequestConfig({}, token || "");
              
              // Validate that get_download_link.php doesn't return 404
              const validateRes = await axios({
                method: "get",
                url: resolvedUrl,
                headers: config.headers,
                params: config.params,
                validateStatus: () => true,
              });

              // If it's valid, request stream proxy
              if (validateRes.status === 200 || validateRes.status === 206) {
                // If it returned nothing_to_play in data, skip to play fallback
                const dataStr = typeof validateRes.data === "string" ? validateRes.data : JSON.stringify(validateRes.data);
                if (!dataStr.includes("nothing_to_play")) {
                  if (resolvedUrl.includes(".m3u8")) {
                    // HLS-backed VOD: the playlist alone isn't a playable file, so stream every
                    // media segment through in order, one at a time, without buffering server-side.
                    const segmentUrls = await resolveHlsSegmentUrls(resolvedUrl, config.headers, config.params);
                    const filename = buildFilename(isSeriesBool, "ts");
                    return h.response(Readable.from(streamHlsSegments(segmentUrls, config.headers, config.params), { objectMode: false }))
                      .header("Content-Type", "video/mp2t")
                      .header("Content-Disposition", `attachment; filename="${filename}"`)
                      .code(200);
                  }

                  const response = await axios({
                    method: "get",
                    url: resolvedUrl,
                    headers: config.headers,
                    params: config.params,
                    responseType: "stream",
                    validateStatus: () => true,
                  });

                  const proxyResponse = h.response(response.data);
                  // Deliberately exclude content-disposition from the upstream
                  // copy — the portal's own filename is often just a
                  // quality/language descriptor (e.g. "Hindi / Excellent
                  // quality (1080)"), not the real title. Always set our own
                  // below, built from `title`.
                  const headersToCopy = ["content-type", "content-length", "accept-ranges", "content-range"];
                  for (const [key, value] of Object.entries(response.headers)) {
                    if (value && headersToCopy.includes(key.toLowerCase())) {
                      proxyResponse.header(key, value.toString());
                    }
                  }
                  const urlExt = resolvedUrl.split("?")[0].split(".").pop();
                  const ext = urlExt && urlExt.length <= 4 ? urlExt : "mp4";
                  proxyResponse.header("Content-Disposition", `attachment; filename="${buildFilename(isSeriesBool, ext)}"`);
                  proxyResponse.code(response.status);
                  return proxyResponse;
                }
              }
            }

            // Fallback: Try play mode (download=0)
            let playLinkData: any;
            if (isSeriesBool) {
              playLinkData = await stalker.getSeriesLink({
                series: series || "0",
                id: Number(id),
                download: 0,
                cmd: internalCmd,
              });
            } else {
              playLinkData = await stalker.getMovieLink({
                series: series || "0",
                id: Number(id),
                download: 0,
                cmd: internalCmd,
              });
            }

            let playUrl = playLinkData?.js?.cmd || playLinkData?.cmd;
            if (playUrl) {
              playUrl = resolveStalkerUrl(stalker, playUrl);
            }
            if (playUrl) {
              const config = stalker._getAxiosRequestConfig({}, token || "");

              // If playUrl is an m3u8 playlist, stream its segments through in order instead of
              // saving the bare playlist (which isn't a playable file on its own).
              if (playUrl.includes(".m3u8") || playUrl.includes("index.m3u8")) {
                const segmentUrls = await resolveHlsSegmentUrls(playUrl, config.headers, config.params);
                const filename = buildFilename(isSeriesBool, "ts");
                return h.response(Readable.from(streamHlsSegments(segmentUrls, config.headers, config.params), { objectMode: false }))
                  .header("Content-Type", "video/mp2t")
                  .header("Content-Disposition", `attachment; filename="${filename}"`)
                  .code(200);
              } else {
                // Otherwise stream the play link direct file
                const response = await axios({
                  method: "get",
                  url: playUrl,
                  headers: config.headers,
                  params: config.params,
                  responseType: "stream",
                  validateStatus: () => true,
                });

                const proxyResponse = h.response(response.data);
                const headersToCopy = ["content-type", "content-length", "accept-ranges", "content-range"];
                for (const [key, value] of Object.entries(response.headers)) {
                  if (value && headersToCopy.includes(key.toLowerCase())) {
                    proxyResponse.header(key, value.toString());
                  }
                }
                const urlExt = playUrl.split("?")[0].split(".").pop();
                const ext = urlExt && urlExt.length <= 4 ? urlExt : "mp4";
                proxyResponse.header("Content-Disposition", `attachment; filename="${buildFilename(isSeriesBool, ext)}"`);
                proxyResponse.code(response.status);
                return proxyResponse;
              }
            }
            return h.response({ error: "Failed to resolve stream link for download" }).code(404);
          } else {
            // For Xtream and others
            let playUrl = "";
            if (path && path.startsWith("/")) {
              playUrl = `http://${initialConfig.hostname}:${initialConfig.port}${path}`;
            } else if (path) {
              playUrl = path;
            } else if (cmd) {
              playUrl = cmd;
            }
            if (playUrl) {
              const directHeaders = { "User-Agent": "VLC/3.0.16 LibVLC/3.0.16" };

              if (playUrl.includes(".m3u8")) {
                const segmentUrls = await resolveHlsSegmentUrls(playUrl, directHeaders, {});
                const filename = buildFilename(isSeriesBoolTop, "ts");
                return h.response(Readable.from(streamHlsSegments(segmentUrls, directHeaders, {}), { objectMode: false }))
                  .header("Content-Type", "video/mp2t")
                  .header("Content-Disposition", `attachment; filename="${filename}"`)
                  .code(200);
              }

              const response = await axios({
                method: "get",
                url: playUrl,
                headers: directHeaders,
                responseType: "stream",
                validateStatus: () => true,
              });

              const proxyResponse = h.response(response.data);
              const headersToCopy = ["content-type", "content-length", "accept-ranges", "content-range"];
              for (const [key, value] of Object.entries(response.headers)) {
                if (value && headersToCopy.includes(key.toLowerCase())) {
                  proxyResponse.header(key, value.toString());
                }
              }
              const urlExt = playUrl.split("?")[0].split(".").pop();
              const ext = urlExt && urlExt.length <= 4 ? urlExt : "mp4";
              proxyResponse.header("Content-Disposition", `attachment; filename="${buildFilename(isSeriesBoolTop, ext)}"`);
              proxyResponse.code(response.status);
              return proxyResponse;
            }
            return h.response({ error: "Failed to resolve playUrl" }).code(404);
          }
        }

        // Old path parameter fallback
        if (!path) {
          return h.response({ error: "Missing path or id parameter" }).code(400);
        }

        let targetUrl = path;
        let headers: Record<string, string> = {};
        let params: Record<string, any> = {};

        if (initialConfig.providerType === "stalker") {
          const stalker = provider as any;
          let token = stalker.cache.get("auth_token");
          if (!token) {
            token = await stalker.getToken(false);
          }

          if (path) {
            targetUrl = resolveStalkerUrl(stalker, path);
          }

          const config = stalker._getAxiosRequestConfig({}, token || "");
          headers = config.headers;
          params = config.params || {};
        } else {
          if (path.startsWith("/")) {
            targetUrl = `http://${initialConfig.hostname}:${initialConfig.port}${path}`;
          } else {
            // Reject arbitrary external URLs to prevent SSRF
            const parsed = new URL(path);
            if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
              return h.response({ error: "Invalid URL" }).code(400);
            }
            targetUrl = path;
          }
          headers = {
            "User-Agent": "VLC/3.0.16 LibVLC/3.0.16",
          };
        }

        const response = await axios({
          method: "get",
          url: targetUrl,
          headers: headers,
          params: params,
          responseType: "stream",
          validateStatus: () => true,
        });

        const proxyResponse = h.response(response.data);

        const headersToCopy = [
          "content-type",
          "content-length",
          "accept-ranges",
          "content-range",
        ];
        for (const [key, value] of Object.entries(response.headers)) {
          if (value && headersToCopy.includes(key.toLowerCase())) {
            proxyResponse.header(key, value.toString());
          }
        }
        const isSeriesFlag = isSeries === "1" || isSeries === "true";
        const urlExt = targetUrl.split("?")[0].split(".").pop();
        const ext = urlExt && urlExt.length <= 4 ? urlExt : "mp4";
        proxyResponse.header("Content-Disposition", `attachment; filename="${buildFilename(isSeriesFlag, ext)}"`);

        proxyResponse.code(response.status);
        return proxyResponse;
      } catch (error: any) {
        logger.error("Download proxy error: " + (error?.message ?? error));
        return h.response({ error: "Failed to proxy download", detail: error?.message ?? String(error) }).code(500);
      }
    },
  },

  {
    method: "GET",
    path: "/api/v2/playlist-download",
    handler: async (request, h) => {
      const { type } = request.query as { type?: string };
      const origin = getPublicOrigin(request);

      if (type === "vod") {
        const m3u = await getVodM3uV2(origin);
        return h.response(m3u)
          .type("application/vnd.apple.mpegurl")
          .header("Content-Disposition", 'attachment; filename="vod.m3u"');
      } else {
        const m3u = await getM3uV2(origin);
        return h.response(m3u)
          .type("application/vnd.apple.mpegurl")
          .header("Content-Disposition", 'attachment; filename="iptv.m3u"');
      }
    },
  },
];
