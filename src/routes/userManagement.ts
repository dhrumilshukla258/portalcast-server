import { ServerRoute } from "@hapi/hapi";
import { Op } from "sequelize";
import { logger } from "@/infra/logger";
import { User } from "../models/User";
import { authCheck } from "../auth/jwt";
import { hashPassword } from "../auth/password";
import { sendUserApprovedEmail } from "@/auth/email";
import { socketService } from "@/services/SocketService";
import { StrmMovie } from "@/models/StrmMovie";
import { StrmSeries } from "@/models/StrmSeries";
import { streamTracker } from "@/services/StreamTracker";

export const userManagementRoutes: ServerRoute[] = [
  {
    method: "GET",
    path: "/api/admin/streams",
    handler: (request, h) => {
      const userPayload = authCheck(request);
      if (!userPayload || userPayload.role !== "admin") {
        return h.response({ error: "Forbidden" }).code(403);
      }
      return { count: streamTracker.count(), sessions: streamTracker.list() };
    },
  },
  {
    method: "GET",
    path: "/api/admin/stats",
    handler: async (request, h) => {
      const userPayload = authCheck(request);
      if (!userPayload || userPayload.role !== "admin") {
        return h.response({ error: "Forbidden" }).code(403);
      }

      try {
        const dayAgo = new Date(Date.now() - 24 * 3600 * 1000);
        const weekAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000);

        const [
          totalUsers,
          activeUsers,
          pendingUsers,
          adminUsers,
          loggedInLast24h,
          loggedInLast7d,
          recentLogins,
          strmMovieCount,
          strmSeriesCount,
        ] = await Promise.all([
          User.count(),
          User.count({ where: { isActive: true } }),
          User.count({ where: { isActive: false } }),
          User.count({ where: { role: "admin" } }),
          User.count({ where: { lastLogin: { [Op.gte]: dayAgo } } }),
          User.count({ where: { lastLogin: { [Op.gte]: weekAgo } } }),
          User.findAll({
            where: { lastLogin: { [Op.ne]: null } },
            order: [["lastLogin", "DESC"]],
            limit: 10,
            attributes: ["id", "name", "email", "role", "lastLogin"],
          }),
          StrmMovie.count(),
          StrmSeries.count(),
        ]);

        return {
          users: {
            total: totalUsers,
            active: activeUsers,
            pending: pendingUsers,
            admins: adminUsers,
            loggedInLast24h,
            loggedInLast7d,
          },
          recentLogins,
          connectedDevices: socketService.getActiveDeviceCount(),
          activeStreams: streamTracker.count(),
          strm: {
            movies: strmMovieCount,
            episodes: strmSeriesCount,
          },
        };
      } catch (error) {
        logger.error({ err: error }, "Error loading admin stats");
        return h.response({ error: "Internal Server Error" }).code(500);
      }
    },
  },
  {
    method: "GET",
    path: "/api/admin/users",
    handler: async (request, h) => {
      const userPayload = authCheck(request);
      if (!userPayload || userPayload.role !== "admin") {
        return h.response({ error: "Forbidden" }).code(403);
      }

      try {
        const users = await User.findAll({
          order: [["createdAt", "DESC"]]
        });
        // Same raw-model-array serialization quirk as GET /api/user/progress
        // (see the comment there) — `preferences` is also a JSON column and
        // can come back double-encoded as a string instead of a nested object.
        return users.map((u) => {
          const plain = u.toJSON() as any;
          if (typeof plain.preferences === "string") {
            try { plain.preferences = JSON.parse(plain.preferences); } catch { /* leave as-is */ }
          }
          delete plain.passwordHash;
          delete plain.salt;
          delete plain.openSubtitlesPasswordEnc;
          return plain;
        });
      } catch (error) {
        logger.error({ err: error }, "Error listing users");
        return h.response({ error: "Internal Server Error" }).code(500);
      }
    },
  },
  {
    method: "POST",
    path: "/api/admin/users",
    handler: async (request, h) => {
      const userPayload = authCheck(request);
      if (!userPayload || userPayload.role !== "admin") {
        return h.response({ error: "Forbidden" }).code(403);
      }

      try {
        const payload = request.payload as any;
        const { email, name, role, isActive, password } = payload;

        if (!email || !name) {
          return h.response({ error: "Email and Name are required" }).code(400);
        }

        const normalizedEmail = email.toLowerCase().trim();

        const existing = await User.findOne({ where: { email: normalizedEmail } });
        if (existing) {
          return h.response({ error: "User with this email already exists" }).code(400);
        }

        let passwordFields = {};
        if (password && password.trim().length >= 6) {
          const { hash, salt } = hashPassword(password);
          passwordFields = { passwordHash: hash, salt };
        } else if (password) {
          return h.response({ error: "Password must be at least 6 characters" }).code(400);
        }

        const newUser = await User.create({
          email: normalizedEmail,
          name: name.trim(),
          role: role || "user",
          isActive: isActive !== undefined ? !!isActive : true,
          preferences: {
            preferredContentType: "movie",
            favorites: [],
            recentChannels: []
          },
          ...passwordFields
        });

        // Don't return credentials fields in response
        const resUser = newUser.toJSON() as any;
        delete resUser.passwordHash;
        delete resUser.salt;
        return resUser;
      } catch (error) {
        logger.error({ err: error }, "Error creating user");
        return h.response({ error: "Internal Server Error" }).code(500);
      }
    },
  },
  {
    method: "PUT",
    path: "/api/admin/users/{id}",
    handler: async (request, h) => {
      const userPayload = authCheck(request);
      if (!userPayload || userPayload.role !== "admin") {
        return h.response({ error: "Forbidden" }).code(403);
      }

      try {
        const id = request.params.id;
        const payload = request.payload as any;
        const { name, role, isActive, password } = payload;

        const user = await User.findByPk(id);
        if (!user) {
          return h.response({ error: "User not found" }).code(404);
        }

        if (Number(user.id) === Number(userPayload.userId)) {
          if (isActive === false) {
            return h.response({ error: "You cannot disable your own account" }).code(400);
          }
          if (role && role !== "admin") {
            return h.response({ error: "You cannot change your own admin role" }).code(400);
          }
        }

        // Check if the user is being newly approved
        const wasInactive = !user.isActive;
        const isBeingActivated = isActive === true;
        const isNewlyApproved = wasInactive && isBeingActivated;

        if (name !== undefined) user.name = name.trim();
        if (role !== undefined) user.role = role;
        if (isActive !== undefined) user.isActive = !!isActive;

        if (password) {
          if (password.trim().length < 6) {
            return h.response({ error: "Password must be at least 6 characters" }).code(400);
          }
          const { hash, salt } = hashPassword(password);
          user.passwordHash = hash;
          user.salt = salt;
        }

        await user.save();

        // Trigger the approval email if the status changed from inactive to active
        if (isNewlyApproved) {
          sendUserApprovedEmail(user.name, user.email).catch(err => {
            logger.error({ err }, "Failed to send user approval email after admin update");
          });
        }

        const resUser = user.toJSON() as any;
        delete resUser.passwordHash;
        delete resUser.salt;
        return resUser;
      } catch (error) {
        logger.error({ err: error }, "Error updating user");
        return h.response({ error: "Internal Server Error" }).code(500);
      }
    },
  },
  {
    method: "DELETE",
    path: "/api/admin/users/{id}",
    handler: async (request, h) => {
      const userPayload = authCheck(request);
      if (!userPayload || userPayload.role !== "admin") {
        return h.response({ error: "Forbidden" }).code(403);
      }

      try {
        const id = request.params.id;

        const user = await User.findByPk(id);
        if (!user) {
          return h.response({ error: "User not found" }).code(404);
        }

        // Prevent admin from deleting themselves
        if (Number(user.id) === Number(userPayload.userId)) {
          return h.response({ error: "You cannot delete your own account" }).code(400);
        }

        await user.destroy();
        return { success: true, message: "User deleted successfully" };
      } catch (error) {
        logger.error({ err: error }, "Error deleting user");
        return h.response({ error: "Internal Server Error" }).code(500);
      }
    },
  },
];
