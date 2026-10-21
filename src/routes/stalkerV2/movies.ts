import { episodeLocation } from "@/content/episodeIndex";
import { catalogItem } from "@/content/catalogUnion";
import { withArtUrls } from "@/content/library/art";
import { localSearch } from "@/content/library/catalog";
import { withVersionLabels } from "@/content/versionLabel";
import { localEpisodeFile } from "@/content/library/catalog";
import { isLocalTitleId, isLocalFileId, localMovieCategory, localMoviesPage, localTitleFiles, localPlayLink } from "@/content/library/catalog";
import { LOCAL_CATEGORY } from "@/content/metaEnrichment";
import { unsealCmd } from "@/infra/sealedCmd";
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
import { peekCategoryList, putCategoryList } from "@/content/categoryLists";
import { withVideoInfo } from "@/content/mediaInfo";
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
  getHiddenGenreIds,
} from "@/content/overrides";
import { mintDownloadToken, DownloadPayload } from "@/services/downloadTokens";
import crypto from "crypto";
import { getEpgCache, fetchAndCacheEpg } from "@/content/epg";
import { getPublicOrigin } from "@/infra/publicUrl";
import { channelLogoPath, proxiedLogoPath } from "@/providers/portalAssets";
import { fetchMovieMeta, fetchTVMeta } from "@/content/tmdb";
import { pruneContentMeta } from "@/content/metaEnrichment";
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
  filterBySearch,
} from "./shared";
import { getCatalogUnion, applyOverridesToMatches } from "@/content/catalogUnion";
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
        // Local library (content/library): "My Library" first, when it has movies.
        const local = await localMovieCategory();
        const groups = [...(local ? [local] : []), ...(await applyGenreOverrides(channels, "movie"))];
        return {
          success: true,
          page: Number(1),
          pageAtaTime: Number(1),
          total_items: groups.length,
          actual_length: groups.length,
          total_loaded: groups.length,
          data: groups,
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
    method: "POST",
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
        let {
          category = 0,
          movieId = 0,
          seasonId = 0,
          episodeId = 0,
          page = 1,
          search = "",
        } = query;

        // Local library titles ("L<id>") and the My Library category (content/library/catalog.ts).
        if (isLocalTitleId(movieId)) {
          // An episode of a local show (the apps resolve the episode file this way).
          const resp = isLocalFileId(episodeId)
            ? await localEpisodeFile(String(movieId), String(episodeId))
            : await localTitleFiles(String(movieId));
          const origin = getPublicOrigin(request);
          return { ...resp, data: resp.data.map((d: any) => withArtUrls(d, origin)) };
        }
        if (String(category) === LOCAL_CATEGORY && !Number(movieId)) {
          const pageData = await localMoviesPage(Number(page) || 1, String(search || ""));
          pageData.data = await enrichArtworkFromTmdb(pageData.data, "movie", getPublicOrigin(request));
          return pageData;
        }

        if (category == 0 && movieId == 0) {
          return h.redirect("/api/v2/movie-groups");
        }

        // Discover's item-open flow (App.tsx openDiscoverItem) doesn't know which
        // real category a title lives in, so it always requests category="*" alongside
        // a specific movieId. The movieId===0 fast path below explicitly doesn't cover
        // this case, so without this resolution it falls all the way through to a live
        // portal call with category="*" — the exact full pagination scan the comment
        // there warns never completes under load. Resolve the real category from the
        // already-warmed per-category cache first so a Discover click hits the same
        // fast, cached path any other movie lookup does.
        if (Number(movieId) !== 0 && String(category) === "*") {
          // O(1) via the in-memory "*" catalog's id -> category map; the per-genre scan below
          // stays as the fallback for titles only present in a hidden genre.
          const union = await getCatalogUnion("movie", profileId);
          const known = union?.catOf.get(String(movieId));
          const groups = known ? [] : await readGenres("movie", profileId);
          if (known) category = known;
          for (const g of groups) {
            if (!g.id || g.id === "*") continue;
            const cached = await xtreamCache.get<any[]>(`vod_streams_${g.id}`);
            if (cached?.some((m: any) => String(m.stream_id) === String(movieId))) {
              category = g.id;
              break;
            }
          }
        }

        const itemsPerApiPage = 14;
        const startApiPage = Number(page);
        const cacheKey = generateCacheKey("movies", query);
        const getVodCache = (catId: string) =>
          xtreamCache.get<any[]>(`vod_streams_${catId}`).then((v) => v ?? []);

        // Prepared category list in memory (content/categoryLists.ts): a page is a slice.
        const categorySlot = `${profileId}:movie:${category}`;
        const categoryListKey = `vod_streams_${category}`;
        const pageFromList = async (list: any[]) => {
          const offset = (startApiPage - 1) * itemsPerApiPage;
          const pageData = list.slice(offset, offset + itemsPerApiPage);
          return {
            success: true,
            page: Number(page),
            pageAtaTime: 1,
            total_items: list.length,
            actual_length: itemsPerApiPage,
            total_loaded: pageData.length,
            data: await withVideoInfo(await enrichArtworkFromTmdb(pageData, "movie", getPublicOrigin(request)), profileId, "movie", (m: any) => m.stream_id ?? m.id),
            errors: false,
            isPortal: initialConfig.providerType === "stalker",
          };
        };
        if (!search && Number(movieId) === 0 && String(category) !== "*" && !String(category).startsWith("vcat_")) {
          const prepared = peekCategoryList(categorySlot, categoryListKey);
          if (prepared) return pageFromList(prepared);
        }

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
        //
        // category === "*" ("All Movies") is special: the warm cycle deliberately skips "*"
        // as a category, so treating it like any other category ID here means a real cache
        // miss — triggering a full from-scratch portal pagination scan. Every item it would
        // return is already sitting in the per-category DB cache from the regular warm cycle,
        // so build it by unioning those instead of ever touching the portal (same pattern the
        // Xtream player API already uses for its no-category "all" request in protocol.ts).
        if (Number(movieId) === 0 && String(category) === "*") {
          // In-memory union, rebuilt only when a category list or an override changed (see
          // content/catalogUnion.ts); a page is O(page) instead of re-reading ~85k items.
          const union = await getCatalogUnion("movie", profileId);
          if (union) {
            // Search also finds local-library titles, listed first (content/library/catalog.ts).
            const list = search
              ? [...(await localSearch("movie", String(search))), ...(await applyOverridesToMatches("movie", filterBySearch(union.raw, search, `movie:${category}`)))]
              : union.browse;
            const offset = (startApiPage - 1) * itemsPerApiPage;
            const pageData = list.slice(offset, offset + itemsPerApiPage).map((m: any) => ({
              ...m,
              id: String(m.stream_id),
              screenshot_uri: m.screenshot_uri || m.stream_icon || "",
            }));
            // Search results carry the version picker's label (content/versionLabel.ts).
            const labelled = search ? await withVersionLabels(pageData, "movie", profileId) : pageData;
            const responsePayload = {
              success: true,
              page: Number(page),
              pageAtaTime: 1,
              total_items: list.length,
              actual_length: itemsPerApiPage,
              total_loaded: pageData.length,
              data: await withVideoInfo(await enrichArtworkFromTmdb(labelled, "movie", getPublicOrigin(request)), profileId, "movie", (m: any) => m.stream_id ?? m.id),
              errors: false,
              isPortal: initialConfig.providerType === "stalker",
            };
            // No ContentCache write: the union lives in memory, a page is O(page).
            return responsePayload;
          }
        }

        if (Number(movieId) === 0) {
          // getOrRefreshVodStreams() does a live full portal fetch on a cache
          // miss — fine for normal browsing, but search must never touch the
          // portal, so it reads whatever is already warmed and nothing more.
          const cachedMovies = search
            ? await xtreamCache.get<any[]>(`vod_streams_${category}`)
            : await getOrRefreshVodStreams(String(category));
          if (cachedMovies && cachedMovies.length > 0) {
            // Items cached before screenshot_uri/description/etc. were added to mapVodItem
            // only have the older Xtream-shaped fields — stream_icon is already a complete,
            // working image URL (same one Xtream players render), so fall back to it instead
            // of requiring every old cache entry to be rebuilt from the portal.
            const allNormalized = filterBySearch(cachedMovies, search, `movie:${category}`)
              .map((m: any) => ({
                ...m,
                id: String(m.stream_id),
                screenshot_uri: m.screenshot_uri || m.stream_icon || "",
              }));
            const allOverridden = await applyPortalItemOverrides(allNormalized, "movie", String(category), getVodCache, { searching: !!search });
            if (!search) putCategoryList(categorySlot, categoryListKey, allOverridden);
            return pageFromList(allOverridden);
          }

          // Browsing/search never talks to the portal directly — only actual
          // stream playback is allowed to reach it. If nothing is cached yet
          // for this category, return an empty page instead of falling
          // through to a live portal call below.
          if (search) {
            return {
              success: true,
              page: Number(page),
              pageAtaTime: 1,
              total_items: 0,
              actual_length: itemsPerApiPage,
              total_loaded: 0,
              data: [],
              errors: false,
              isPortal: initialConfig.providerType === "stalker",
            };
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
          firstPageData = firstPageData.filter((item: any) => item[seriesFlag()] != 1);
        }

        // A direct movieId lookup (not a season/episode drill-down) that came
        // back empty means the portal no longer has this stream at all — the
        // catalog entry it was resolved from (e.g. Discover's ContentMeta row)
        // is stale. Prune it so it stops showing up in Discover/search instead
        // of surfacing this same "could not load" failure every time someone
        // clicks it. Fire-and-forget — must not delay/break the response the
        // client is waiting on for this already-failed lookup.
        if (Number(movieId) !== 0 && !seasonId && !episodeId && firstPageData.length === 0) {
          pruneContentMeta(`movie_${movieId}`, String(category)).catch((e) =>
            logger.error({ err: e }, `[MetaEnrich] prune failed for movie_${movieId}`)
          );
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
          data: await enrichArtworkFromTmdb(overriddenMovieData, "movie", getPublicOrigin(request)),
          errors: false,
          isPortal: initialConfig.providerType === "stalker",
        };

        // Never cache an empty page: right after a profile switch or restart the per-category
        // warm hasn't run yet, and caching that empty "All" page hid the whole catalog from
        // every client for CACHE_DURATION_MS (found 2026-10-18).
        if (!search && res?.js && firstPageData.length > 0) {
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
        } = request.query;
        // A local-library file ("LF<id>"): a stream token for the file id, never a path.
        if (isLocalFileId(id)) {
          const userLabel = streamUserLabel(request);
          if (!userLabel) return h.response({ error: "Unauthorized" }).code(401);
          const link = await localPlayLink(String(id), userLabel, (request.query as any).title, (request.query as any).client);
          if (!link) return h.response({ error: "This file is no longer in the library" }).code(404);
          return { js: { cmd: link } };
        }

        // A sealed upstream link (infra/sealedCmd.ts) is opened here; never echoed back.
        const cmd = unsealCmd(request.query.cmd) || undefined;
        const { title, category } = request.query as { title?: string; category?: string };
        const isSeries =
          series && series !== "0" && series !== "false" && series !== "";

        // Some clients (e.g. ImPlayer) never send `title` on this request — without a
        // fallback, StreamTracker sessions for them end up with a null label and the
        // admin panel falls back to displaying the raw resource path, which for this
        // portal happens to be a quality/language variant name like "Hindi / Ultra High
        // Quality" (a directory segment in the upstream URL, not a real title).
        let effectiveTitle = title;
        let effectiveCategory = category;
        if ((!effectiveTitle || !effectiveCategory) && id) {
          if (!isSeries) {
            // Unambiguous: `id` is the same stream_id mapVodItem cached under
            // `vod_info_${id}` during the normal catalog warm.
            const item = await catalogItem("movie", String(id), await getActiveProfileId());
            effectiveTitle = effectiveTitle || item?.name || undefined;
            effectiveCategory = effectiveCategory || item?.genres_str || undefined;
          } else {
            // Stalker sometimes has every episode in a season share the SAME `id`
            // (the season pack's own catalog id), with `series` as the only thing
            // distinguishing which episode — so `id` alone isn't trustworthy here.
            // `ep_info_${id}` (populated during the normal series-info warm) records
            // which episode number that id was last seen representing; only trust it
            // if it matches the `series` value THIS request actually sent. If they
            // disagree, `id` is shared across episodes and we can't tell which one
            // this is — skip the fallback rather than risk labeling the wrong episode.
            const epInfo = await episodeLocation(String(id));
            if (epInfo && String(epInfo.episode) === String(series)) {
              const seriesInfo = await xtreamCache.get<any>(`series_info_${epInfo.seriesId}`);
              // Episodes are stored per season number: look the id up in every season (the
              // old lookup used the portal's season id as the key, so it never matched).
              const allEpisodes = Object.values(seriesInfo?.episodes || {}).flat() as any[];
              const epEntry = allEpisodes.find((e: any) => String(e?.id) === String(id));
              if (!effectiveTitle && seriesInfo?.info?.name && epEntry?.title) {
                effectiveTitle = `${seriesInfo.info.name} - ${epEntry.title}`;
              }
              effectiveCategory = effectiveCategory || seriesInfo?.info?.genre || undefined;
            }
          }
        }

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
              { path: rawUrl, isSeries: Boolean(isSeries), title: effectiveTitle as string | undefined },
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
          // Broken-stream identity (src/services/StreamFailures.ts). `id` here
          // is the FILE id; newer clients also send the LIST item id they
          // browse by (`itemId`) + `itemType`, which is what an auto-hide
          // must key on. Older clients don't — fall back to the file id, and
          // only allow auto-hide when that fallback is verifiably a real
          // movie list id (vod_info_<id> is cached per list item by the warm).
          const { itemId: qItemId, itemType: qItemType } = request.query as { itemId?: string; itemType?: string };
          const itemType: "movie" | "episode" =
            qItemType === "movie" || qItemType === "episode" ? qItemType : isSeries ? "episode" : "movie";
          const itemId = qItemId ? String(qItemId) : String(id);
          let hideable = !!qItemId;
          if (!qItemId && itemType === "movie" && id) {
            hideable = !!(await catalogItem("movie", String(id), await getActiveProfileId()).catch(() => null));
          }
          const tokenizedUrl = proxyUrlFor(rawUrl, userLabel, {
            kind: isSeries ? "series" : "movie",
            label: effectiveTitle,
            category: effectiveCategory,
            itemType,
            itemId,
            profileId: await getActiveProfileId(),
            hideable,
            resolve: { id: String(id), series: String(series ?? ""), ...(cmd ? { cmd: String(cmd) } : {}) },
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
