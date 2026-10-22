import { uploadsDir } from "@/infra/paths";
import { maskConfig, unmaskConfig } from "@/config/providerSecrets";
import { ServerRoute } from "@hapi/hapi";
import { sniffRasterImage } from "@/infra/sniffImage";
import { recordFromRequest } from "@/services/SecurityEvents";
import * as fs from "fs/promises";
import * as path from "path";
import { logger } from "@/infra/logger";
import { serverManager } from "../serverManager";
import { initialConfig } from "@/config/server";
import { stalkerApi } from "@/providers/stalker";
import { ConfigProfile } from "@/models/ConfigProfile";
import crypto from "crypto";
import { socketService } from "@/services/SocketService";
import { createJWT, requireAdmin, secureCompare } from "@/auth/jwt";
import { SystemConfig } from "../models/SystemConfig";
import { Channel } from "@/models/Channel";
import { Genre } from "@/models/Genre";
import { EpgCache } from "@/models/EpgCache";
import { ContentCache } from "@/models/ContentCache";

// Uploads live in the data folder, beside the database, so they survive redeployments.
const uploadDir = uploadsDir;

export const configRoutes: ServerRoute[] = [
  {
    // Any logged-in user (not admin-gated — deliberately outside the /api/config
    // prefix the global onPreHandler treats as admin-only). The web UI needs an
    // identifier for the active provider to key per-provider preferences
    // (last-selected category etc.) and to decide when to run its initial load;
    // it used to read this from GET /api/config, which now 403s for non-admins
    // and would return the full config (credentials included) if it didn't.
    // Same `${type}_${host}` shape as before so already-saved preference keys
    // still match.
    method: "GET",
    path: "/api/v2/provider-key",
    handler: async () => ({
      // Stable per-provider key for client preferences. Was `<type>_<hostname>`, which
      // told every signed-in user the upstream portal's address; now a hash of it.
      providerKey: `${initialConfig.providerType || "stalker"}_${crypto.createHash("sha256").update(`${initialConfig.hostname || "default_host"}:${initialConfig.port || ""}`).digest("hex").slice(0, 16)}`,
    }),
  },
  {
    method: "GET",
    path: "/api/config",
    handler: async (request, h) => {
      if (!requireAdmin(request)) return h.response({ error: "Forbidden" }).code(403);
      // The password goes out as a placeholder; sending it back keeps the stored one.
      return maskConfig(initialConfig);
    },
  },
  {
    method: "POST",
    path: "/api/config",
    handler: async (request, h) => {
      if (!requireAdmin(request)) return h.response({ error: "Forbidden" }).code(403);
      try {
        const activeProfile = await ConfigProfile.findOne({ where: { isActive: true } });
        const newConfig = unmaskConfig(request.payload as any, activeProfile?.config);
        let finalConfig = activeProfile ? { ...activeProfile.config } : newConfig;

        if (activeProfile) {
          const updatedConfig = { ...activeProfile.config, ...newConfig };
          if (!newConfig.tokens) updatedConfig.tokens = activeProfile.config.tokens;

          activeProfile.config = updatedConfig;
          finalConfig = updatedConfig;
          await activeProfile.save();

          const profileId = activeProfile.id;
          await Channel.destroy({ where: { profileId } });
          await Genre.destroy({ where: { profileId } });
          await EpgCache.destroy({ where: { profileId } });
          await ContentCache.destroy({ where: { profileId } }); // Flush ContentCache as configuration profile changes
          logger.info(`Cleared cached database and content records for profile: ${activeProfile.name}`);
        } else {
          return h.response({ error: "No active profile found to update." }).code(404);
        }

        try {
          await serverManager.reloadConfig();
          stalkerApi.clearCache();
          const hash = crypto.createHash("md5").update(JSON.stringify(finalConfig)).digest("hex");
          socketService.broadcastConfigChange(hash);

          return { message: "Configuration updated and reloaded successfully.", hash };
        } catch (error) {
          logger.error({ err: error }, "Error reloading server config");
          return h.response({ error: "Configuration updated but server reload failed", details: error }).code(500);
        }
      } catch (error) {
        logger.error({ err: error }, "Error updating config");
        return h.response({ error: "Failed to update configuration" }).code(500);
      }
    },
  },
  {
    method: "POST",
    path: "/api/auth/admin",
    handler: async (request, h) => {
      try {
        const payload = request.payload as any;
        const providedPassword = payload?.password;
        const expectedPassword = process.env.ADMIN_PASSWORD;
          if (!expectedPassword) {
            return h.response({ error: "Server misconfiguration: ADMIN_PASSWORD not set" }).code(503);
          }

        if (typeof providedPassword === "string" && secureCompare(providedPassword, expectedPassword)) {
          const token = createJWT({ role: "admin" });
          return { success: true, token };
        } else {
          return h.response({ error: "Invalid password" }).code(401);
        }
      } catch (error) {
        logger.error({ err: error }, "Error during admin authentication");
        return h.response({ error: "Authentication failed" }).code(500);
      }
    },
  },
  {
    method: "POST",
    path: "/api/clear-cache",
    handler: async (request, h) => {
      if (!requireAdmin(request)) return h.response({ error: "Forbidden" }).code(403);
      try {
        serverManager.getProvider().clearCache();
        const activeProfile = await ConfigProfile.findOne({ where: { isActive: true } });
        if (activeProfile) {
          const profileId = activeProfile.id;
          await Channel.destroy({ where: { profileId } });
          await Genre.destroy({ where: { profileId } });
          await EpgCache.destroy({ where: { profileId } });
          await ContentCache.destroy({ where: { profileId } }); // Manual purge removes persistent entries instantly!
          logger.info(`Cleared cached database and video content records for profile: ${activeProfile.name}`);
        }
        return { success: true, message: "Cache cleared successfully." };
      } catch (error: any) {
        logger.error({ err: error }, "Error clearing cache");
        return h.response({ success: false, error: error.message }).code(500);
      }
    },
  },
  {
    method: "GET",
    path: "/uploads/{param*}",
    handler: {
      directory: {
        path: uploadDir,
        redirectToSlash: true,
        index: false,
      },
    },
  },
];