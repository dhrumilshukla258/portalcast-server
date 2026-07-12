import { ServerRoute } from "@hapi/hapi";
import {
  writeJSON,
  readChannels,
  writeChannels,
  readGenres,
  writeGenres,
  upsertGenres,
} from "@/infra/storage";
import { initialConfig, seriesFlag } from "@/config/server";
import { serverManager } from "@/serverManager";
import axios from "axios";
import { ConfigProfile } from "@/models/ConfigProfile";
import { ContentCache } from "@/models/ContentCache";
import { stalkerApi } from "@/providers/stalker";
import { Readable } from "stream";
import { XtreamCache } from "@/models/XtreamCache";
import { ContentOverride } from "@/models/ContentOverride";
import { warmVodCache, warmSeriesCache, warmSeriesInfoCache, cleanupGenres, catchupScan, xtreamCache, getOrRefreshVodStreams, getOrRefreshSeriesList } from "@/services/xtreamCache";
import { logger } from "@/infra/logger";
import { authCheck } from "@/auth/jwt";
import { mintStreamToken, proxyUrlFor, streamTokenFromRequest } from "@/services/StreamTokens";
import {
  applyGenreOverrides,
  applyChannelOverrides,
  applyPortalItemOverrides,
} from "@/content/overrides";
import { mintDownloadToken, DownloadPayload } from "@/services/downloadTokens";
import crypto from "crypto";
import { getEpgCache, fetchAndCacheEpg } from "@/content/epg";
import { getPublicOrigin } from "@/infra/publicUrl";
import { getM3uV2, getVodM3uV2 } from "@/providers/getM3uUrls";
import { channelLogoPath, proxiedLogoPath } from "@/providers/portalAssets";
import { fetchMovieMeta, fetchTVMeta } from "@/content/tmdb";
import { searchSubtitles, resolveSubtitleDownloadUrl } from "@/content/opensubtitles";
import {
  streamUserLabel,
  CACHE_DURATION_MS,
  resolveStalkerUrl,
  resolveHlsSegmentUrls,
  streamHlsSegments,
  enrichArtworkFromTmdb,
  getActiveProfileId,
  generateCacheKey,
  mapChannel,
} from "./shared";
export const movieRoutes: ServerRoute[] = [
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

];
