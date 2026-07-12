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
export const maintenanceRoutes: ServerRoute[] = [
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
    method: "POST",
    path: "/api/v2/catchup-scan",
    handler: async (_request, h) => {
      catchupScan().catch((e) => logger.error(`[catchup-scan] ${e}`));
      return h.response({ success: true, message: "Catch-up scan started in background." });
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


];
