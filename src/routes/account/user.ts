import { cleanLeagueChoice } from "@/content/sports";
import { withProgressMirrors } from "@/content/progressMirror";
import { uploadsDir } from "@/infra/paths";
import { setting } from "@/config/settings";
import { sealCmd } from "@/infra/sealedCmd";
import { ServerRoute } from "@hapi/hapi";
import { sniffRasterImage } from "@/infra/sniffImage";
import crypto from "crypto";
import { recordFromRequest } from "@/services/SecurityEvents";
import axios from "axios";
import { subtitleKeysFor, forgetSubtitleKeys } from "@/content/subtitleKeys";
import { logger } from "@/infra/logger";
import { User } from "../../models/User";
import { progressRows, saveProgress, deleteProgress } from "@/content/viewers";
import { titleRows } from "@/content/catalog/cards";
import { ConfigProfile } from "../../models/ConfigProfile";
import { authCheck } from "../../auth/jwt";
import { encryptSecret } from "../../auth/crypto";
import { forgetOpenSubtitlesSession, linkOpenSubtitlesAccount } from "../../content/opensubtitles";
import { proxiedImageUrl } from "@/providers/portalAssets";
import { getPublicOrigin } from "@/infra/publicUrl";
import { socketService } from "@/services/SocketService";
import fs from "fs/promises";
import path from "path";

// Uploads live in the data folder, beside the database, so they survive redeployments.
const uploadDir = uploadsDir;

const getActiveProfileId = async () => {
  const activeProfile = await ConfigProfile.findOne({
    where: { isActive: true },
  });
  return activeProfile?.id || 1;
};

export const userRoutes: ServerRoute[] = [
  {
    method: "GET",
    path: "/api/user/profile",
    handler: async (request, h) => {
      const userPayload = authCheck(request);
      if (!userPayload) {
        return h.response({ error: "Unauthorized" }).code(401);
      }

      try {
        const user = await User.findByPk(userPayload.userId);
        if (!user || !user.isActive) {
          return h.response({ error: "User inactive or not found" }).code(401);
        }

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          avatarUrl: user.avatarUrl,
          preferences: user.preferences || {}
        };
      } catch (error) {
        logger.error({ err: error }, "Error fetching user profile");
        return h.response({ error: "Internal Server Error" }).code(500);
      }
    },
  },
  {
    method: "PUT",
    path: "/api/user/preferences",
    handler: async (request, h) => {
      const userPayload = authCheck(request);
      if (!userPayload) {
        return h.response({ error: "Unauthorized" }).code(401);
      }

      try {
        const user = await User.findByPk(userPayload.userId);
        if (!user || !user.isActive) {
          return h.response({ error: "User inactive or not found" }).code(401);
        }

        const payload = request.payload as any;

        // Allowlist rather than spreading the raw client payload wholesale —
        // keeps this JSON column limited to the shape User.preferences
        // actually declares instead of accepting/persisting arbitrary
        // client-supplied keys (defense-in-depth; plain object-literal
        // spread doesn't trigger real __proto__ pollution since it uses
        // CopyDataProperties rather than [[Set]], but there's no reason to
        // accept unbounded junk into the DB either).
        const ALLOWED_PREF_KEYS = [
          "preferredContentType",
          "favorites",
          "recentChannels",
          "videoFitMode",
          "lastSelectedCategory",
          "lastSelectedCategoryTitle",
          "lastSelectedTvGroup",
          "lastSelectedTvChannel",
          "recentCategories",
          "pinnedCategories",
          "categoryOrder",
          "recentSearches",
          "sportsLeagues",
        ] as const;
        const filteredPayload: Record<string, unknown> = {};
        if (payload && typeof payload === "object") {
          for (const key of ALLOWED_PREF_KEYS) {
            if (key in payload) filteredPayload[key] = payload[key];
          }
          // Only known league names, at most 20 (content/sports.ts).
          if ("sportsLeagues" in filteredPayload) {
            const clean = cleanLeagueChoice(filteredPayload.sportsLeagues);
            if (clean === null) delete filteredPayload.sportsLeagues;
            else filteredPayload.sportsLeagues = clean;
          }
        }

        // Merge incoming preferences with current preferences
        const currentPrefs = user.preferences || {};
        user.preferences = {
          ...currentPrefs,
          ...filteredPayload
        };

        // Sequelize requires us to set changed flag for JSON columns
        user.changed("preferences", true);
        await user.save();

        socketService.broadcastPreferencesChanged(user.id, user.preferences);

        return { success: true, preferences: user.preferences };
      } catch (error) {
        logger.error({ err: error }, "Error updating user preferences");
        return h.response({ error: "Internal Server Error" }).code(500);
      }
    },
  },
  {
    method: "GET",
    path: "/api/user/progress",
    handler: async (request, h) => {
      const userPayload = authCheck(request);
      if (!userPayload) {
        return h.response({ error: "Unauthorized" }).code(401);
      }

      try {
        const profileId = await getActiveProfileId();
        // From the viewer store (content/viewers.ts), in the table's order.
        const progressRecords = await progressRows(userPayload.userId, profileId);
        // Sequelize's SQLite JSON column doesn't reliably auto-parse `meta` on
        // read in this setup — it can come back as the raw stored string
        // instead of a nested object, which serializes over HTTP as a
        // double-encoded JSON string (`"meta": "{\"title\":...}"` instead of
        // `"meta": {"title":...}`). The frontend's `record.meta as Type` cast
        // silently accepts either shape at compile time, so every `entry.*`
        // field reads as undefined at runtime without this — normalize here.
        const origin = getPublicOrigin(request);
        const plainRows = progressRecords.map((r) => {
          const plain = r as any;
          if (typeof plain.meta === "string") {
            try { plain.meta = JSON.parse(plain.meta); } catch { /* leave as-is */ }
          }
          // meta.screenshot_uri was saved verbatim from whatever the client had
          // in-memory at playback time (see webui's useProgressTracking.ts) —
          // rows saved before proxiedImageUrl existed still carry the raw
          // upstream portal/CDN URL, which never self-heals since this row is
          // never rebuilt from the catalog. Every other surface re-proxies at
          // serve time (enrichArtworkFromTmdb, mapChannel, Discover's
          // toMediaItem); do the same here so old rows aren't stuck forever.
          if (plain.meta && typeof plain.meta === "object" && typeof plain.meta.screenshot_uri === "string") {
            plain.meta.screenshot_uri = proxiedImageUrl(plain.meta.screenshot_uri, origin);
          }
          return plain;
        });
        // Every version of a title resumes at the newest position (content/progressMirror.ts).
        const rows = await withProgressMirrors(plainRows);
        // The title's wide art for Continue Watching cards (design Phase 6): backdrop_path, read
        // from the catalog when answering, never stored with the progress.
        const ids = [...new Set(rows.map((r: any) => (r.meta && typeof r.meta === "object" ? r.meta.catalogId : null)).filter((x: unknown): x is string => typeof x === "string" && /^(movie|series)_/.test(x)))];
        if (ids.length) {
          const { rows: titles } = await titleRows(ids);
          for (const r of rows as any[]) {
            const t: any = r.meta && typeof r.meta === "object" ? titles.get(r.meta.catalogId) : null;
            const art = t ? t.backdropHd || t.backdrop : null;
            if (art) r.backdrop_path = proxiedImageUrl(art, origin);
          }
        }
        return rows;
      } catch (error) {
        logger.error({ err: error }, "Error fetching user progress");
        return h.response({ error: "Internal Server Error" }).code(500);
      }
    },
  },
  {
    method: "PUT",
    path: "/api/user/progress",
    handler: async (request, h) => {
      const userPayload = authCheck(request);
      if (!userPayload) {
        return h.response({ error: "Unauthorized" }).code(401);
      }

      try {
        const payload = request.payload as any;
        const { mediaId, progress, completed, meta } = payload;

        if (!mediaId) {
          return h.response({ error: "Missing mediaId" }).code(400);
        }

        const profileId = await getActiveProfileId();
        await saveProgress(
          userPayload.userId,
          profileId,
          String(mediaId),
          Number(progress || 0),
          !!completed,
          // An upstream stream link a client sends along is stored sealed, never readable.
          meta && typeof meta === "object" && "cmd" in meta ? { ...meta, cmd: sealCmd(meta.cmd) } : meta ?? {},
        );

        return { success: true };
      } catch (error) {
        logger.error({ err: error }, "Error updating progress");
        return h.response({ error: "Internal Server Error" }).code(500);
      }
    },
  },
  {
    method: "POST",
    path: "/api/user/clear-history",
    handler: async (request, h) => {
      const userPayload = authCheck(request);
      if (!userPayload) {
        return h.response({ error: "Unauthorized" }).code(401);
      }

      try {
        const profileId = await getActiveProfileId();
        // Delete all progress for this profile
        await deleteProgress(userPayload.userId, profileId);

        // Clear recents
        const user = await User.findByPk(userPayload.userId);
        if (user) {
          user.preferences = {
            ...(user.preferences || {}),
            recentChannels: []
          };
          user.changed("preferences", true);
          await user.save();
          socketService.broadcastPreferencesChanged(user.id, user.preferences);
        }

        return { success: true };
      } catch (error) {
        logger.error({ err: error }, "Error clearing history");
        return h.response({ error: "Internal Server Error" }).code(500);
      }
    },
  },
  {
    method: "DELETE",
    path: "/api/user/progress/{mediaId}",
    handler: async (request, h) => {
      const userPayload = authCheck(request);
      if (!userPayload) {
        return h.response({ error: "Unauthorized" }).code(401);
      }

      try {
        const { mediaId } = request.params;
        const profileId = await getActiveProfileId();
        await deleteProgress(userPayload.userId, profileId, String(mediaId));
        return { success: true };
      } catch (error) {
        logger.error({ err: error }, "Error deleting progress");
        return h.response({ error: "Internal Server Error" }).code(500);
      }
    },
  },
  {
    method: "POST",
    path: "/api/user/avatar",
    options: {
      payload: {
        maxBytes: 5 * 1024 * 1024,
        output: "data",
        parse: true,
        multipart: true,
      },
    },
    handler: async (request, h) => {
      const userPayload = authCheck(request);
      if (!userPayload) {
        return h.response({ error: "Unauthorized" }).code(401);
      }

      try {
        const user = await User.findByPk(userPayload.userId);
        if (!user || !user.isActive) {
          return h.response({ error: "User inactive or not found" }).code(401);
        }

        const payload = request.payload as any;
        const file = payload?.file;
        if (!file) {
          return h.response({ error: "No file provided" }).code(400);
        }

        // Only real raster images, judged by content (a .png that is really HTML or SVG
        // would be served from our origin as whatever it is). The stored name is ours.
        const kind = sniffRasterImage(file as Buffer);
        if (!kind) {
          recordFromRequest(request, "upload_rejected", "avatar is not a raster image", user.id);
          return h.response({ error: "Only PNG, JPEG, GIF or WebP images are allowed" }).code(400);
        }
        const uniqueFilename = `${Date.now()}-${crypto.randomBytes(6).toString("hex")}.${kind}`;

        await fs.mkdir(uploadDir, { recursive: true });
        const filePath = path.join(uploadDir, uniqueFilename);
        await fs.writeFile(filePath, file);

        const urlPath = `/uploads/${uniqueFilename}`;
        user.avatarUrl = urlPath;
        await user.save();

        return { success: true, avatarUrl: urlPath };
      } catch (error) {
        console.error("Error uploading avatar:", error);
        return h.response({ error: "Internal Server Error" }).code(500);
      }
    },
  },
  {
    method: "GET",
    path: "/api/user/opensubtitles",
    handler: async (request, h) => {
      const userPayload = authCheck(request);
      if (!userPayload) return h.response({ error: "Unauthorized" }).code(401);

      const user = await User.findByPk(userPayload.userId);
      if (!user) return h.response({ error: "User not found" }).code(404);

      return {
        linked: Boolean(user.openSubtitlesUsername),
        username: user.openSubtitlesUsername || null,
        // Keys are never returned, only whether they are set (own) or provided by the server.
        hasOwnApiKey: Boolean(user.openSubtitlesApiKeyEnc),
        serverHasApiKey: Boolean(setting<string>("openSubtitlesKey")),
        subdl: { hasOwnApiKey: Boolean(user.subdlApiKeyEnc), serverHasApiKey: Boolean(setting<string>("subdlKey")) },
      };
    },
  },
  {
    method: "PUT",
    path: "/api/user/opensubtitles",
    handler: async (request, h) => {
      const userPayload = authCheck(request);
      if (!userPayload) return h.response({ error: "Unauthorized" }).code(401);

      const { username, password, apiKey } = request.payload as { username?: string; password?: string; apiKey?: string };
      const ownKey = typeof apiKey === "string" ? apiKey.trim() : "";
      if (ownKey && (ownKey.length < 16 || ownKey.length > 128)) {
        return h.response({ error: "That does not look like an OpenSubtitles API key" }).code(400);
      }
      if ((username && !password) || (!username && password)) {
        return h.response({ error: "Enter both username and password" }).code(400);
      }
      if (!username && !ownKey) return h.response({ error: "Nothing to save" }).code(400);

      const user = await User.findByPk(userPayload.userId);
      if (!user) return h.response({ error: "User not found" }).code(404);
      const keyToUse = ownKey || (user.openSubtitlesApiKeyEnc ? (await subtitleKeysFor(user.id)).openSubtitles : setting<string>("openSubtitlesKey"));

      if (username && password) {
        // Verify the credentials actually work before storing them — an
        // unlinkable typo'd account is worse than no linked account at all,
        // since downloads would silently keep falling back to the shared pool.
        const result = await linkOpenSubtitlesAccount(username, password, keyToUse);
        if (!result.success) return h.response({ error: result.error || "Login failed" }).code(400);
        user.openSubtitlesUsername = username;
        user.openSubtitlesPasswordEnc = encryptSecret(password);
      } else if (ownKey) {
        // Key only: check it is accepted by a tiny search before storing it.
        const probe = await axios.get("https://api.opensubtitles.com/api/v1/infos/formats", {
          headers: { "Api-Key": ownKey, "User-Agent": "PortalCast-Server" }, timeout: 8000, validateStatus: () => true,
        });
        if (probe.status === 401 || probe.status === 403) return h.response({ error: "OpenSubtitles rejected that API key" }).code(400);
      }
      if (ownKey) user.openSubtitlesApiKeyEnc = encryptSecret(ownKey);
      await user.save();
      forgetSubtitleKeys(user.id);
      forgetOpenSubtitlesSession(user.id);

      return { success: true };
    },
  },
  {
    method: "DELETE",
    path: "/api/user/opensubtitles",
    handler: async (request, h) => {
      const userPayload = authCheck(request);
      if (!userPayload) return h.response({ error: "Unauthorized" }).code(401);

      const user = await User.findByPk(userPayload.userId);
      if (!user) return h.response({ error: "User not found" }).code(404);

      user.openSubtitlesUsername = null as any;
      user.openSubtitlesPasswordEnc = null as any;
      user.openSubtitlesApiKeyEnc = null as any;
      await user.save();
      forgetSubtitleKeys(user.id);
      forgetOpenSubtitlesSession(user.id);

      return { success: true };
    },
  },
  {
    // The user's own SubDL key (free at subdl.com). Checked with a search before saving.
    method: "PUT",
    path: "/api/user/subdl",
    handler: async (request, h) => {
      const userPayload = authCheck(request);
      if (!userPayload) return h.response({ error: "Unauthorized" }).code(401);
      const apiKey = String((request.payload as any)?.apiKey ?? "").trim();
      if (apiKey.length < 8 || apiKey.length > 128) return h.response({ error: "That does not look like a SubDL API key" }).code(400);
      const probe = await axios.get("https://api.subdl.com/api/v1/subtitles", {
        params: { api_key: apiKey, film_name: "Inception", type: "movie", languages: "EN", subs_per_page: 1 },
        timeout: 8000, validateStatus: () => true,
      });
      if (probe.status === 401 || probe.status === 403 || probe.data?.status === false && /key/i.test(String(probe.data?.error ?? ""))) {
        return h.response({ error: "SubDL rejected that API key" }).code(400);
      }
      const user = await User.findByPk(userPayload.userId);
      if (!user) return h.response({ error: "User not found" }).code(404);
      user.subdlApiKeyEnc = encryptSecret(apiKey);
      await user.save();
      forgetSubtitleKeys(user.id);
      return { success: true };
    },
  },
  {
    method: "DELETE",
    path: "/api/user/subdl",
    handler: async (request, h) => {
      const userPayload = authCheck(request);
      if (!userPayload) return h.response({ error: "Unauthorized" }).code(401);
      const user = await User.findByPk(userPayload.userId);
      if (!user) return h.response({ error: "User not found" }).code(404);
      user.subdlApiKeyEnc = null as any;
      await user.save();
      forgetSubtitleKeys(user.id);
      return { success: true };
    },
  },
];
