import { ServerRoute } from "@hapi/hapi";
import { User } from "@/models/User";
import { hashPassword } from "@/auth/password";
import { createJWT } from "@/auth/jwt";
import { issueRefreshToken } from "@/services/RefreshTokens";
import { clientIp } from "@/infra/clientIp";
import { saveSetting, setting } from "@/config/settings";
import { logger } from "@/infra/logger";

// First start, like Jellyfin's setup wizard: when the server has no admin account and no
// ADMIN_PASSWORD, the web page asks for one instead of the compose file. The first person
// to finish it becomes admin, so finish it right after installing. Once any admin exists
// (or ADMIN_PASSWORD is set) both routes refuse, permanently.

export async function needsSetup(): Promise<boolean> {
  if (process.env.ADMIN_PASSWORD) return false;
  return (await User.count({ where: { role: "admin" } })) === 0;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 10;

export const setupRoutes: ServerRoute[] = [
  {
    method: "GET",
    path: "/api/auth/setup/status",
    handler: async () => ({ needsSetup: await needsSetup(), minPasswordLength: MIN_PASSWORD }),
  },
  {
    method: "POST",
    path: "/api/auth/setup",
    options: { payload: { maxBytes: 16 * 1024 } },
    handler: async (request, h) => {
      if (!(await needsSetup())) return h.response({ error: "Setup is already done. Sign in instead." }).code(409);
      const body = (request.payload || {}) as { name?: string; email?: string; password?: string; clientType?: string };
      const email = String(body.email || "").trim().toLowerCase();
      const name = String(body.name || "").trim().slice(0, 80) || "Administrator";
      const password = String(body.password || "");
      if (!EMAIL_RE.test(email)) return h.response({ error: "Enter a valid email address" }).code(400);
      if (password.length < MIN_PASSWORD) return h.response({ error: `Use a password of at least ${MIN_PASSWORD} characters` }).code(400);

      const { hash, salt } = hashPassword(password);
      let user = await User.findOne({ where: { email } });
      if (user) {
        Object.assign(user, { role: "admin", isActive: true, passwordHash: hash, salt, name: user.name || name });
      } else {
        user = User.build({
          email, name, role: "admin", isActive: true, passwordHash: hash, salt,
          preferences: { preferredContentType: "movie", favorites: [], recentChannels: [] },
        } as any);
      }
      user.lastLogin = new Date();
      await user.save();
      // The admin email also receives account-approval mails; keep it unless one is set.
      if (!setting<string>("adminEmail")) await saveSetting("adminEmail", email);
      logger.info(`[setup] first admin account created (${email}) from ${clientIp(request)}`);

      const accessToken = createJWT({ userId: user.id, email: user.email, role: "admin" }, 3600);
      const refreshToken = await issueRefreshToken(user.id, body.clientType || "web", clientIp(request));
      return {
        accessToken,
        refreshToken,
        user: { id: user.id, email: user.email, name: user.name, role: "admin", avatarUrl: user.avatarUrl },
      };
    },
  },
];
