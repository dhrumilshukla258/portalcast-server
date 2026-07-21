import { ServerRoute } from "@hapi/hapi";
import { Channel } from "@/models/Channel";
import { ConfigProfile } from "@/models/ConfigProfile";
import { liveStreamService } from "@/services/LiveStreamService";
import { serverManager } from "@/serverManager";
import { logger } from "@/infra/logger";
import { initialConfig, seriesFlag } from "@/config/server";
import { handleProxyStream } from "../streaming/proxy";
import { stalkerApi } from "@/providers/stalker";
import { cmdPlayerV2 } from "@/streaming/cmdPlayer";
import { streamTracker } from "@/services/StreamTracker";
import { proxyUrlFor } from "@/services/StreamTokens";
import { xtreamCache } from "@/services/xtreamCache";
import { resolveXtreamUser } from "@/services/xtreamAuth";

async function handleStalkerVodStream(request: any, h: any) {
  const { streamId: sid, episodeId } = request.params;
  const streamId = sid ?? episodeId;
  try {
    const provider = serverManager.getProvider();
    const data = await provider.getMovies({ category: "*", page: 1, movieId: parseInt(streamId) });
    const items: any[] = data?.js?.data || [];
    const playable = items
      .filter((m: any) => {
        const u = m.url || m.cmd;
        return u && (String(u).startsWith("http") || String(u).startsWith("ffrt "));
      })
      .sort((a: any, b: any) => parseInt(b.quality || 0) - parseInt(a.quality || 0));
    const item = playable[0];
    if (!item) {
      logger.error(`[VOD stream] ${streamId} no playable item found`);
      return h.response({ error: "Stream not found" }).code(404);
    }
    const link = await provider.getMovieLink({ series: "0", id: parseInt(String(item.id)), download: 0 });
    let url: string = link?.js?.cmd || (item.cmd || item.url) || "";
    if (url.startsWith("ffrt ")) url = url.slice(5);
    logger.info(`[VOD stream] ${streamId} portal_id=${item.id} → ${url}`);
    // `item` is whichever quality/language variant sorted first among possibly several
    // entries the portal returns under this movie_id — its own `.name` is frequently a
    // descriptor like "English / Excellent quality (1080)", not the movie's title. The
    // real title is already sitting in our own catalog cache under the movie's id.
    const vodInfo = await xtreamCache.get<any>(`vod_info_${streamId}`);
    const label = vodInfo?.info?.name || vodInfo?.movie_data?.name || item.name;
    const category = vodInfo?.info?.genre || undefined;
    return h.redirect(proxyUrlFor(url, `xtream:${request.params.username}`, { kind: "movie", label, category })).code(302);
  } catch (err: any) {
    logger.error(`[VOD stream] ${err.message}`);
    return h.response({ error: err.message }).code(500);
  }
}

async function handleStalkerSeriesStream(request: any, h: any) {
  const { streamId, episodeId } = request.params;
  const id = streamId ?? episodeId;
  try {
    const provider = serverManager.getProvider();
    let url: string | undefined;
    let label: string | undefined;
    let category: string | undefined;
    const epInfo = await xtreamCache.get<{ movieId: number; seasonId: number; seriesNum: number }>(`ep_info_${id}`);
    if (epInfo) {
      const epData = await provider.getMovies({
        category: "*",
        page:     1,
        movieId:  epInfo.movieId,
        seasonId: epInfo.seasonId,
        episodeId: parseInt(id),
      });
      const epItem = (epData?.js?.data || []).find((e: any) => String(e.id) === id)
        || epData?.js?.data?.[0];
      if (epItem) {
        // epItem.name is the raw portal item's own name, which for episode entries is
        // often a quality/language descriptor rather than the episode's actual title.
        // `id` here is exactly the key ep_info_ was populated under for this specific
        // episode (no shared-id ambiguity, unlike movie-link's season-pack case), so
        // series_info_ can be trusted directly to build the real title.
        const seriesInfo = await xtreamCache.get<any>(`series_info_${epInfo.movieId}`);
        const seasonEpisodes = seriesInfo?.episodes?.[String(epInfo.seasonId)] || [];
        const epEntry = seasonEpisodes.find((e: any) => String(e.id) === id);
        const seriesNum = epItem.series_number ?? epInfo.seriesNum;

        category = seriesInfo?.info?.genre || undefined;
        if (seriesInfo?.info?.name && epEntry?.title) {
          label = `${seriesInfo.info.name} - ${epEntry.title}`;
        } else {
          // series_info_ is only populated by the slow, rate-limited warmSeriesInfoCache
          // job — a freshly-added or not-yet-warmed series won't have it yet. Rather than
          // fall back to epItem.name (often a quality/language descriptor), do a one-off
          // live lookup of just the series' own name. Costs one extra portal call, but
          // only for this cold-cache case — not a recurring per-stream cost once warmed.
          try {
            const seriesData = await provider.getMovies({ category: "*", page: 1, movieId: epInfo.movieId });
            const seriesItems: any[] = seriesData?.js?.data || [];
            const seriesItem = seriesItems.find((i: any) => i[seriesFlag]) || seriesItems[0];
            label = seriesItem?.name ? `${seriesItem.name} - Episode ${seriesNum}` : epItem.name;
          } catch {
            label = epItem.name;
          }
        }
        const link = await provider.getMovieLink({
          series:   String(seriesNum),
          id:       parseInt(String(epItem.id)),
          download: 0,
        });
        url = link?.js?.cmd;
        if (url?.startsWith("ffrt ")) url = url.slice(5);
        logger.info(`[Series stream] ep ${id} (s=${seriesNum}) → ${url || "EMPTY"}`);
      }
    }

    // Fallback: getMovieLink with cached series number
    if (!url) {
      const epCache = await xtreamCache.get<{ cmd: string; series_num: number }>(`ep_cmd_${id}`);
      const seriesNum = epInfo?.seriesNum ?? epCache?.series_num ?? 0;
      if (epCache?.cmd) {
        const raw = epCache.cmd.startsWith("ffrt ") ? epCache.cmd.slice(5) : epCache.cmd;
        const resolved = await provider.getVodLinkByCmd(raw, seriesNum);
        url = resolved?.js?.cmd;
        if (url?.startsWith("ffrt ")) url = url.slice(5);
      }
      if (!url) {
        const link = await provider.getMovieLink({ series: String(seriesNum), id: parseInt(id), download: 0 });
        url = link?.js?.cmd;
        if (url?.startsWith("ffrt ")) url = url.slice(5);
        logger.info(`[Series stream] ep ${id} fallback getMovieLink(series=${seriesNum}) → ${url || "EMPTY"}`);
      }
    }
    if (!url) return h.response({ error: "Episode not found" }).code(404);
    logger.info(`[Series stream] ep ${id} → ${url}`);
    return h.redirect(proxyUrlFor(url, `xtream:${request.params.username}`, { kind: "series", label, category })).code(302);
  } catch (err: any) {
    logger.error(`[Series stream] ${err.message}`);
    return h.response({ error: err.message }).code(500);
  }
}

export const streamRoutes: ServerRoute[] = [

  // ── VOD stream ─────────────────────────────────────────────────────────────
  {
    method: "GET",
    path: "/movie/{username}/{password}/{streamId}.m3u8",
    handler: async (request, h) => {
      const { username, password } = request.params;
      if (!await resolveXtreamUser(username, password)) return h.response("Unauthorized").code(401);
      return handleStalkerVodStream(request, h);
    },
  },

  // ── Series stream ──────────────────────────────────────────────────────────
  {
    method: "GET",
    path: "/series/{username}/{password}/{streamId}.m3u8",
    handler: async (request, h) => {
      const { username, password } = request.params;
      if (!await resolveXtreamUser(username, password)) return h.response("Unauthorized").code(401);
      return handleStalkerSeriesStream(request, h);
    },
  },

  // ── Live stream .m3u8 ──────────────────────────────────────────────────────
  {
    method: "GET",
    path: "/live/{username}/{password}/{streamId}.m3u8",
    handler: async (request, h) => {
      const { username, password, streamId } = request.params;
      if (!await resolveXtreamUser(username, password)) return h.response("Unauthorized").code(401);
      const { proxy: proxyParam } = request.query as { proxy?: string };
      const activeProfile = await ConfigProfile.findOne({
        where: { isActive: true },
      });
      const profileId = activeProfile ? activeProfile.id : 1;
      let channel = await Channel.findOne({
        where: {
          id: [streamId, `${profileId}_${streamId}`],
        },
      });
      if (!channel) {
        const { Op } = await import("sequelize");
        channel = await Channel.findOne({ where: { id: { [Op.like]: `%_${streamId}` } } });
      }
      if (!channel) {
        logger.error(`[Live] Channel not found for streamId=${streamId}`);
        return h.response("Channel not found").code(404);
      }

      streamTracker.touch("live", request.info.remoteAddress, channel.cmd, `xtream:${username}`, { kind: "live", label: channel.name });

      const useProxy = initialConfig.proxy && proxyParam !== "0";

      if (useProxy) {
        const result = await liveStreamService.getPlaylist(channel.cmd, undefined, undefined, `xtream:${username}`);
        if (typeof result === "string") {
          return h.response(result).type("application/vnd.apple.mpegurl");
        } else {
          return h.response({ error: result.error }).code(result.code);
        }
      } else {
        try {
          const redirectedUrl = await serverManager
            .getProvider()
            .getChannelLink(channel.cmd)
            .then((res) => res.js.cmd);
          if (redirectedUrl) {
            return h.redirect(redirectedUrl).code(302);
          }
          return h.response({ error: "Unable to fetch stream [Non Proxy]" }).code(400);
        } catch (err: any) {
          const message = err instanceof Error ? err.message : String(err);
          logger.error(`Non-proxy error: ${message}`);
          return h.response({ error: "Stream fetch failed" }).code(500);
        }
      }
    },
  },

  // ── Live stream .ts ────────────────────────────────────────────────────────
  {
    method: "GET",
    path: "/live/{username}/{password}/{streamId}.ts",
    handler: async (request, h) => {
      const { username, password, streamId } = request.params;
      if (!await resolveXtreamUser(username, password)) return h.response("Unauthorized").code(401);
      const { proxy: proxyParam } = request.query as { proxy?: string };
      const activeProfile = await ConfigProfile.findOne({
        where: { isActive: true },
      });
      const profileId = activeProfile ? activeProfile.id : 1;
      let channel = await Channel.findOne({
        where: {
          id: [streamId, `${profileId}_${streamId}`],
        },
      });
      if (!channel) {
        const { Op } = await import("sequelize");
        channel = await Channel.findOne({ where: { id: { [Op.like]: `%_${streamId}` } } });
      }
      if (!channel) return h.response("Channel not found").code(404);

      streamTracker.touch("live", request.info.remoteAddress, channel.cmd, `xtream:${username}`, { kind: "live", label: channel.name });

      try {
        if (initialConfig.providerType === "stalker") {
          stalkerApi.setActiveChannel(streamId);
          const cdnUrl = await cmdPlayerV2(channel.cmd);
          if (!cdnUrl) return h.response("Stream not found").code(404);
          logger.info(`[Xtream Live .ts] ${streamId} → resolving variant from ${cdnUrl}`);

          try {
            const { httpClient } = await import("@/streaming/httpClient");
            const { startHlsTsProxy } = await import("@/streaming/hlsTsProxy");

            const masterRes = await httpClient.get<string>(cdnUrl, { responseType: "text" });
            const variantMatch = (masterRes.data || "").match(/^[^#\n\r].*$/m);
            if (variantMatch) {
              const variantUrl = new URL(variantMatch[0].trim(), cdnUrl).href;
              logger.info(`[Xtream Live .ts] ${streamId} → TS proxy → ${variantUrl}`);

              const refreshVariantUrl = async (): Promise<string> => {
                const newCdnUrl = await cmdPlayerV2(channel!.cmd);
                if (!newCdnUrl) throw new Error("Could not refresh CDN URL");
                const newMaster = await httpClient.get<string>(newCdnUrl, { responseType: "text" });
                const match = (newMaster.data || "").match(/^[^#\n\r].*$/m);
                if (!match) throw new Error("No variant in refreshed master");
                return new URL(match[0].trim(), newCdnUrl).href;
              };

              const tsStream = startHlsTsProxy(variantUrl, refreshVariantUrl);
              request.raw.req.on("close", () => tsStream.destroy());
              return h.response(tsStream).type("video/mp2t");
            }
          } catch (fetchErr: any) {
            logger.warn(`[Xtream Live .ts] ${streamId} TS proxy setup failed, falling back: ${fetchErr.message}`);
          }

          logger.info(`[Xtream Live .ts] ${streamId} → direct → ${cdnUrl}`);
          return h.redirect(cdnUrl).code(302);
        }

        // Xtream provider path
        const useProxy = initialConfig.proxy && proxyParam !== "0";
        if (useProxy) {
          return await handleProxyStream(request, h, channel.cmd, undefined, `xtream:${username}`);
        }
        const redirectedUrl = await serverManager
          .getProvider()
          .getChannelLink(channel.cmd)
          .then((res) => res.js.cmd);
        if (redirectedUrl) {
          return h.redirect(redirectedUrl).code(302);
        }
        return h.response({ error: "Unable to fetch stream" }).code(400);
      } catch (err: any) {
        logger.error(`[Xtream Live .ts] ${streamId} error: ${err.message}`);
        return h.response({ error: "Stream fetch failed" }).code(500);
      }
    },
  },
  // ── Live stream (no prefix, no extension) — some TV players use this format ─
  {
    method: "GET",
    path: "/{username}/{password}/{streamId}",
    handler: async (request, h) => {
      const { streamId, username, password } = request.params;
      if (!await resolveXtreamUser(username, password)) return h.response("Unauthorized").code(401);
      return h.redirect(`/live/${username}/${password}/${streamId}.ts`).code(302);
    },
  },
  {
    method: "GET",
    path: "/movie/{username}/{password}/{streamId}.{extension}",
    handler: async (request, h) => {
      const { username, password, streamId, extension } = request.params;
      if (!await resolveXtreamUser(username, password)) return h.response("Unauthorized").code(401);
      if (initialConfig.providerType === "stalker") {
        return handleStalkerVodStream(request, h);
      }
      const upstreamUrl = `http://${initialConfig.hostname}:${initialConfig.port}/movie/${initialConfig.username}/${initialConfig.password}/${streamId}.${extension}`;
      if (initialConfig.proxy) {
        try {
          return await handleProxyStream(request, h, upstreamUrl, undefined, `xtream:${username}`);
        } catch (err: any) {
          logger.error(`Error proxying movie stream: ${err.message || err}`);
          return h.response({ error: "Stream proxy failed" }).code(502);
        }
      }
      return h.redirect(upstreamUrl).code(302);
    },
  },
  {
    method: "GET",
    path: "/series/{username}/{password}/{episodeId}.{extension}",
    handler: async (request, h) => {
      const { username, password, episodeId, extension } = request.params;
      if (!await resolveXtreamUser(username, password)) return h.response("Unauthorized").code(401);
      if (initialConfig.providerType === "stalker") {
        return handleStalkerSeriesStream(request, h);
      }
      const upstreamUrl = `http://${initialConfig.hostname}:${initialConfig.port}/series/${initialConfig.username}/${initialConfig.password}/${episodeId}.${extension}`;
      if (initialConfig.proxy) {
        try {
          return await handleProxyStream(request, h, upstreamUrl, undefined, `xtream:${username}`);
        } catch (err: any) {
          logger.error(`Error proxying series stream: ${err.message || err}`);
          return h.response({ error: "Stream proxy failed" }).code(502);
        }
      }
      return h.redirect(upstreamUrl).code(302);
    },
  },
];
