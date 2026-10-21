import { withArtUrls } from "@/content/library/art";
import { logger } from "@/infra/logger";
import { groupDataFor, ratingFields } from "@/content/titleRatings";
import { sealCmd } from "@/infra/sealedCmd";
import { normalizeTitleKey, stripReleaseNoise } from "@/content/titleClean";
import { searchCatalog } from "@/content/searchIndex";
import axios from "axios";
import { Readable } from "stream";
import crypto from "crypto";
import { initialConfig } from "@/config/server";
import { ConfigProfile } from "@/models/ConfigProfile";
import { authCheck } from "@/auth/jwt";
import { mintStreamToken } from "@/services/StreamTokens";
import { xtreamCache } from "@/services/xtreamCache";
import { fetchMovieMeta, fetchTVMeta } from "@/content/tmdb";
import { channelLogoPath, proxiedImageUrl } from "@/providers/portalAssets";

// Resolves a stable, human-readable identity label for the "active streams"
// admin view from the request's JWT — undefined for unauthenticated requests
// (stream URLs then carry no uid and show up by IP only).
export const streamUserLabel = (request: any): string | undefined => {
  const payload = authCheck(request);
  return payload ? (payload.email || `user:${payload.userId}`) : undefined;
};

export const CACHE_DURATION_MS = 4 * 60 * 60 * 1000; // 4 hours

// Case-insensitive substring filter over an item list's display name, used
// to search already-warmed DB cache entries instead of issuing a live portal
// search. Lowercases the search term once up front rather than per item.
/**
 * Ranked, typo-tolerant, word-order-independent title search (see content/searchIndex.ts).
 * `indexKey` names the catalog snapshot (e.g. "movie:*") so its index is reused across requests.
 */
export const filterBySearch = <T extends { name?: string }>(items: T[], search: string, indexKey = "default"): T[] => {
  if (!search || !search.trim()) return items;
  return searchCatalog(indexKey, items as any[], search) as T[];
};

export const resolveStalkerUrl = (stalker: any, urlPath: string): string => {
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
export const resolveHlsSegmentUrls = async (
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
export async function* streamHlsSegments(
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
/**
 * Fields that would reveal the upstream portal to a client inspecting responses:
 * `stream_icon`/`cover` (raw logo URLs on the portal host) and `direct_source` (a raw
 * stream URL on some portals). Clients only ever use the proxied `screenshot_uri`.
 */
export function stripUpstreamFields(item: any, origin?: string): any {
  if (!item || typeof item !== "object") return item;
  const { stream_icon: _si, direct_source: _ds, cover, ...rest } = item;
  if (typeof cover === "string" && cover) rest.cover = proxiedImageUrl(cover, origin);
  // An upstream stream link (a portal's create_link answer, its CDN URL) is sealed: the
  // client can hand it back for playback but never read or play it (infra/sealedCmd.ts).
  if (rest.cmd !== undefined) rest.cmd = sealCmd(rest.cmd, origin);
  return rest;
}

export async function enrichArtworkFromTmdb(items: any[], kind: "movie" | "series", origin?: string): Promise<any[]> {
  const enriched = await enrichArtworkFromTmdbRaw(items, kind, origin);
  const withGroup = await withGroupData(enriched, kind);
  return withGroup.map((it) => withTitleKey(stripUpstreamFields(it, origin)));
}

/** content_meta id of a catalog item ("movie_<stream_id>", "series_<series_id>"). */
function contentIdOf(item: any, kind: "movie" | "series"): string | null {
  const raw = kind === "movie" ? item?.stream_id ?? item?.id : item?.series_id ?? item?.id;
  return raw != null && raw !== "" ? `${kind}_${raw}` : null;
}

/**
 * The same rating and details Discover shows, from the title's whole group (every version:
 * "ABC HD", "ABC - Hindi", "ABC Dub"), on Movies / Series list items. The portal's own text
 * stays when it has some; empty description / cast / director are filled. A lookup failure
 * leaves the items as they were.
 */
async function withGroupData(items: any[], kind: "movie" | "series"): Promise<any[]> {
  let data: Map<string, Record<string, any>>;
  try {
    data = await groupDataFor(items.map((it) => contentIdOf(it, kind)).filter((x): x is string => !!x));
  } catch (e: any) {
    logger.warn(`[catalog] group data lookup failed: ${e?.message ?? e}`);
    return items;
  }
  if (data.size === 0) return items;
  const blank = (v: any) => v == null || v === "" || v === "-" || v === "No description available";
  return items.map((it) => {
    const id = contentIdOf(it, kind);
    const g = id ? data.get(id) : undefined;
    if (!g) return it;
    return {
      ...it,
      ...ratingFields(g),
      description: blank(it.description) ? g.overview || it.description : it.description,
      actors: blank(it.actors) ? g.cast || it.actors : it.actors,
      director: blank(it.director) ? g.director || it.director : it.director,
    };
  });
}

/**
 * `title_key` (the server's grouping key) and `clean_name` (name without channel prefix
 * or language/quality tags) on every catalog item, so clients group a title's versions
 * the same way Discover does (Search: "ABC Hindi" + "ABC Tamil 4K" = one result) without
 * keeping their own copy of titleClean.ts, which drifted (the TV's still cut "Star Wars"
 * to "Wars"). Clients keep showing the portal's own name everywhere else.
 */
function withTitleKey(item: any): any {
  if (!item || typeof item !== "object") return item;
  const name = String(item.name || item.title || "");
  if (!name) return item;
  // A year glued to the name that is the title's own year ("Kim's Convenience 2016", year
  // 2016) is not part of the name; titles ending in another year ("Blade Runner 2049") keep it.
  const cleaned = stripReleaseNoise(name) || name;
  const year = String(item.year || item.releaseDate || "").slice(0, 4);
  const noYear = /^\d{4}$/.test(year) ? cleaned.replace(new RegExp(`[\\s_\\-]*[(\\[]?${year}[)\\]]?\\s*$`), "").trim() : cleaned;
  return { ...item, title_key: normalizeTitleKey(name), clean_name: noYear || cleaned };
}

async function enrichArtworkFromTmdbRaw(items: any[], kind: "movie" | "series", origin?: string): Promise<any[]> {
  // Local-library titles carry their own art (folder images, else their matched TMDB art).
  const local = items.filter((it) => it?.is_local);
  if (local.length === items.length) return items.map((it) => withArtUrls(it, origin));
  const cacheKeys = items.map((item: any) => {
    const itemId = item.id ?? item.stream_id ?? item.series_id;
    return itemId ? `tmdb_web_${kind}_${itemId}` : undefined;
  });
  const metaByKey = await xtreamCache.getMany<any>(cacheKeys.filter((k): k is string => !!k));

  return Promise.all(
    items.map(async (item: any, idx: number) => {
      if (item?.is_local) return withArtUrls(item, origin); // mixed lists (search)
      const itemId = item.id ?? item.stream_id ?? item.series_id;
      if (!itemId) return item;

      // mapSeriesItem also sets `backdrop_path` to an Xtream-protocol array ([] or
      // [url]) on the same cached object — an empty array is truthy in JS, so a plain
      // `||` would let it silently win over a real TMDB backdrop string. Only accept it
      // here if it's actually a non-empty string.
      const existingBackdrop = typeof item.backdrop_path === "string" && item.backdrop_path
        ? item.backdrop_path
        : undefined;

      const cacheKey = cacheKeys[idx]!;
      const meta = metaByKey.get(cacheKey);

      if (meta === undefined || meta === null) {
        if (!(item.screenshot_uri && existingBackdrop && item.actors && item.director)) {
          const name = item.name || item.title || "";
          const year = String(item.year || item.releaseDate || item.added || "").slice(0, 4);
          const lookup = kind === "movie" ? fetchMovieMeta(name, year) : fetchTVMeta(name, year);
          lookup
            .then((fetched) => xtreamCache.set(cacheKey, fetched ?? { _not_found: true }))
            .catch(() => {});
        }
        // item.screenshot_uri here is whatever the portal returned raw — proxy
        // it so the upstream host is never sent to the browser (see
        // proxiedImageUrl in portalAssets.ts). Every return path in this
        // function goes through this same rewrite for the same reason.
        // origin makes it absolute — see proxiedImageUrl's comment on why a
        // relative /api/images-shaped path here would get double-prefixed by
        // the frontend's own /api/images convention.
        return { ...item, screenshot_uri: proxiedImageUrl(item.screenshot_uri, origin), backdrop_path: existingBackdrop };
      }

      if (meta && !meta._not_found) {
        return {
          ...item,
          screenshot_uri: proxiedImageUrl(meta.poster || item.screenshot_uri, origin),
          backdrop_path: meta.backdrop ? proxiedImageUrl(meta.backdrop, origin) : existingBackdrop,
          // No `existingBackdrop` fallback here — that's a portal-supplied
          // image of unknown resolution, so it can't be trusted as "high-res"
          // the way a TMDB-confirmed backdropHd pick can. Only ever the
          // TMDB pick, or nothing (AmbientBackdrop skips items without it).
          backdrop_hd_path: meta.backdropHd ? proxiedImageUrl(meta.backdropHd, origin) : undefined,
          description: item.description || meta.overview || item.description,
          actors: item.actors || meta.cast || item.actors,
          director: item.director || meta.director || item.director,
          trailer_key: meta.trailerKey || undefined,
        };
      }
      return { ...item, screenshot_uri: proxiedImageUrl(item.screenshot_uri, origin), backdrop_path: existingBackdrop };
    }),
  );
}

export const getActiveProfileId = async () => {
  const activeProfile = await ConfigProfile.findOne({
    where: { isActive: true },
  });
  return activeProfile?.id;
};

// Generates dynamic deterministic keys for parameters
export const generateCacheKey = (type: string, queryParams: any): string => {
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
export const mapChannel = (channel: any, origin: string, userLabel?: string, genreTitle?: string) => {
  let cmdUrl: string;
  let logo = channel.logo || channel.screenshot_uri || "";
  if (userLabel) {
    const token = mintStreamToken(channel.cmd, userLabel, undefined, {
      kind: "live",
      label: channel.name,
      category: genreTitle,
      // Broken-stream tracking: live is recorded only, never auto-hidden.
      itemType: "live",
      itemId: String(channel.id),
      resolve: { cmd: channel.cmd },
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
  // Whatever's left absolute at this point (an Xtream logo URL, or a Stalker
  // logo that was already absolute) points straight at the real portal/CDN
  // host — proxy it so that host is never sent to the browser. Relative
  // /api/images paths from channelLogoPath above pass through untouched.
  // origin is passed so the result is absolute — the frontend only prefixes
  // *non*-http values with /api/images itself, so leaving our own already
  // /api/images-shaped proxy path relative here would get double-prefixed.
  logo = proxiedImageUrl(logo, origin);
  return {
    ...channel,
    cmd: cmdUrl,
    screenshot_uri: logo,
    isPortal: initialConfig.providerType === "stalker",
  };
};
