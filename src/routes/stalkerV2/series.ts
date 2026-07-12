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
export const seriesRoutes: ServerRoute[] = [
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

];
