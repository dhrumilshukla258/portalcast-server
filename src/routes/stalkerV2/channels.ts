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
// Channels/groups barely ever change (a portal's lineup is stable for hours/days), but the
// web UI refetches both in full on every switch to the TV tab — unlike movies/series, which
// have a ContentCache-backed response cache, these were recomputed (DB read + override merge
// + genre lookup + sort) from scratch on every single request. In-memory, not DB-backed like
// ContentCache, since this is small and per-process is fine; cleared eagerly on refresh so an
// admin-triggered refresh or override change is reflected immediately rather than waiting out
// the TTL like movies/series do.
const channelsResponseCache = new Map<string, { data: any; expiresAt: number }>();
const groupsResponseCache = new Map<string, { data: any; expiresAt: number }>();

function invalidateChannelsCache(profileId: string) {
  for (const key of channelsResponseCache.keys()) {
    if (key.startsWith(`${profileId}:`)) channelsResponseCache.delete(key);
  }
}
function invalidateGroupsCache(profileId: string) {
  for (const key of groupsResponseCache.keys()) {
    if (key.startsWith(`${profileId}:`)) groupsResponseCache.delete(key);
  }
}

export const channelRoutes: ServerRoute[] = [
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
        invalidateGroupsCache(profileId);
        invalidateChannelsCache(profileId);
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
        const cacheKey = `${profileId}:${all === "true" ? "all" : "filtered"}`;
        const cached = groupsResponseCache.get(cacheKey);
        if (cached && cached.expiresAt > Date.now()) {
          return cached.data;
        }

        const groups = await readGenres("channel", profileId);

        if (groups.length === 0) {
          return h.redirect("/api/v2/refresh-groups");
        }

        if (all === "true") {
          groupsResponseCache.set(cacheKey, { data: groups, expiresAt: Date.now() + CACHE_DURATION_MS });
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
        groupsResponseCache.set(cacheKey, { data: filteredGroups, expiresAt: Date.now() + CACHE_DURATION_MS });
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
        invalidateChannelsCache(profileId);
        const origin = getPublicOrigin(request);
        const userLabel = streamUserLabel(request);
        const genres = await readGenres("channel", profileId);
        const genreTitleMap = new Map(genres.map((g: any) => [g.id, g.title]));
        const genreByStringId = new Map(genres.map((g: any) => [String(g.id), g]));
        const mappedChannels = filteredChannels.map((c) =>
          mapChannel(c, origin, userLabel, genreTitleMap.get(c.tv_genre_id)),
        );
        if (genres.length === 0) {
          return mappedChannels ?? [];
        }
        return (mappedChannels ?? []).filter((channel) => {
          const genre = genreByStringId.get(String(channel.tv_genre_id));
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
        const origin = getPublicOrigin(request);
        const userLabel = streamUserLabel(request);
        const cacheKey = `${profileId}:${origin}:${userLabel ?? ""}`;
        const cached = channelsResponseCache.get(cacheKey);
        if (cached && cached.expiresAt > Date.now()) {
          return cached.data;
        }

        const channels = await readChannels(profileId);
        if (channels.length === 0) {
          return h.redirect("/api/v2/refresh-channels");
        }
        const genres = await readGenres("channel", profileId);
        const originalTitleMap = new Map(genres.map((g: any) => [g.id, g.title]));
        const visibleGenres = await applyGenreOverrides(genres, "channel");
        const visibleGenreIds = new Set(visibleGenres.map((g: any) => g.id));
        const overriddenChannels = await applyChannelOverrides(channels);
        const result = overriddenChannels
          .filter((channel) => visibleGenreIds.has(channel.tv_genre_id) &&
            (initialConfig.groups.length === 0 ||
              initialConfig.groups.includes(originalTitleMap.get(channel.tv_genre_id) ?? "")))
          .map((channel) => mapChannel(channel, origin, userLabel, originalTitleMap.get(channel.tv_genre_id)))
          .sort((a, b) => a.name.localeCompare(b.name));
        channelsResponseCache.set(cacheKey, { data: result, expiresAt: Date.now() + CACHE_DURATION_MS });
        return result;
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

];
