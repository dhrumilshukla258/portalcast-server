import { fillProviderDates } from "@/content/providerDates";
import { registerHttpCaching } from "./infra/httpCaching";
import axios from "axios";
import { httpClient } from "./streaming/httpClient";
import { countAxios } from "./services/outboundTraffic";
import { tidyPeople } from "./content/people";
import { ContentCache } from "./models/ContentCache";
import { runStorageMigrations } from "./db/storageMigrations";
import { titleImageRoutes } from "./routes/admin/titleImages";
import { titleMatchRoutes } from "./routes/admin/titleMatch";
import { evictImageCache } from "./content/imageCache";
import { startPortalHealth, iptvHealth } from "./services/portalHealth";
import { libraryAdminRoutes } from "./routes/library/admin";
import { localStreamRoutes } from "./routes/library/stream";
import { scanLibraries } from "./content/library/scanner";
import { setupRoutes, needsSetup } from "./routes/account/setup";
import { setupGuideRoutes } from "./routes/admin/setupGuide";
import { registerJob, startJobs, runJobNow } from "./services/jobs";
import { prefillCardPosters } from "./content/posterPrefill";
import { runIntegrityCheck } from "./services/integrity";
import { backupDatabase } from "./services/backup";
import { refreshChannelLogos, resolveTmdbChannelLogos } from "./content/channels";
import "dotenv/config";
import { clientIp, isSecureRequest } from "./infra/clientIp";
import { suspiciousRequestReason } from "./infra/requestHygiene";
import { recordFromRequest, isBanned, purgeOld as purgeOldSecurityEvents } from "./services/SecurityEvents";
import { purgeRefreshTokens } from "./services/RefreshTokens";
import { securityRoutes } from "./routes/admin/security";
import { accountStatus } from "./auth/accountStatus";
import { initialConfig, serverConfig } from "@/config/server";
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
import { subtitleRoutes } from "./routes/streaming/subtitles";
import { streamFailureRoutes } from "./routes/streaming/streamFailures";
import { mediaInfoRoutes } from "./routes/streaming/mediaInfo";
import { purgeStaleFailures } from "./services/StreamFailures";
import { adminRoutes } from "./routes/contentmanager";
import { authRoutes } from "./routes/account/auth";
import { userRoutes } from "./routes/account/user";
import { userManagementRoutes } from "./routes/account/userManagement";
import { discoverRoutes, discoverDetailsRoute, personRoute, peopleSearchRoute, peopleBrowseRoute } from "./routes/discover";
import { fillPeopleGenders } from "./content/peopleGender";
import { buildPeopleIndex, markPeopleChanged } from "./content/peopleSearch";
import { startCatalogSnapshot } from "./content/catalog/store";
import { viewersReady } from "./content/viewers";
import { markHomeStale, primeHomeFacts } from "./content/home";
import { checkWatchedSeries } from "./content/episodeWatch";
import { bumpAnswerInputs } from "./infra/answerVersion";
import { onMediaInfoChange } from "./content/mediaInfo";
import { onDiscoverCacheClear } from "./services/discoverCache";
import { socketService } from "./services/SocketService";

import { initDB, sequelize } from "./db";
import { loadSettings, setting, onSettingChange } from "./config/settings";
import { settingsRoutes } from "./routes/admin/settings";
import { titleWordsRoutes } from "./routes/admin/titleWords";
import { onTitleWordsChanged, watchActiveProfile, applyActiveProfileWords } from "./content/titleWords";
import { overviewRoutes } from "./routes/admin/overview";
import { migrateToProfiles, loadActiveProfileFromDB, encryptStoredCredentials } from "./config/server";
import { warmVodCache, warmSeriesCache, warmSeriesInfoCache, cleanupGenres } from "./services/xtreamCache";
import { enrichContentMeta, sweepStaleContent, recleanForWords, imdbRetryUnmatched, imdbCorrectMatches } from "./content/metaEnrichment";
import { buildImdbIndex, imdbIndexReady } from "./content/imdbIndex";
import { fetchAndCacheEpg } from "./content/epg";
import { getEpgSnapshot } from "./content/epgServe";
import { EpgCache } from "./models/EpgCache";
import { DeviceCode } from "./models/DeviceCode";
import { Op } from "sequelize";
import { logger } from "./infra/logger";
import { authCheck, type JWTPayload } from "./auth/jwt";
import { primeDiscoverIndex } from "./content/discoverIndex";
import { refreshSports } from "./content/sports";
import { sportsRoutes } from "./routes/sports";

// The webui loads scripts/media/artwork from many origins (streams, TMDB, Google sign-in,
// Chromecast, YouTube trailers), so sources stay open; eval, plugins and <base> are off.
const CSP = "default-src * 'unsafe-inline' data: blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'self';";

// Every outbound request counted by destination (services/outboundTraffic.ts).
countAxios(axios);
countAxios(httpClient);

const init = async () => {
  if (!process.env.ADMIN_PASSWORD) {
    logger.info("ADMIN_PASSWORD is not set — admins sign in with their own account; the emergency admin password is off.");
  }
  await initDB();
  // Settings saved in the admin page (config/settings.ts), before anything reads them.
  await loadSettings();

  if (await needsSetup()) {
    logger.warn("No admin account yet: open the web page to create one (first-start setup). The first person to finish it becomes admin.");
  } else if (process.env.ADMIN_PASSWORD && !setting<string>("adminEmail") && setting<string[]>("adminEmails").length === 0) {
    const msg = "No admin email is set — any email + ADMIN_PASSWORD logs in as admin (bootstrap mode). Set the admin email in Admin → Settings, or ADMIN_EMAIL, to lock this down.";
    if (process.env.NODE_ENV === "production") {
      logger.error(`SECURITY: ${msg}`);
      logger.error("Refusing to start in production without an admin email. Set ADMIN_EMAIL (or ADMIN_EMAILS) to continue.");
      process.exit(1);
    }
    logger.warn(`SECURITY WARNING: ${msg}`);
  }

  await migrateToProfiles();
  await encryptStoredCredentials();
  // One-time storage changes (db/storageMigrations.ts): backup first, then each step once.
  await runStorageMigrations(sequelize);

  // Background jobs (services/jobs.ts). The runner starts after the server is listening.
  registerJob({ name: "backup", label: "Back up the database", dailyAtHour: 4, run: backupDatabase });
  registerJob({ name: "integrity", label: "Check stored data for repeats", dailyAtHour: 5, run: runIntegrityCheck });
  registerJob({ name: "library-scan", label: "Scan local libraries", dailyAtHour: 3, run: () => scanLibraries() });
  registerJob({ name: "image-cache", label: "Trim the image cache", dailyAtHour: 5, run: evictImageCache });
  registerJob({ name: "poster-prefill", label: "Fetch card posters ahead (w342)", dailyAtHour: 2, run: prefillCardPosters });
  registerJob({
    name: "people", label: "Remove unused cast lists", dailyAtHour: 5,
    run: async () => { const r = await tidyPeople(); markPeopleChanged(); return r; },
  });
  registerJob({ name: "people-gender", label: "Fill in people's gender from TMDB (People tab)", everyMs: 10 * 60 * 1000, run: fillPeopleGenders });
  registerJob({ name: "sports", label: "Fetch the sports schedule", everyMs: 60 * 60 * 1000, run: refreshSports });
  registerJob({ name: "provider-dates", label: "Read the provider's dates (Just added, New episodes)", everyMs: 6 * 60 * 60 * 1000, run: fillProviderDates });
  // Each watched series at most once a day (content/episodeWatch.ts); a run every 6 h picks up
  // what a restart or a busy portal left.
  registerJob({ name: "new-episodes", label: "Check the series viewers follow for new episodes", everyMs: 6 * 60 * 60 * 1000, run: checkWatchedSeries });
  // IMDb matching (setting imdbMatching, off by default; content/imdbIndex.ts): the files are
  // downloaded and indexed weekly, and at once when the setting is turned on (or the index is
  // missing at start-up); titles TMDB never matched are tried against it a few hundred at a time.
  registerJob({
    name: "imdb-titles", label: "Download IMDb titles and build the match index (when IMDb matching is on)", everyMs: 7 * 24 * 60 * 60 * 1000,
    run: async () => {
      if (!setting<boolean>("imdbMatching")) return "IMDb matching is off";
      const built = await buildImdbIndex();
      logger.info(`[imdb] index built: ${built}`);
      // A new index: both passes run now (queued after this job), not up to 6 h later.
      runJobNow("imdb-unmatched");
      runJobNow("imdb-verify");
      return built;
    },
  });
  registerJob({ name: "imdb-unmatched", label: "Try titles TMDB never matched against IMDb", everyMs: 6 * 60 * 60 * 1000, run: () => imdbRetryUnmatched() });
  registerJob({ name: "imdb-verify", label: "Correct matches the portal's own people or year contradict (IMDb)", everyMs: 6 * 60 * 60 * 1000, run: () => imdbCorrectMatches() });
  onSettingChange((key) => { if (key === "imdbMatching" && setting<boolean>("imdbMatching") && !imdbIndexReady()) runJobNow("imdb-titles"); });
  // Missing at start-up: built after the start-up warm-ups, not on top of them.
  setTimeout(() => { if (setting<boolean>("imdbMatching") && !imdbIndexReady()) runJobNow("imdb-titles"); }, 10 * 60_000).unref?.();
  registerJob({
    name: "page-cache", label: "Remove expired page answers", dailyAtHour: 5,
    run: async () => `${await ContentCache.destroy({ where: { expiresAt: { [Op.lt]: new Date() } } })} removed`,
  });

  await loadActiveProfileFromDB();
  // Explicitly initialize provider after loading the active profile from DB,
  // since serverManager initialized itself with default config at import time.
  serverManager.initProvider();
  // The active portal's changes to the title word lists (content/titleWords.ts), before anything
  // cleans a title; applied again when the active profile changes, re-cleaning what moved.
  onTitleWordsChanged(recleanForWords);
  watchActiveProfile();
  await applyActiveProfileWords(true).catch((e) => logger.warn(`[title-words] not applied at start: ${e?.message ?? e}`));

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
          CSP,
        )
        .header("X-Frame-Options", "SAMEORIGIN");
    },
  });

  socketService.init(server.listener);

  await server.register(Inert);
  server.route(liveRoutes);
  server.route(configRoutes);
  server.route(profileRoutes);
  server.route(stalkerV2);
  server.route(proxy);
  server.route(portalProxy);
  server.route(subtitleRoutes);
  server.route(streamFailureRoutes);
  server.route(mediaInfoRoutes);
  server.route(securityRoutes);
  server.route(settingsRoutes);
  server.route(titleWordsRoutes);
  server.route(overviewRoutes);
  server.route(titleImageRoutes);
  server.route(titleMatchRoutes);
  server.route(adminRoutes);
  server.route(authRoutes);
  server.route(setupRoutes);
  server.route(setupGuideRoutes);
  server.route(libraryAdminRoutes);
  server.route(localStreamRoutes);
  server.route(userRoutes);
  server.route(userManagementRoutes);
  server.route(discoverRoutes);
  server.route(discoverDetailsRoute);
  server.route(personRoute);
  server.route(peopleSearchRoute);
  server.route(peopleBrowseRoute);
  server.route(sportsRoutes);
  // Is the IPTV portal reachable (services/portalHealth.ts)? Signed-in clients only.
  server.route({ method: "GET", path: "/api/v2/health/iptv", handler: () => iptvHealth() });

  // Rate limiter for unauthenticated public endpoints (stream/media routes)
  // Limits are settings (Admin → Settings), read on every request.
  const RL_MAX = () => setting<number>("rateLimitMax"); // requests per window
  const RL_WINDOW = () => setting<number>("rateLimitWindowMs"); // window in ms
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
  const ADMIN_LOGIN_RL_MAX = () => setting<number>("adminLoginRateLimitMax");
  const ADMIN_LOGIN_RL_WINDOW = () => setting<number>("adminLoginRateLimitWindowMs"); // 5 min by default
  const adminLoginRlMap = new Map<string, { count: number; windowStart: number }>();

  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of rlMap) {
      if (now - entry.windowStart > RL_WINDOW()) rlMap.delete(key);
    }
    for (const [key, entry] of adminLoginRlMap) {
      if (now - entry.windowStart > ADMIN_LOGIN_RL_WINDOW()) adminLoginRlMap.delete(key);
    }
  }, 60_000);

  server.ext("onPreResponse", (_request, h) => h.continue);
  // Cache headers and ETags on stable reads, IPTV status on every answer (infra/httpCaching.ts).
  registerHttpCaching(server);

  server.ext("onRequest", (request, h) => {
    const p = request.path;

    // Same tight bucket for every credential-guessing/spam-prone auth
    // endpoint, not just /api/auth/admin — /api/auth/login is brute-forceable
    // against real user passwords, and forgot-password can be used to spam
    // the outbound mail sender, both previously unthrottled.
    const isThrottledAuthEndpoint =
      request.method.toUpperCase() === "POST" &&
      (p === "/api/auth/admin" ||
        p === "/api/auth/login" ||
        p === "/api/auth/setup" ||
        p === "/api/auth/google" ||
        p === "/api/auth/jellyfin" ||
        p === "/api/auth/refresh" ||
        p === "/api/auth/forgot-password" ||
        p === "/api/auth/reset-password" ||
        p === "/api/auth/device/code" ||
        p === "/api/auth/device/authorize");
    const ip = clientIp(request);

    // A banned address (services/SecurityEvents.ts) gets nothing from the API.
    if (p.startsWith("/api/") && isBanned(ip)) {
      return h.response({ error: "Too Many Requests" }).code(429).takeover();
    }

    // Request hygiene: traversal, null bytes, script/SQL-shaped input and oversized URLs
    // have no legitimate use here. Rejected outright and counted toward a ban.
    const rawUrl = request.url.pathname + request.url.search;
    const shady = suspiciousRequestReason(rawUrl, request.headers["user-agent"] as string | undefined);
    if (shady) {
      recordFromRequest(request, "suspicious_request", shady);
      return h.response({ error: "Bad Request" }).code(400).takeover();
    }

    if (isThrottledAuthEndpoint) {
      // Refresh is routine (every hour per device): a wider bucket than password tries.
      const max = p === "/api/auth/refresh" ? ADMIN_LOGIN_RL_MAX() * 12 : ADMIN_LOGIN_RL_MAX();
      const key = `${p}:${ip}`;
      const now = Date.now();
      const entry = adminLoginRlMap.get(key);
      if (!entry || now - entry.windowStart > ADMIN_LOGIN_RL_WINDOW()) {
        adminLoginRlMap.set(key, { count: 1, windowStart: now });
      } else {
        entry.count++;
        if (entry.count > max) {
          if (entry.count === max + 1) recordFromRequest(request, "login_throttled");
          return h.response({ error: "Too Many Requests" }).code(429).takeover();
        }
      }
    }

    // Bucketed by stream family, not one shared bucket for every public stream
    // route — a runaway client-side retry loop against live TV (e.g. hls.js
    // hammering /live.m3u8 with no backoff on error) must only exhaust its own
    // bucket, never lock the same IP out of movie/series playback too.
    const isLiveStream = p.startsWith("/live.m3u8") || p.startsWith("/player/");
    const isVodStream = p.startsWith("/api/media/");
    // The unauthenticated image relays (an <img> cannot send a bearer token) get their
    // own bucket: a poster-heavy page is a few hundred requests, a scraper is thousands.
    const isImage = p.startsWith("/api/images/");

    if (isLiveStream || isVodStream || isImage) {
      const key = `${isLiveStream ? "live" : isVodStream ? "vod" : "img"}:${ip}`;
      const now = Date.now();
      const entry = rlMap.get(key);
      if (!entry || now - entry.windowStart > RL_WINDOW()) {
        rlMap.set(key, { count: 1, windowStart: now });
      } else {
        entry.count++;
        const max = isImage ? RL_MAX() * 5 : RL_MAX();
        if (entry.count > max) {
          if (entry.count === max + 1) recordFromRequest(request, "stream_throttled", isImage ? "images" : undefined);
          return h.response({ error: "Too Many Requests" }).code(429).takeover();
        }
      }
    }
    return h.continue;
  });

  // Security headers on every response. CSP stays permissive for sources (streams, TMDB
  // artwork, Google sign-in, Chromecast) but forbids plugins, eval and base-URL tricks.
  server.ext("onPreResponse", (request, h) => {
    const r: any = request.response;
    const set = (k: string, v: string) => {
      if (r?.isBoom) r.output.headers[k] = v; else r?.header?.(k, v);
    };
    set("X-Content-Type-Options", "nosniff");
    set("Referrer-Policy", "strict-origin-when-cross-origin");
    set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
    if (isSecureRequest(request)) set("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
    return h.continue;
  });

  // Global Auth Interceptor for Hapi endpoints
  server.ext("onPreHandler", async (request, h) => {
    const path = request.path;

    // Skip auth for static pages, media streams, image proxies, video stream proxies, and authorization endpoints
    if (
      (!path.startsWith("/api/") && !path.startsWith("/v2/")) ||
      path.startsWith("/api/auth/") ||
      path === "/api/health" || // uptime monitors; says nothing to anonymous callers
      path.startsWith("/api/images/") ||
      path.startsWith("/api/proxy") ||
      path.startsWith("/api/local/") || // local-library files: stream-token gated (routes/library/stream.ts)
      path.startsWith("/api/media/") ||
      path.startsWith("/api/v2/download") ||
      path.startsWith("/live.m3u8") ||
      path.startsWith("/player/") ||
      path.startsWith("/portal/proxy")
    ) {
      return h.continue;
    }

    const user = authCheck(request);
    if (!user) {
      // A missing header is just a signed-out client; a present-but-bad token is suspicious.
      if (request.headers.authorization) recordFromRequest(request, "token_invalid");
      return h.response({ error: "Unauthorized" }).code(401).takeover();
    }

    // The token says who the user is; the database says whether they still may be here
    // (disabled/deleted accounts and demoted admins used to keep access for up to an hour).
    if (typeof user.userId === "number") {
      const live = await accountStatus(user.userId);
      if (!live || !live.isActive) {
        recordFromRequest(request, "token_user_disabled", null, user.userId);
        return h.response({ error: "Unauthorized" }).code(401).takeover();
      }
      user.role = live.role;
    }

    // Attach user metadata to plugins state so handlers can access it
    (request.plugins as { user?: JWTPayload }).user = user;

    const isMutation = ["POST", "PUT", "DELETE", "PATCH"].includes(request.method.toUpperCase());

    // Paths that require admin regardless of HTTP method
    const isAdminOnlyPath =
      path.startsWith("/api/admin/") ||
      path.startsWith("/api/v2/debug") ||
      path.startsWith("/api/v2/refresh-") ||
      path.startsWith("/api/profiles") ||
      path.startsWith("/api/config") ||
      path === "/api/v2/reset-movies" ||
      path === "/api/v2/get-token";

    // User owns this data — any valid JWT, any method
    const isUserOwnData =
      path.startsWith("/api/user/") ||
      path === "/api/auth/device/authorize" ||
      path === "/api/auth/logout" ||
      path === "/api/v2/media-info";

    if ((isAdminOnlyPath || (isMutation && !isUserOwnData)) && user.role !== "admin") {
      recordFromRequest(request, "forbidden", `${request.method.toUpperCase()} ${path}`, user.userId as number | undefined);
      return h.response({ error: "Forbidden" }).code(403).takeover();
    }

    return h.continue;
  });

  const startTime = Date.now();
  server.route({
    method: "GET",
    path: "/api/health",
    options: { auth: false },
    handler: (request, h) => {
      return h.response({
        status: "ok",
        // Nothing about the setup (provider type, uptime) for anonymous callers.
        ...(authCheck(request) ? { uptimeSeconds: Math.floor((Date.now() - startTime) / 1000), provider: initialConfig.providerType ?? "unknown" } : {}),
      }).code(200);
    },
  });

  server.route({
    method: "GET",
    path: "/{param*}",
    handler: (request, h) => {
      const param = (request.params.param as string) || "";
      // An unknown API path is a 404, not the webui's index.html: clients probe newer
      // endpoints (e.g. /api/v2/epg/window) and must be able to tell they are missing.
      if (param === "api" || param.startsWith("api/")) {
        recordFromRequest(request, "unknown_api_path");
        return h.response({ error: "Not found" }).code(404);
      }
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
            CSP,
          )
          .header("X-Frame-Options", "SAMEORIGIN");
      }

      // Vite's bundle files carry a content hash in their name (assets/index-<hash>.js): a new
      // build is a new name, so browsers may keep them for a year without asking again. index.html
      // and sw.js (no hash) keep the default revalidation.
      if (/^assets\/[^/]+-[A-Za-z0-9_-]{8,}\.(js|css)$/.test(param)) {
        return h.file(filePath).header("Cache-Control", "public, max-age=31536000, immutable");
      }
      return h.file(filePath);
    },
  });

  server.events.on("response", function (request) {
    // No route reads a `password` query param any more, but players still
    // configured with the old Xtream-emulation URL keep polling
    // /player_api.php?username=…&password=… (now served by the SPA fallback)
    // — don't let those credentials land in the log.
    let logQs = request.url.search || "";
    if (logQs) {
      try {
        const params = new URLSearchParams(logQs);
        if (params.has("password")) params.set("password", "***");
        logQs = params.toString();
        if (logQs) logQs = "?" + logQs;
      } catch { /* leave malformed query strings as-is */ }
    }

    logger.info(
      request.info.remoteAddress +
        ": " +
        request.method.toUpperCase() +
        " " +
        request.path +
        logQs +
        " --> " +
        (request.response &&
        typeof (request.response as any).statusCode === "number"
          ? (request.response as any).statusCode
          : request.response &&
            (request.response as any).output &&
            (request.response as any).output.statusCode) +
        // How long the server took (responded - received): finds the slow endpoints.
        (request.info.responded ? ` (${request.info.responded - request.info.received} ms)` : "") +
        // A 500 says why (Hapi only sends "Internal Server Error" to the client).
        ((request.response as any)?.isBoom && (request.response as any).output?.statusCode >= 500
          ? ` [${String((request.response as any).message).slice(0, 300)}]`
          : ""),
    );
  });

  await server.start();
  startJobs();
  startPortalHealth();

  const { backgroundJobService } =
    await import("./services/BackgroundJobService");
  backgroundJobService.start();

  logger.info(`Server running at: ${server.info.uri}`);

  // In-memory Discover index (facets/browse): build now instead of on the first request.
  primeDiscoverIndex();
  // Watch progress in memory (content/viewers.ts): loaded now, so no request waits for it.
  viewersReady().catch((e) => logger.warn(`[viewers] load failed (retried on the next request): ${e?.message ?? e}`));
  // The "All" catalogs and their search indexes (content/catalogUnion.ts warms the index as
  // soon as a catalog exists), so the first search after a restart does not wait ~1.5 s.
  setTimeout(() => {
    (async () => {
      if (setting<boolean>("catalogSnapshot")) return; // the snapshot serves "All" (content/catalog/all.ts)
      const { getCatalogUnion } = await import("./content/catalogUnion");
      const { getActiveProfileId } = await import("./routes/stalkerV2/shared");
      const profileId = await getActiveProfileId();
      for (const type of ["movie", "series"] as const) await getCatalogUnion(type, profileId);
    })().catch((e) => logger.warn(`[search] startup warm-up failed: ${e?.message ?? e}`));
  }, 20_000).unref?.();
  // People search (content/peopleSearch.ts): built in a worker thread after the startup
  // warm-ups, rebuilt when enrichment or the people tidy changes who is in the catalog.
  setTimeout(() => void buildPeopleIndex(), 30_000).unref?.();
  // Home's title facts (content/home.ts): between the people index and the catalog snapshot.
  setTimeout(primeHomeFacts, 45_000).unref?.();
  // Catalog snapshot (content/catalog/store.ts, setting catalogSnapshot, off by default): after
  // the startup warm-ups so the two builds never peak together.
  // On: started now, since the "All" lists wait for it (a saved file loads in about 0.5 s).
  setTimeout(() => void startCatalogSnapshot().catch((e) => logger.warn(`[catalog] start failed: ${e?.message ?? e}`)), setting<boolean>("catalogSnapshot") ? 0 : 60_000).unref?.();
  onDiscoverCacheClear(markPeopleChanged);
  // Catalog changed (enrichment, edits): Home rows are rebuilt on the next open (content/home.ts).
  onDiscoverCacheClear(markHomeStale);
  // Inputs of catalog answers outside the change log (infra/answerVersion.ts, Phase 3a).
  onDiscoverCacheClear(bumpAnswerInputs);
  onMediaInfoChange(bumpAnswerInputs);
  onSettingChange(bumpAnswerInputs);
  // Channel logos for Discover (content/channels.ts): portal logos now, TMDB network logos
  // a minute later in the background (one-time, cached; retried weekly for misses).
  refreshChannelLogos();
  setTimeout(() => { resolveTmdbChannelLogos().catch(() => {}); }, 60_000).unref?.();

  // Warm the XtreamCache catalog in the background on startup (every /api/v2
  // movie/series route reads from it), then cleanup stale genres.
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
  // getEpgSnapshot() is null when the guide is missing or > 12 h old (same rule as
  // getEpgCache), and otherwise builds the served snapshot now instead of on the first request.
  getEpgSnapshot().then((cache) => {
    if (!cache) {
      fetchAndCacheEpg().catch((e) => logger.error(`[EPG startup] ${e}`));
    }
  }).catch((e) => logger.error(`[EPG startup check] ${e}`));

  // Re-warm the XtreamCache catalog every 24 hours
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

    // Broken-stream rows (docs/skill-stream-failures.md) untouched for 30
    // days — auto-hidden rows are kept as the record of why a title is hidden.
    try {
      const n = await purgeOldSecurityEvents();
      if (n > 0) logger.info(`[cleanup] Purged ${n} security event(s) older than 30 days.`);
    } catch (e) { logger.error(`[cleanup] security_events purge failed: ${e}`); }
    try {
      const n = await purgeRefreshTokens();
      if (n > 0) logger.info(`[cleanup] Purged ${n} expired/revoked refresh token(s).`);
    } catch (e) { logger.error(`[cleanup] refresh_tokens purge failed: ${e}`); }

    try {
      const failuresDeleted = await purgeStaleFailures();
      if (failuresDeleted > 0) logger.info(`[cleanup] Purged ${failuresDeleted} stale stream_failures row(s).`);
    } catch (e) { logger.error(`[cleanup] stream_failures purge failed: ${e}`); }
  };

  runDbCleanup().catch((e) => logger.error(`[cleanup startup] ${e}`));
  setInterval(() => runDbCleanup().catch((e) => logger.error(`[cleanup interval] ${e}`)), 24 * 60 * 60 * 1000);
};

process.on("unhandledRejection", (err) => {
  logger.error(`Unhandled rejection: ${err}`);
  process.exit(1);
});

init();
