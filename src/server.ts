import "dotenv/config";
import { initialConfig, serverConfig } from "@/config/server";
import { playlistRoutes } from "./routes/streaming/playlist";
import { liveRoutes } from "./routes/streaming/live";
import { configRoutes } from "./routes/providerConfig";
import { profileRoutes } from "./routes/account/profiles";
import Hapi from "@hapi/hapi";
import Inert from "@hapi/inert";
import { serverManager } from "./serverManager";
import { stalkerV2 } from "./routes/stalkerV2";
import path from "path";
import { proxy } from "./routes/streaming/proxy";
import { stalkerApi } from "./providers/stalker";
import { portalProxy } from "./routes/streaming/portalProxy";
import { xtreamRoutes } from "./routes/xtream";
import { vodRoutes } from "./routes/streaming/vod";
import { subtitleRoutes } from "./routes/streaming/subtitles";
import { adminRoutes } from "./routes/contentmanager";
import { authRoutes } from "./routes/account/auth";
import { userRoutes } from "./routes/account/user";
import { userManagementRoutes } from "./routes/account/userManagement";
import { discoverRoutes } from "./routes/discover";
import { socketService } from "./services/SocketService";

import { initDB } from "./db";
import { migrateToProfiles, loadActiveProfileFromDB } from "./config/server";
import { loadPlaylistCache } from "./providers/getM3uUrls";
import { warmVodCache, warmSeriesCache, warmSeriesInfoCache, cleanupGenres, bumpVodVersion } from "./services/xtreamCache";
import { enrichContentMeta, sweepStaleContent } from "./content/metaEnrichment";
import { fetchAndCacheEpg, getEpgCache } from "./content/epg";
import { EpgCache } from "./models/EpgCache";
import { DeviceCode } from "./models/DeviceCode";
import { Op } from "sequelize";
import { getVodRefreshStatus } from "./providers/getM3uUrls";
import { logger } from "./infra/logger";
import { authCheck, type JWTPayload } from "./auth/jwt";

const init = async () => {
  if (!process.env.ADMIN_PASSWORD) {
    logger.warn("ADMIN_PASSWORD is not set — admin login is disabled (returns 503).");
  }
  if (!process.env.ADMIN_EMAIL && !process.env.ADMIN_EMAILS) {
    const msg = "ADMIN_EMAIL is not set — any email + ADMIN_PASSWORD logs in as admin (bootstrap mode). Set ADMIN_EMAIL to lock this down.";
    if (process.env.NODE_ENV === "production") {
      logger.error(`SECURITY: ${msg}`);
      logger.error("Refusing to start in production without ADMIN_EMAIL. Set ADMIN_EMAIL or ADMIN_EMAILS to continue.");
      process.exit(1);
    }
    logger.warn(`SECURITY WARNING: ${msg}`);
  }

  await initDB();

  await migrateToProfiles();

  await loadActiveProfileFromDB();
  // Explicitly initialize provider after loading the active profile from DB,
  // since serverManager initialized itself with default config at import time.
  serverManager.initProvider();
  await loadPlaylistCache();

  const server = Hapi.server({
    ...serverConfig,
  });

  serverManager.setServer(server);

  server.route({
    method: "GET",
    path: "/",
    handler: (request, h) => {
      return h
        .file(path.join(process.cwd(), "public", "index.html"))
        .header(
          "Content-Security-Policy",
          "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:;",
        );
    },
  });

  socketService.init(server.listener);

  await server.register(Inert);
  server.route(playlistRoutes);
  server.route(liveRoutes);
  server.route(configRoutes);
  server.route(profileRoutes);
  server.route(stalkerV2);
  server.route(proxy);
  server.route(portalProxy);
  server.route(xtreamRoutes);
  server.route(vodRoutes);
  server.route(subtitleRoutes);
  server.route(adminRoutes);
  server.route(authRoutes);
  server.route(userRoutes);
  server.route(userManagementRoutes);
  server.route(discoverRoutes);

  // Rate limiter for unauthenticated public endpoints (stream/media routes)
  const RL_MAX = parseInt(process.env.RATE_LIMIT_MAX || "120", 10); // requests per window
  const RL_WINDOW = parseInt(process.env.RATE_LIMIT_WINDOW_MS || "60000", 10); // window in ms
  const rlMap = new Map<string, { count: number; windowStart: number }>();

  // Separate, much stricter bucket for the admin login endpoint — it's
  // publicly reachable (exempted from the global JWT gate, see onPreHandler
  // below, since you need to call it to GET a token in the first place) and
  // guards ADMIN_PASSWORD with a plain string comparison, no lockout of its
  // own. Reusing the streaming-tuned RL_MAX (120/min, sized for legitimate
  // HLS segment/playlist request volume) here would let an attacker try 120
  // passwords a minute — the ~120min catalog CLAUDE.md search space online
  // isn't the concern, someone script-brute-forcing a weak password is. A
  // dedicated 5-attempts-per-5-minutes bucket per IP makes that impractical
  // without touching the streaming limiter's tuning at all.
  const ADMIN_LOGIN_RL_MAX = parseInt(process.env.ADMIN_LOGIN_RATE_LIMIT_MAX || "5", 10);
  const ADMIN_LOGIN_RL_WINDOW = parseInt(process.env.ADMIN_LOGIN_RATE_LIMIT_WINDOW_MS || "300000", 10); // 5 min
  const adminLoginRlMap = new Map<string, { count: number; windowStart: number }>();

  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of rlMap) {
      if (now - entry.windowStart > RL_WINDOW) rlMap.delete(key);
    }
    for (const [key, entry] of adminLoginRlMap) {
      if (now - entry.windowStart > ADMIN_LOGIN_RL_WINDOW) adminLoginRlMap.delete(key);
    }
  }, RL_WINDOW);

  server.ext("onPreResponse", (_request, h) => h.continue);

  server.ext("onRequest", (request, h) => {
    const p = request.path;

    if (p === "/api/auth/admin" && request.method.toUpperCase() === "POST") {
      const ip = request.info.remoteAddress;
      const now = Date.now();
      const entry = adminLoginRlMap.get(ip);
      if (!entry || now - entry.windowStart > ADMIN_LOGIN_RL_WINDOW) {
        adminLoginRlMap.set(ip, { count: 1, windowStart: now });
      } else {
        entry.count++;
        if (entry.count > ADMIN_LOGIN_RL_MAX) {
          return h.response({ error: "Too Many Requests" }).code(429).takeover();
        }
      }
    }

    // Bucketed by stream family, not one shared bucket for every public stream
    // route — a runaway client-side retry loop against live TV (e.g. hls.js
    // hammering /live.m3u8 with no backoff on error) must only exhaust its own
    // bucket, never lock the same IP out of movie/series/VOD playback too.
    const isLiveStream = p.startsWith("/live/") || p.startsWith("/live.m3u8") || p.startsWith("/player/");
    const isVodStream = p.startsWith("/movie/") || p.startsWith("/series/") || p.startsWith("/api/media/") || p.startsWith("/api/vod/play");

    if (isLiveStream || isVodStream) {
      const ip = request.info.remoteAddress;
      const key = `${isLiveStream ? "live" : "vod"}:${ip}`;
      const now = Date.now();
      const entry = rlMap.get(key);
      if (!entry || now - entry.windowStart > RL_WINDOW) {
        rlMap.set(key, { count: 1, windowStart: now });
      } else {
        entry.count++;
        if (entry.count > RL_MAX) {
          return h.response({ error: "Too Many Requests" }).code(429).takeover();
        }
      }
    }
    return h.continue;
  });

  // Global Auth Interceptor for Hapi endpoints
  server.ext("onPreHandler", (request, h) => {
    const path = request.path;

    // Skip auth for static pages, media streams, image proxies, video stream proxies, and authorization endpoints
    if (
      (!path.startsWith("/api/") && !path.startsWith("/v2/")) ||
      path.startsWith("/api/auth/") ||
      path.startsWith("/api/images/") ||
      path.startsWith("/api/proxy") ||
      path.startsWith("/api/media/") ||
      path.startsWith("/api/vod/") ||
      path.startsWith("/api/v2/download") ||
      path.startsWith("/live.m3u8") ||
      path.startsWith("/player/") ||
      path.startsWith("/live/") ||
      path.startsWith("/movie/") ||
      path.startsWith("/series/") ||
      path.startsWith("/portal/proxy")
    ) {
      return h.continue;
    }

    const user = authCheck(request);
    if (!user) {
      return h.response({ error: "Unauthorized" }).code(401).takeover();
    }

    // Attach user metadata to plugins state so handlers can access it
    (request.plugins as { user?: JWTPayload }).user = user;

    const isMutation = ["POST", "PUT", "DELETE", "PATCH"].includes(request.method.toUpperCase());

    // Paths that require admin regardless of HTTP method
    const isAdminOnlyPath =
      path.startsWith("/api/admin/") ||
      path.startsWith("/api/v2/debug") ||
      path.startsWith("/api/v2/refresh-") ||
      path.startsWith("/api/refresh/") ||
      path.startsWith("/api/profiles") ||
      path.startsWith("/api/config") ||
      path.startsWith("/api/upload") ||
      path === "/api/v2/reset-movies" ||
      path === "/api/v2/get-token";

    // User owns this data — any valid JWT, any method
    const isUserOwnData =
      path.startsWith("/api/user/") ||
      path === "/api/auth/device/authorize";

    if ((isAdminOnlyPath || (isMutation && !isUserOwnData)) && user.role !== "admin") {
      return h.response({ error: "Forbidden" }).code(403).takeover();
    }

    return h.continue;
  });

  const startTime = Date.now();
  server.route({
    method: "GET",
    path: "/api/health",
    options: { auth: false },
    handler: (_request, h) => {
      const { inProgress, status } = getVodRefreshStatus();
      return h.response({
        status: "ok",
        uptimeSeconds: Math.floor((Date.now() - startTime) / 1000),
        vodCache: { refreshing: inProgress, status },
        provider: initialConfig.providerType ?? "unknown",
      }).code(200);
    },
  });

  server.route({
    method: "GET",
    path: "/{param*}",
    handler: (request, h) => {
      const param = (request.params.param as string) || "";
      const publicRoot = path.join(process.cwd(), "public");
      const filePath = path.resolve(publicRoot, param);
      const withinPublicRoot =
        filePath === publicRoot ||
        filePath.startsWith(publicRoot + path.sep);

      const isServableAsset =
        withinPublicRoot &&
        (param.startsWith("uploads/") ||
          filePath.endsWith(".js") ||
          filePath.endsWith(".css") ||
          filePath.endsWith(".png") ||
          filePath.endsWith(".jpg") ||
          filePath.endsWith(".jpeg") ||
          filePath.endsWith(".webp") ||
          filePath.endsWith(".gif") ||
          filePath.endsWith(".ico") ||
          filePath.endsWith(".svg") ||
          filePath.endsWith(".webmanifest"));

      if (!isServableAsset) {
        return h
          .file(path.join(process.cwd(), "public", "index.html"))
          .header(
            "Content-Security-Policy",
            "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:;",
          );
      }

      return h.file(filePath);
    },
  });

  server.events.on("response", function (request) {
    const qs = request.url.search || "";
    logger.info(
      request.info.remoteAddress +
        ": " +
        request.method.toUpperCase() +
        " " +
        request.path +
        qs +
        " --> " +
        (request.response &&
        typeof (request.response as any).statusCode === "number"
          ? (request.response as any).statusCode
          : request.response &&
            (request.response as any).output &&
            (request.response as any).output.statusCode),
    );
  });

  await server.start();

  const { backgroundJobService } =
    await import("./services/BackgroundJobService");
  backgroundJobService.start();

  logger.info(`Server running at: ${server.info.uri}`);

  await bumpVodVersion().catch((e) => logger.error(`[bumpVodVersion] ${e}`));

  // Warm xtream caches in background on startup, then cleanup stale genres
  (async () => {
    await Promise.all([
      warmVodCache().catch((e) => { logger.error(`[warmVodCache] ${e}`); return false; }),
      warmSeriesCache().catch((e) => { logger.error(`[warmSeriesCache] ${e}`); return false; }),
    ]);
    await cleanupGenres().catch((e) => logger.error(`[cleanupGenres] ${e}`));
    await warmSeriesInfoCache().catch((e) => logger.error(`[warmSeriesInfoCache] ${e}`));
    // enrichMovies/enrichSeries (inside enrichContentMeta) skip any row that
    // already has enrichedAt set, so running this after every warm cycle only
    // ever processes titles the portal just added since the last run — closes
    // the gap where new content sat unenriched (no ContentMeta row at all,
    // e.g. blank "Because You Watched") until someone manually hit
    // /api/admin/content-meta/enrich. Fire-and-forget: a 100k+ catalog backfill
    // takes hours at THROTTLE_MS pace, but that's only ever true on the very
    // first run — routine reruns only touch the handful of new titles.
    enrichContentMeta().catch((e) => logger.error(`[enrichContentMeta startup] ${e}`));
  })();

  // Fetch EPG on startup if cache is missing or stale
  getEpgCache().then((cache) => {
    if (!cache) {
      fetchAndCacheEpg().catch((e) => logger.error(`[EPG startup] ${e}`));
    }
  }).catch((e) => logger.error(`[EPG startup check] ${e}`));

  // Re-warm all xtream caches every 24 hours
  setInterval(() => {
    (async () => {
      await Promise.all([
        warmVodCache().catch((e) => { logger.error(`[warmVodCache interval] ${e}`); }),
        warmSeriesCache().catch((e) => { logger.error(`[warmSeriesCache interval] ${e}`); }),
      ]);
      await cleanupGenres().catch((e) => logger.error(`[cleanupGenres interval] ${e}`));
      await warmSeriesInfoCache().catch((e) => logger.error(`[warmSeriesInfoCache interval] ${e}`));
      enrichContentMeta().catch((e) => logger.error(`[enrichContentMeta interval] ${e}`));
      sweepStaleContent().catch((e) => logger.error(`[sweepStaleContent interval] ${e}`));
    })();
  }, 24 * 60 * 60 * 1000);

  // Daily DB cleanup: purge stale EPG entries (>7 days old) and expired TV
  // device-pairing codes.
  // XtreamCache content rows are managed exclusively by the warm cycle's diff logic — do not delete them here.
  //
  // device_codes rows are only ever deleted on the successful-pairing path
  // (routes/account/auth.ts) — an abandoned or expired QR/device-code pairing
  // attempt just gets its status flipped to "expired" and the row itself
  // sits there permanently otherwise. TV pairing is actively used, so these
  // genuinely accumulate over time. Unlike XtreamCache, there's no stale-serve/
  // background-refresh pattern reading this table, so a plain expiresAt-based
  // delete is safe with no edge cases to worry about.
  const runDbCleanup = async () => {
    try {
      const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const epgDeleted = await EpgCache.destroy({ where: { updatedAt: { [Op.lt]: cutoff } } });
      if (epgDeleted > 0) logger.info(`[cleanup] Purged ${epgDeleted} stale EpgCache rows older than 7 days.`);
    } catch (e) { logger.error(`[cleanup] EpgCache purge failed: ${e}`); }

    try {
      const now = new Date();
      const deviceCodesDeleted = await DeviceCode.destroy({ where: { expiresAt: { [Op.lt]: now } } });
      if (deviceCodesDeleted > 0) logger.info(`[cleanup] Purged ${deviceCodesDeleted} expired device_codes row(s).`);
    } catch (e) { logger.error(`[cleanup] device_codes purge failed: ${e}`); }
  };

  runDbCleanup().catch((e) => logger.error(`[cleanup startup] ${e}`));
  setInterval(() => runDbCleanup().catch((e) => logger.error(`[cleanup interval] ${e}`)), 24 * 60 * 60 * 1000);
};

process.on("unhandledRejection", (err) => {
  logger.error(`Unhandled rejection: ${err}`);
  process.exit(1);
});

init();
