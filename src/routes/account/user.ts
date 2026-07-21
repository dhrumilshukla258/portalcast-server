import { ServerRoute } from "@hapi/hapi";
import { logger } from "@/infra/logger";
import { User } from "../../models/User";
import { UserProgress } from "../../models/UserProgress";
import { ConfigProfile } from "../../models/ConfigProfile";
import { authCheck } from "../../auth/jwt";
import { encryptSecret } from "../../auth/crypto";
import { linkOpenSubtitlesAccount } from "../../content/opensubtitles";
import fs from "fs/promises";
import path from "path";

// Store uploads in the same persistent volume as the database so they survive redeployments
const dataDir = process.env.DATABASE_PATH
  ? path.dirname(process.env.DATABASE_PATH)
  : path.join(process.cwd(), "data");
const uploadDir = path.join(dataDir, "uploads");

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

        // Merge incoming preferences with current preferences
        const currentPrefs = user.preferences || {};
        user.preferences = {
          ...currentPrefs,
          ...payload
        };

        // Sequelize requires us to set changed flag for JSON columns
        user.changed("preferences", true);
        await user.save();

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
        const progressRecords = await UserProgress.findAll({
          where: { userId: userPayload.userId, profileId }
        });
        // Sequelize's SQLite JSON column doesn't reliably auto-parse `meta` on
        // read in this setup — it can come back as the raw stored string
        // instead of a nested object, which serializes over HTTP as a
        // double-encoded JSON string (`"meta": "{\"title\":...}"` instead of
        // `"meta": {"title":...}`). The frontend's `record.meta as Type` cast
        // silently accepts either shape at compile time, so every `entry.*`
        // field reads as undefined at runtime without this — normalize here.
        return progressRecords.map((r) => {
          const plain = r.toJSON() as any;
          if (typeof plain.meta === "string") {
            try { plain.meta = JSON.parse(plain.meta); } catch { /* leave as-is */ }
          }
          return plain;
        });
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
        await UserProgress.upsert({
          userId: userPayload.userId,
          profileId,
          mediaId: String(mediaId),
          progress: Number(progress || 0),
          completed: !!completed,
          meta: meta ?? {}
        });

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
        await UserProgress.destroy({
          where: { userId: userPayload.userId, profileId }
        });

        // Clear recents
        const user = await User.findByPk(userPayload.userId);
        if (user) {
          user.preferences = {
            ...(user.preferences || {}),
            recentChannels: []
          };
          user.changed("preferences", true);
          await user.save();
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
        await UserProgress.destroy({
          where: {
            userId: userPayload.userId,
            profileId,
            mediaId: String(mediaId),
          },
        });
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

        const filename = file.hapi?.filename || `avatar-${Date.now()}`;
        const cleanFilename = filename.replace(/[^a-zA-Z0-9.\-_]/g, "_");
        const uniqueFilename = `${Date.now()}-${cleanFilename}`;

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
      };
    },
  },
  {
    method: "PUT",
    path: "/api/user/opensubtitles",
    handler: async (request, h) => {
      const userPayload = authCheck(request);
      if (!userPayload) return h.response({ error: "Unauthorized" }).code(401);

      const { username, password } = request.payload as { username?: string; password?: string };
      if (!username || !password) {
        return h.response({ error: "Missing username or password" }).code(400);
      }

      // Verify the credentials actually work before storing them — an
      // unlinkable typo'd account is worse than no linked account at all,
      // since downloads would silently keep falling back to the shared pool.
      const result = await linkOpenSubtitlesAccount(username, password);
      if (!result.success) {
        return h.response({ error: result.error || "Login failed" }).code(400);
      }

      const user = await User.findByPk(userPayload.userId);
      if (!user) return h.response({ error: "User not found" }).code(404);

      user.openSubtitlesUsername = username;
      user.openSubtitlesPasswordEnc = encryptSecret(password);
      await user.save();

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
      await user.save();

      return { success: true };
    },
  },
];
