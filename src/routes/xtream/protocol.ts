import { ServerRoute } from "@hapi/hapi";
import { serverManager } from "@/serverManager";
import { logger } from "@/infra/logger";
import { initialConfig, seriesFlag } from "@/config/server";
import { getPublicProto, getPublicHost, getPublicOrigin } from "@/infra/publicUrl";
import { proxiedLogoPath } from "@/providers/portalAssets";
import { readGenres, readChannels } from "@/infra/storage";
import {
  applyXtreamCatOverrides,
  applyXtreamChannelOverrides,
  applyVodOverrides,
  applySeriesOverrides,
  getHiddenGenreIds,
} from "@/content/overrides";
import { getEpgCache } from "@/content/epg";
import { fetchMovieMeta, fetchTVMeta, TmdbMeta } from "@/content/tmdb";
import {
  xtreamCache,
  getVodVersion,
  addVer,
  stripVer,
  mapVodItem,
  getOrRefreshVodStreams,
  getOrRefreshSeriesList,
  fetchAllPages,
  buildIconUrl,
} from "@/services/xtreamCache";
import { generateStreamToken, resolveXtreamUser } from "@/services/xtreamAuth";

function userInfo(username: string, streamToken: string) {
  return {
    username,
    password: streamToken, // players use this value in all subsequent stream URLs
    message:                "Welcome",
    auth:                   1,
    status:                 "Active",
    exp_date:               "9999999999",
    is_trial:               "0",
    active_cons:            "0",
    created_at:             "0",
    max_connections:        "10",
    allowed_output_formats: ["m3u8"],
  };
}

function serverInfo(request: any) {
  const proto = getPublicProto(request);
  const publicHost = getPublicHost(request);
  const host = publicHost.split(":")[0] || "localhost";
  // No explicit port means the client used the protocol default (reverse proxy)
  const port = publicHost.split(":")[1] || (proto === "https" ? "443" : "80");
  return {
    url:             host,
    port:            port,
    https_port:      proto === "https" ? port : "443",
    server_protocol: proto,
    rtmp_port:       port,
    timezone:        "UTC",
    timestamp_now:   Math.floor(Date.now() / 1000),
    time_now:        new Date().toISOString().replace("T", " ").slice(0, 19),
  };
}

export const protocolRoutes: ServerRoute[] = [

  {
    method: "GET",
    path: "/xmltv.php",
    handler: async (request, h) => {
      const { username, password } = request.query as Record<string, string>;
      if (!await resolveXtreamUser(username, password)) {
        return h.response({ user_info: { auth: 0 } }).code(401);
      }
      const epgCache = await getEpgCache();
      const channels = await readChannels();

      const escXml = (s: string) => s
        .replace(/&/g, "&amp;").replace(/</g, "&lt;")
        .replace(/>/g, "&gt;").replace(/"/g, "&quot;");

      const fmtTime = (ts: string) => {
        const d = new Date(Number(ts) * 1000);
        const p = (n: number) => String(n).padStart(2, "0");
        return `${d.getUTCFullYear()}${p(d.getUTCMonth()+1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())} +0000`;
      };

      let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<tv generator-info-name="Portalcast">\n';

      for (const ch of channels) {
        xml += `  <channel id="${ch.id}"><display-name>${escXml(ch.name)}</display-name></channel>\n`;
      }

      if (epgCache?.data) {
        for (const [channelId, programs] of Object.entries(epgCache.data as Record<string, any[]>)) {
          for (const p of programs) {
            xml += `  <programme start="${fmtTime(p.start_timestamp)}" stop="${fmtTime(p.stop_timestamp)}" channel="${channelId}"><title>${escXml(p.name)}</title></programme>\n`;
          }
        }
      }

      xml += "</tv>";
      return h.response(xml).type("application/xml").header("Cache-Control", "no-cache");
    },
  },

  {
    method: "GET",
    path: "/player_api.php",
    handler: async (request, h) => {
      const { action, username, password } = request.query as Record<string, string>;
      const xtreamUser = await resolveXtreamUser(username, password);
      if (!xtreamUser) {
        return h.response({ user_info: { auth: 0 } }).code(401);
      }
      const provider = serverManager.getProvider();

      // Issue a 30-day stream token for DB users so their real password is never
      // embedded in stream URLs. Env-var-only admin has no numeric id, so we
      // fall back to the raw password (credentials-in-URL still apply for them).
      const streamToken = xtreamUser.id ? generateStreamToken(xtreamUser.id) : password;

      if (!action) {
        return h.response({
          user_info:   userInfo(username, streamToken),
          server_info: serverInfo(request),
        });
      }

      try {

        // ── Live ────────────────────────────────────────────────────────────

        if (action === "get_live_categories") {
          let raw: any[];
          const cached = await xtreamCache.get<any[]>("live_cats");
          if (cached) {
            raw = cached;
          } else {
            const genres = await readGenres("channel");
            raw = genres
              .filter((g: any) => g.id && g.id !== "*")
              .map((g: any) => ({
                category_id:   g.id,
                category_name: g.title,
                parent_id:     0,
              }));
            await xtreamCache.set("live_cats", raw);
          }
          return h.response(await applyXtreamCatOverrides(raw, "channel"));
        }

        if (action === "get_live_streams") {
          const { category_id } = request.query as Record<string, string>;
          const cacheKey = `live_streams_${category_id || "all"}`;
          let raw: any[];
          const cached = await xtreamCache.get<any[]>(cacheKey);
          if (cached) {
            raw = cached;
          } else {
            const data     = await provider.getChannels();
            const channels = data?.js?.data || [];
            const filtered = category_id
              ? channels.filter((c: any) => c.tv_genre_id === category_id)
              : channels;
            raw = filtered.map((c: any, idx: number) => ({
              num:                 idx + 1,
              name:                c.name?.trim(),
              stream_type:         "live",
              stream_id:           c.id,
              // Stored as a relative /api/images path; absolutized per request below
              stream_icon:         proxiedLogoPath(c.logo),
              epg_channel_id:      c.id,
              added:               "",
              category_id:         c.tv_genre_id || "0",
              tv_archive:          0,
              tv_archive_duration: 0,
              direct_source:       "",
            }));
            await xtreamCache.set(cacheKey, raw);
          }
          const origin = getPublicOrigin(request);
          const portalPrefix = `${initialConfig.https ? "https" : "http"}://${initialConfig.hostname}:${initialConfig.port}`;
          const fixIcon = (icon: any): any => {
            if (typeof icon !== "string" || icon === "") return icon;
            // New format: relative /api/images path — absolutize per request
            if (icon.startsWith("/")) return `${origin}${icon}`;
            // Legacy cached format: portal prefix + raw logo value (often malformed
            // for bare filenames) — recover the logo and rebuild the proxied path
            if (icon.startsWith(portalPrefix)) {
              const rawLogo = icon.slice(portalPrefix.length).replace(/^\//, "");
              return `${origin}${proxiedLogoPath(rawLogo)}`;
            }
            return icon; // external absolute URL — leave as-is
          };
          const withIcons = (await applyXtreamChannelOverrides(raw)).map((c: any) => ({
            ...c,
            stream_icon: fixIcon(c.stream_icon),
          }));
          return h.response(withIcons);
        }

        // ── VOD ─────────────────────────────────────────────────────────────

        if (action === "get_vod_categories") {
          let raw: any[];
          const cached = await xtreamCache.get<any[]>("vod_cats");
          if (cached) {
            raw = cached;
          } else {
            const genres = await readGenres("movie");
            raw = genres
              .filter((g: any) => g.id && g.id !== "*")
              .map((g: any) => ({
                category_id:   g.id,
                category_name: g.title,
                parent_id:     0,
              }));
            await xtreamCache.set("vod_cats", raw);
          }
          const vodCats = await applyXtreamCatOverrides(raw, "movie");
          const v = await getVodVersion();
          logger.info(`[player_api] get_vod_categories — version=${v} count=${vodCats.length}`);
          return h.response(vodCats.map((c: any) => ({ ...c, category_id: addVer(c.category_id, v) })));
        }

        if (action === "get_vod_streams") {
          const { category_id: rawCatId, search } = request.query as Record<string, string>;
          const category_id = rawCatId ? stripVer(rawCatId) : rawCatId;
          logger.info(`[player_api] get_vod_streams request — raw_category_id=${rawCatId ?? "(none)"} stripped=${category_id ?? "(none)"} search=${search ?? "(none)"}`);
          const getVodCache = (catId: string) =>
            xtreamCache.get<any[]>(`vod_streams_${catId}`).then((v) => v ?? []);
          let rawResult: any[];

          if (search) {
            const genres = await readGenres("movie");
            const hiddenIds = await getHiddenGenreIds("movie");
            const visibleIds = genres
              .filter((g) => g.id && g.id !== "*" && !hiddenIds.has(String(g.id)))
              .map((g) => `vod_streams_${g.id}`);
            const cachedByKey = await xtreamCache.getMany<any[]>(visibleIds);
            const all: any[] = [];
            for (const key of visibleIds) { const cached = cachedByKey.get(key); if (cached) all.push(...cached); }
            const term = search.toLowerCase();
            rawResult = all.filter((m: any) => m.name?.toLowerCase().includes(term));
            logger.info(`[player_api] get_vod_streams search="${search}": ${rawResult.length}`);
          } else if (!category_id) {
            const genres = await readGenres("movie");
            const hiddenIds = await getHiddenGenreIds("movie");
            const visibleIds = genres
              .filter((g) => g.id && g.id !== "*" && !hiddenIds.has(String(g.id)))
              .map((g) => `vod_streams_${g.id}`);
            const cachedByKey = await xtreamCache.getMany<any[]>(visibleIds);
            const all: any[] = [];
            for (const key of visibleIds) { const cached = cachedByKey.get(key); if (cached) all.push(...cached); }
            rawResult = all;
            logger.info(`[player_api] get_vod_streams (all): ${all.length} movies`);
          } else if (category_id.startsWith("vcat_")) {
            rawResult = [];
          } else {
            rawResult = await getOrRefreshVodStreams(category_id);
          }

          const vodOverridden = await applyVodOverrides(rawResult, category_id ?? null, getVodCache);
          const vv = await getVodVersion();
          const finalResult = vodOverridden.map((item: any) => ({ ...item, category_id: addVer(item.category_id, vv) }));
          return h.response(finalResult);
        }

        if (action === "get_vod_info") {
          const { vod_id } = request.query as Record<string, string>;
          if (!vod_id) return h.response({ info: {}, movie_data: {} });
          const cacheKey = `vod_info_${vod_id}`;
          let cached = await xtreamCache.get<any>(cacheKey);

          if (!cached) {
            const data = await provider.getMovies({ category: "*", page: 1, movieId: parseInt(vod_id) });
            const item = data?.js?.data?.[0] as any;
            if (!item) return h.response({ info: {}, movie_data: {} });
            mapVodItem(item, 1, item.category_id || "0");
            cached = await xtreamCache.get<any>(cacheKey);
          }

          if (!cached) return h.response({ info: {}, movie_data: {} });

          const tmdbKey = `tmdb_movie_${vod_id}`;
          let tmdb = await xtreamCache.get<TmdbMeta | { _not_found: true }>(tmdbKey);
          if (!tmdb) {
            const name = cached.movie_data?.name || cached.info?.name || "";
            const year = cached.info?.releasedate || "";
            const meta = await fetchMovieMeta(name, year);
            tmdb = meta ?? { _not_found: true };
            await xtreamCache.set(tmdbKey, tmdb);
          }

          if (tmdb && !("_not_found" in tmdb)) {
            return h.response({
              ...cached,
              info: {
                ...cached.info,
                cover_big:     tmdb.poster   ?? cached.info?.cover_big,
                movie_image:   tmdb.poster   ?? cached.info?.movie_image,
                backdrop_path: tmdb.backdrop ? [tmdb.backdrop] : (cached.info?.backdrop_path ?? []),
                plot:          cached.info?.plot || tmdb.overview,
                cast:          cached.info?.cast || tmdb.cast,
                director:      cached.info?.director || tmdb.director,
              },
            });
          }
          return h.response(cached);
        }

        // ── Series ───────────────────────────────────────────────────────────

        if (action === "get_series_categories") {
          let raw: any[];
          const cached = await xtreamCache.get<any[]>("series_cats");
          if (cached) {
            raw = cached;
          } else {
            const genres = await readGenres("series");
            raw = genres
              .filter((g: any) => g.id && g.id !== "*")
              .map((g: any) => ({
                category_id:   g.id,
                category_name: g.title,
                parent_id:     0,
              }));
            await xtreamCache.set("series_cats", raw);
          }
          const seriesCats = await applyXtreamCatOverrides(raw, "series");
          const vs = await getVodVersion();
          return h.response(seriesCats.map((c: any) => ({ ...c, category_id: addVer(c.category_id, vs) })));
        }

        if (action === "get_series") {
          const { category_id: rawSeriesCatId, search } = request.query as Record<string, string>;
          const category_id = rawSeriesCatId ? stripVer(rawSeriesCatId) : rawSeriesCatId;
          const getSeriesCache = (catId: string) =>
            xtreamCache.get<any[]>(`series_list_${catId}`).then((v) => v ?? []);
          let rawResult: any[];

          if (search) {
            const genres = await readGenres("series");
            const hiddenIds = await getHiddenGenreIds("series");
            const visibleIds = genres
              .filter((g) => g.id && g.id !== "*" && !hiddenIds.has(String(g.id)))
              .map((g) => `series_list_${g.id}`);
            const cachedByKey = await xtreamCache.getMany<any[]>(visibleIds);
            const all: any[] = [];
            for (const key of visibleIds) { const cached = cachedByKey.get(key); if (cached) all.push(...cached); }
            const term = search.toLowerCase();
            rawResult = all.filter((s: any) => s.name?.toLowerCase().includes(term));
            logger.info(`[player_api] get_series search="${search}": ${rawResult.length}`);
          } else if (!category_id) {
            const genres = await readGenres("series");
            const hiddenIds = await getHiddenGenreIds("series");
            const visibleIds = genres
              .filter((g) => g.id && g.id !== "*" && !hiddenIds.has(String(g.id)))
              .map((g) => `series_list_${g.id}`);
            const cachedByKey = await xtreamCache.getMany<any[]>(visibleIds);
            const all: any[] = [];
            for (const key of visibleIds) { const cached = cachedByKey.get(key); if (cached) all.push(...cached); }
            rawResult = all;
            logger.info(`[player_api] get_series (all): ${all.length} series`);
          } else if (category_id.startsWith("vcat_")) {
            rawResult = [];
          } else {
            rawResult = await getOrRefreshSeriesList(category_id);
          }

          const seriesOverridden = await applySeriesOverrides(rawResult, category_id ?? null, getSeriesCache);
          const vs = await getVodVersion();
          return h.response(
            seriesOverridden.map((item: any) => ({ ...item, category_id: addVer(item.category_id, vs) })),
          );
        }

        if (action === "get_series_info") {
          const { series_id } = request.query as Record<string, string>;
          if (!series_id) return h.response({ info: {}, episodes: {}, seasons: [] });

          const cacheKey = `series_info_${series_id}`;
          const { value: cached, isStale } = await xtreamCache.getWithStaleness<any>(cacheKey);
          if (cached) {
            // Backfill ep_info so stream handler works even on cache hit
            const c = cached as any;
            const seasonIdMap: Record<string, number> = {};
            for (const s of (c.seasons || [])) seasonIdMap[String(s.season_number)] = s.id;
            for (const [seasonNum, eps] of Object.entries(c.episodes || {})) {
              const seasonId = seasonIdMap[seasonNum];
              for (const ep of (eps as any[])) {
                xtreamCache.set(`ep_info_${ep.id}`, {
                  movieId:   parseInt(series_id),
                  seasonId,
                  seriesNum: ep.episode_num,
                });
              }
            }
            if (!isStale) return h.response(cached);
            // Stale — fall through to re-fetch
          }

          // Fetch seasons
          const seasonsData = await provider.getMovies({
            category: "*",
            page:     1,
            movieId:  parseInt(series_id),
          });
          const allItems  = (seasonsData?.js?.data || []) as any[];

          if (allItems.length === 0) {
            if (cached) {
              await xtreamCache.set(cacheKey, cached);
              return h.response(cached);
            }
            return h.response({ info: {}, episodes: {}, seasons: [] });
          }

          let seasons     = allItems.filter((s: any) => s.is_season);
          // Fallback: portal may not set is_season — detect by season_number/season_name
          if (seasons.length === 0) {
            const candidates = allItems.filter((s: any) => !s.is_episode && s.id);
            seasons = candidates.filter((s: any) => s.season_number || s.season_name);
          }
          const seriesItem = allItems.find((i: any) => i[seriesFlag]) || allItems[0];

          const episodesMap: Record<string, any[]> = {};

          for (const season of seasons) {
            const seasonNum   = String(season.season_number || "1");
            const seasonIdInt = parseInt(season.id);
            const seriesIdInt = parseInt(series_id);
            let allEps = await fetchAllPages(async (page) => {
              const r = await provider.getMovies({ category: "*", page, movieId: seriesIdInt, seasonId: seasonIdInt });
              return r?.js?.data || [];
            });
            // Fallback: some portals store episodes under type:"series" not type:"vod"
            if (allEps.length === 0) {
              allEps = await fetchAllPages(async (page) => {
                const r = await provider.getSeries({ category: "*", page, movieId: seriesIdInt, seasonId: seasonIdInt });
                return r?.js?.data || [];
              });
            }
            const episodes = allEps.filter((e: any) => e.is_episode);
            // Fallback: portal may not set is_episode flag — use all returned items
            const effectiveEps = episodes.length > 0 ? episodes : allEps;

            episodesMap[seasonNum] = effectiveEps.map((ep: any, idx: number) => {
              const epNum = parseInt(String(ep.series_number || (idx + 1)));
              // Cache full context so stream handler can mirror browser: getMovies(movieId,seasonId,episodeId) + getMovieLink
              xtreamCache.set(`ep_info_${ep.id}`, {
                movieId:   parseInt(series_id),
                seasonId:  parseInt(season.id),
                seriesNum: epNum,
              });
              if (ep.cmd) {
                xtreamCache.set(`ep_cmd_${ep.id}`, { cmd: ep.cmd, series_num: epNum });
              }
              return {
                id:                  ep.id,
                episode_num:         epNum,
                title:               ep.name || `Episode ${epNum}`,
                container_extension: "m3u8",
                info: {
                  season:        parseInt(seasonNum),
                  plot:          "",
                  duration_secs: 0,
                  rating:        0,
                  movie_image:   "",
                  releasedate:   ep.date_add || "",
                },
                direct_source: "",
              };
            });
          }

          const result = {
            info: {
              name:             seriesItem?.name || "",
              cover:            buildIconUrl(seriesItem?.screenshot_uri),
              plot:             seriesItem?.description || "",
              cast:             seriesItem?.actors || "",
              director:         seriesItem?.director || "",
              genre:            seriesItem?.genres_str || "",
              releaseDate:      seriesItem?.year || "",
              rating:           seriesItem?.rating_imdb || 0,
              backdrop_path:    [],
              youtube_trailer:  "",
              episode_run_time: "",
              category_id:      seriesItem?.category_id || "0",
            },
            episodes: episodesMap,
            seasons: seasons.map((s: any) => ({
              air_date:      s.date_add || "",
              episode_count: parseInt(s.season_series || 0),
              id:            parseInt(s.id),
              name:          s.season_name || `Season ${s.season_number}`,
              overview:      "",
              season_number: parseInt(s.season_number || 1),
              cover:         "",
              cover_big:     "",
            })),
          };

          await xtreamCache.set(cacheKey, result);

          const tmdbKey = `tmdb_tv_${series_id}`;
          let tmdb = await xtreamCache.get<TmdbMeta | { _not_found: true }>(tmdbKey);
          if (!tmdb) {
            const meta = await fetchTVMeta(result.info.name, result.info.releaseDate);
            tmdb = meta ?? { _not_found: true };
            await xtreamCache.set(tmdbKey, tmdb);
          }

          if (tmdb && !("_not_found" in tmdb)) {
            const enriched = {
              ...result,
              info: {
                ...result.info,
                cover:         tmdb.poster   ?? result.info.cover,
                backdrop_path: tmdb.backdrop ? [tmdb.backdrop] : (result.info.backdrop_path ?? []),
                plot:          tmdb.overview ?? result.info.plot,
              },
            };
            return h.response(enriched);
          }
          return h.response(result);
        }

        if (action === "get_short_epg" || action === "get_simple_data_table") {
          const { stream_id, limit = "4" } = request.query as Record<string, string>;
          if (!stream_id) return h.response({ epg_listings: [] });

          const epgCache = await getEpgCache();
          const programs: any[] = epgCache?.data?.[stream_id] || [];
          const now = Math.floor(Date.now() / 1000);
          const upcoming = programs
            .filter((p) => Number(p.stop_timestamp) > now)
            .slice(0, Number(limit));

          const listings = upcoming.map((p, i) => {
            const start = Number(p.start_timestamp);
            const stop  = Number(p.stop_timestamp);
            const dur   = stop - start;
            const h2    = String(Math.floor(dur / 3600)).padStart(2, "0");
            const m2    = String(Math.floor((dur % 3600) / 60)).padStart(2, "0");
            const s2    = String(dur % 60).padStart(2, "0");
            return {
              id:                  String(i + 1),
              epg_id:              stream_id,
              title:               Buffer.from(p.name || "").toString("base64"),
              lang:                "",
              start:               new Date(start * 1000).toISOString().replace("T", " ").slice(0, 19),
              end:                 new Date(stop  * 1000).toISOString().replace("T", " ").slice(0, 19),
              description:         Buffer.from("").toString("base64"),
              channel_id:          stream_id,
              start_timestamp:     start,
              stop_timestamp:      stop,
              now_playing:         (start <= now && stop > now) ? 1 : 0,
              has_archive:         0,
              duration_in_seconds: dur,
              duration:            `${h2}:${m2}:${s2}`,
              thumbnail:           "",
            };
          });

          return h.response({ epg_listings: listings });
        }

        return h.response([]);

      } catch (err: any) {
        logger.error(`[player_api] action=${action} error: ${err.message}`);
        return h.response({ error: err.message }).code(500);
      }
    },
  },
];
