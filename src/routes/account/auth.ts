import { setting } from "@/config/settings";
import { ServerRoute } from "@hapi/hapi";
import { issueRefreshToken, rotateRefreshToken, revokeRefreshToken, revokeAllForUser } from "../../services/RefreshTokens";
import { recordFromRequest } from "../../services/SecurityEvents";
import { clientIp } from "../../infra/clientIp";
import { logger } from "@/infra/logger";
import { OAuth2Client } from "google-auth-library";
import crypto from "crypto";
import { User } from "../../models/User";
import { DeviceCode } from "../../models/DeviceCode";
import { createJWT, verifyJWT, authCheck, secureCompare } from "../../auth/jwt";
import { v4 as uuidv4 } from "uuid";
import { verifyPassword, hashPassword } from "../../auth/password";
import { sendAdminApprovalRequest, sendPasswordResetEmail } from "../../auth/email";
import { getPublicOrigin } from "../../infra/publicUrl";
import { jellyfinConfig, jellyfinAuthenticate } from "@/content/library/jellyfin";
import { encryptSecret } from "@/auth/crypto";

const client = new OAuth2Client();

// Helper to generate 6-character user friendly codes (e.g. AB-CDE)
function generateUserCode(): string {
  const chars = "ABCDEFGHIJKLMNPQRSTUVWXYZ23456789"; // readable chars
  let code = "";
  for (let i = 0; i < 6; i++) {
    if (i === 3) code += "-";
    code += chars.charAt(crypto.randomInt(chars.length));
  }
  return code;
}

// Helper to sanitize code for comparison
function sanitizeCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z2-9]/g, "");
}

export const authRoutes: ServerRoute[] = [
  {
    method: "POST",
    path: "/api/auth/google",
    handler: async (request, h) => {
      try {
        const payload = request.payload as any;
        const idToken = payload?.idToken;
        const clientType = payload?.clientType || "web"; // 'web' or 'tv'

        if (!idToken) {
          return h.response({ error: "Missing ID Token" }).code(400);
        }

        let googlePayload;
        try {
          const ticket = await client.verifyIdToken({
            idToken,
            audience: setting<string>("googleClientId"),
          });
          googlePayload = ticket.getPayload();
        } catch (err: any) {
          logger.error({ err }, "Google token verification failed");
          recordFromRequest(request, "google_token_invalid");
          return h.response({ error: "Invalid Google ID Token" }).code(401);
        }

        if (!googlePayload || !googlePayload.email) {
          return h.response({ error: "Failed to parse Google user payload" }).code(400);
        }

        const email = googlePayload.email.toLowerCase();
        const name = googlePayload.name || googlePayload.email.split("@")[0];
        const avatarUrl = googlePayload.picture || null;

        // Check if user is Admin
        const adminEmailStr = setting<string>("adminEmail");
        const adminEmailsList = setting<string[]>("adminEmails").map(e => e.toLowerCase());
        const isAdmin = email === adminEmailStr.toLowerCase() || adminEmailsList.includes(email);

        let user = await User.findOne({ where: { email } });

        if (isAdmin) {
          // Auto-bootstrap or update admin profile
          if (!user) {
            user = await User.create({
              email,
              name,
              role: "admin",
              isActive: true,
              avatarUrl,
              preferences: {
                preferredContentType: "movie",
                favorites: [],
                recentChannels: []
              }
            });
          } else {
            let changed = false;
            if (user.role !== "admin") {
              user.role = "admin";
              changed = true;
            }
            if (avatarUrl && user.avatarUrl !== avatarUrl) {
              user.avatarUrl = avatarUrl;
              changed = true;
            }
            if (changed) {
              await user.save();
            }
          }
        } else {
          // Non-admin user must be pre-approved
          if (!user) {
            // Auto-register as pending/inactive user
            user = await User.create({
              email,
              name,
              role: "user",
              isActive: false,
              avatarUrl,
              preferences: {
                preferredContentType: "movie",
                favorites: [],
                recentChannels: []
              }
            });
            // Send SMTP approval email to admin
            sendAdminApprovalRequest(name, email).catch(err => {
              logger.error({ err }, "Failed to send admin approval email");
            });
            return h.response({ error: "Access Denied. Your request for access has been submitted. Please wait for administrator approval." }).code(403);
          }
          if (!user.isActive) {
            return h.response({ error: "Access Denied. Your account is pending administrator approval." }).code(403);
          }
          // If active user, update avatar if changed
          if (avatarUrl && user.avatarUrl !== avatarUrl) {
            user.avatarUrl = avatarUrl;
            await user.save();
          }
        }

        user.lastLogin = new Date();
        await user.save();

        // Generate Access Token (1 hour)
        const accessToken = createJWT({
          userId: user.id,
          email: user.email,
          role: user.role
        }, 3600);

        // Generate Refresh Token (1 month for web, 6 months for TV)
        const refreshToken = await issueRefreshToken(user.id, clientType, clientIp(request));

        return {
          accessToken,
          refreshToken,
          user: {
            id: user.id,
            email: user.email,
            name: user.name,
            role: user.role,
            avatarUrl: user.avatarUrl
          }
        };
      } catch (error) {
        logger.error({ err: error }, "Error during Google auth");
        return h.response({ error: "Internal Server Error" }).code(500);
      }
    },
  },
  {
    method: "POST",
    path: "/api/auth/login",
    handler: async (request, h) => {
      try {
        const payload = request.payload as any;
        if (!payload?.email || !payload?.password) {
          return h.response({ error: "Missing email or password" }).code(400);
        }
        const email = payload.email.toLowerCase().trim();
        const password = payload.password;
        const clientType = payload.clientType || "web";

        // Check for Admin credentials configured in .env
        const adminEmail = setting<string>("adminEmail").toLowerCase().trim();
        const adminEmailsList = setting<string[]>("adminEmails").map(e => e.toLowerCase());
        // If no admin email is configured at all, the admin password alone
        // grants admin access (bootstrap mode for fresh deployments).
        const noAdminEmailConfigured = !adminEmail && adminEmailsList.length === 0;
        const isAdminEmail = email === adminEmail || adminEmailsList.includes(email) || noAdminEmailConfigured;
        const envAdminPassword = process.env.ADMIN_PASSWORD;

        if (isAdminEmail && envAdminPassword && typeof password === "string" && secureCompare(password, envAdminPassword)) {
          let adminUser = await User.findOne({ where: { email } });
          if (!adminUser) {
            adminUser = await User.create({
              email,
              name: "Administrator",
              role: "admin",
              isActive: true,
              preferences: {
                preferredContentType: "movie",
                favorites: [],
                recentChannels: []
              }
            });
          } else if (adminUser.role !== "admin" || !adminUser.isActive) {
            adminUser.role = "admin";
            adminUser.isActive = true;
            await adminUser.save();
          }

          adminUser.lastLogin = new Date();
          await adminUser.save();

          const accessToken = createJWT({
            userId: adminUser.id,
            email: adminUser.email,
            role: adminUser.role
          }, 3600);

          const refreshToken = await issueRefreshToken(adminUser.id, clientType, clientIp(request));

          return {
            accessToken,
            refreshToken,
            user: {
              id: adminUser.id,
              email: adminUser.email,
              name: adminUser.name,
              role: adminUser.role,
              avatarUrl: adminUser.avatarUrl
            }
          };
        }

        const user = await User.findOne({ where: { email } });
        if (!user) {
          recordFromRequest(request, "login_failed", `unknown account ${String(email).slice(0, 80)}`);
          return h.response({ error: "Invalid email or password" }).code(401);
        }

        if (!user.isActive) {
          recordFromRequest(request, "login_disabled", null, user.id);
          return h.response({ error: "Your account is disabled. Please contact the administrator." }).code(403);
        }

        if (!user.passwordHash || !user.salt) {
          return h.response({ error: "Please log in using Google Sign-In" }).code(400);
        }

        const isMatch = verifyPassword(password, user.passwordHash, user.salt);
        if (!isMatch) {
          recordFromRequest(request, "login_failed", "wrong password", user.id);
          return h.response({ error: "Invalid email or password" }).code(401);
        }

        user.lastLogin = new Date();
        await user.save();

        // Generate Access Token (1 hour)
        const accessToken = createJWT({
          userId: user.id,
          email: user.email,
          role: user.role
        }, 3600);

        // Generate Refresh Token (1 month for web, 6 months for TV)
        const refreshToken = await issueRefreshToken(user.id, clientType, clientIp(request));

        return {
          accessToken,
          refreshToken,
          user: {
            id: user.id,
            email: user.email,
            name: user.name,
            role: user.role,
            avatarUrl: user.avatarUrl
          }
        };
      } catch (error) {
        logger.error({ err: error }, "Error during credentials login");
        return h.response({ error: "Internal Server Error" }).code(500);
      }
    },
  },
  {
    method: "POST",
    path: "/api/auth/signup",
    handler: async (request, h) => {
      try {
        const payload = request.payload as any;
        const email = payload?.email?.toLowerCase().trim();
        const name = payload?.name?.trim();
        const password = payload?.password;

        if (!email || !name || !password) {
          return h.response({ error: "Missing email, name, or password" }).code(400);
        }

        const passwordRegex = /^(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]).{8,}$/;
        if (!passwordRegex.test(password)) {
          return h.response({ error: "Password is not matching its criteria" }).code(400);
        }

        const existing = await User.findOne({ where: { email } });
        if (existing) {
          return h.response({ error: "An account with this email already exists." }).code(400);
        }

        const { hash, salt } = hashPassword(password);

        await User.create({
          email,
          name,
          role: "user",
          isActive: false, // Must be approved by admin
          passwordHash: hash,
          salt: salt,
          preferences: {
            preferredContentType: "movie",
            favorites: [],
            recentChannels: []
          }
        });

        // Trigger SMTP approval email to admin in background
        sendAdminApprovalRequest(name, email).catch(err => {
          logger.error({ err }, "Failed to send admin approval email");
        });

        return {
          success: true,
          message: "Signup successful. Your request for access has been submitted. Please wait for administrator approval."
        };
      } catch (error) {
        logger.error({ err: error }, "Error during credentials signup");
        return h.response({ error: "Internal Server Error" }).code(500);
      }
    },
  },
  {
    method: "POST",
    path: "/api/auth/forgot-password",
    handler: async (request, h) => {
      try {
        const payload = request.payload as any;
        const email = payload?.email?.toLowerCase().trim();

        if (!email) {
          return h.response({ error: "Missing email" }).code(400);
        }

        const genericResponse = {
          success: true,
          message: "If an account exists for that email, a reset link has been sent."
        };

        const user = await User.findOne({ where: { email } });
        // Only credentials-based accounts (passwordHash set) can reset a password.
        if (!user || !user.passwordHash) {
          return genericResponse;
        }

        const resetToken = crypto.randomBytes(32).toString("hex");
        // Only the hash is stored: a database leak must not hand out working reset links.
        user.resetToken = crypto.createHash("sha256").update(resetToken).digest("hex");
        user.resetTokenExpires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
        await user.save();

        const resetLink = `${getPublicOrigin(request)}/#/reset-password?token=${resetToken}`;
        sendPasswordResetEmail(user.name, user.email, resetLink).catch(err => {
          logger.error({ err }, "Failed to send password reset email");
        });

        return genericResponse;
      } catch (error) {
        logger.error({ err: error }, "Error during forgot-password request");
        return h.response({ error: "Internal Server Error" }).code(500);
      }
    },
  },
  {
    method: "POST",
    path: "/api/auth/reset-password",
    handler: async (request, h) => {
      try {
        const payload = request.payload as any;
        const token = payload?.token;
        const password = payload?.password;

        if (!token || !password) {
          return h.response({ error: "Missing token or password" }).code(400);
        }

        const passwordRegex = /^(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]).{8,}$/;
        if (!passwordRegex.test(password)) {
          return h.response({ error: "Password is not matching its criteria" }).code(400);
        }

        const tokenHash = crypto.createHash("sha256").update(String(token)).digest("hex");
        const user = await User.findOne({ where: { resetToken: tokenHash } });
        if (!user || !user.resetTokenExpires || new Date() > user.resetTokenExpires) {
          recordFromRequest(request, "reset_token_invalid");
          return h.response({ error: "Invalid or expired reset token" }).code(400);
        }

        const { hash, salt } = hashPassword(password);
        user.passwordHash = hash;
        user.salt = salt;
        user.resetToken = null as any;
        user.resetTokenExpires = null as any;
        await user.save();

        return { success: true, message: "Password reset successfully. You can now log in." };
      } catch (error) {
        logger.error({ err: error }, "Error during reset-password request");
        return h.response({ error: "Internal Server Error" }).code(500);
      }
    },
  },
  {
    method: "POST",
    path: "/api/auth/refresh",
    handler: async (request, h) => {
      try {
        const payload = request.payload as any;
        const refreshToken = payload?.refreshToken;

        if (!refreshToken) {
          return h.response({ error: "Missing refresh token" }).code(400);
        }

        // Validated against the server's record and rotated (services/RefreshTokens.ts):
        // sign-out and admin revocation work, and a replayed old token revokes the session.
        const outcome = await rotateRefreshToken(refreshToken, clientIp(request));
        if (!outcome.ok) {
          recordFromRequest(request, outcome.reason === "reuse" ? "refresh_reuse" : "refresh_invalid", outcome.reason, outcome.userId ?? null);
          return h.response({ error: "Invalid or expired refresh token" }).code(401);
        }

        const user = await User.findByPk(outcome.userId);
        if (!user || !user.isActive) {
          await revokeAllForUser(outcome.userId, "account disabled");
          return h.response({ error: "User is disabled or does not exist" }).code(401);
        }

        // Generate new Access Token (1 hour)
        const accessToken = createJWT({
          userId: user.id,
          email: user.email,
          role: user.role
        }, 3600);

        return {
          accessToken,
          refreshToken: outcome.refreshToken
        };
      } catch (error) {
        logger.error({ err: error }, "Error during token refresh");
        return h.response({ error: "Internal Server Error" }).code(500);
      }
    },
  },
  {
    method: "POST",
    path: "/api/auth/device/code",
    handler: async (request, h) => {
      try {
        const deviceCode = uuidv4();
        const userCode = generateUserCode();
        const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 mins

        await DeviceCode.create({
          deviceCode,
          userCode: sanitizeCode(userCode),
          status: "pending",
          expiresAt
        });

        // Resolve absolute URL dynamically based on host (reverse-proxy aware)
        const verificationUrl = `${getPublicOrigin(request)}/#/verify?code=${userCode}`;

        return {
          deviceCode,
          userCode,
          verificationUrl,
          expiresIn: 300 // 5 minutes in seconds
        };
      } catch (error) {
        logger.error({ err: error }, "Error generating device code");
        return h.response({ error: "Internal Server Error" }).code(500);
      }
    },
  },
  {
    method: "POST",
    path: "/api/auth/device/poll",
    handler: async (request, h) => {
      try {
        const payload = request.payload as any;
        const deviceCode = payload?.deviceCode;

        if (!deviceCode) {
          return h.response({ error: "Missing deviceCode" }).code(400);
        }

        const record = await DeviceCode.findByPk(deviceCode);

        if (!record) {
          return h.response({ status: "expired" }).code(200);
        }

        if (new Date() > record.expiresAt) {
          record.status = "expired";
          await record.save();
          return { status: "expired" };
        }

        if (record.status === "pending") {
          return { status: "pending" };
        }

        if (record.status === "authorized" && record.userId) {
          const user = await User.findByPk(record.userId);
          if (!user || !user.isActive) {
            return h.response({ error: "Authorized user is inactive or deleted" }).code(403);
          }

          // Issue TV Tokens (6 months refresh)
          const accessToken = createJWT({
            userId: user.id,
            email: user.email,
            role: user.role
          }, 3600);

          const refreshToken = await issueRefreshToken(user.id, "tv", clientIp(request));

          // Clean up the device code from database
          await record.destroy();

          return {
            status: "authorized",
            accessToken,
            refreshToken,
            user: {
              id: user.id,
              email: user.email,
              name: user.name,
              role: user.role,
              avatarUrl: user.avatarUrl
            }
          };
        }

        return { status: record.status };
      } catch (error) {
        logger.error({ err: error }, "Error polling device code");
        return h.response({ error: "Internal Server Error" }).code(500);
      }
    },
  },
  {
    method: "POST",
    path: "/api/auth/device/authorize",
    handler: async (request, h) => {
      const userPayload = authCheck(request);
      if (!userPayload) {
        return h.response({ error: "Unauthorized" }).code(401);
      }

      try {
        const payload = request.payload as any;
        const userCodeInput = payload?.userCode;

        if (!userCodeInput) {
          return h.response({ error: "Missing user code" }).code(400);
        }

        const sanitized = sanitizeCode(userCodeInput);

        const record = await DeviceCode.findOne({
          where: {
            userCode: sanitized,
            status: "pending"
          }
        });

        if (!record || new Date() > record.expiresAt) {
          recordFromRequest(request, "pairing_code_invalid", null, userPayload.userId as number);
          return h.response({ error: "Invalid or expired user authorization code" }).code(400);
        }

        // Authorize this device code for the authenticated user
        record.userId = userPayload.userId;
        record.status = "authorized";
        await record.save();

        return { success: true, message: "Device successfully authorized!" };
      } catch (error) {
        logger.error({ err: error }, "Error authorizing device code");
        return h.response({ error: "Internal Server Error" }).code(500);
      }
    },
  },
  {
    // Whether the login page offers "Sign in with Jellyfin" (Settings › Jellyfin).
    method: "GET",
    path: "/api/auth/jellyfin/enabled",
    handler: () => ({ enabled: Boolean(setting<boolean>("jellyfinSignIn") && jellyfinConfig()) }),
  },
  {
    // Sign in with a Jellyfin username and password (Jellyseerr-style). Jellyfin checks them;
    // the password is never stored. The account is found by its Jellyfin user id, or created
    // on the first sign-in (waiting for an admin unless Settings › New Jellyfin sign-ins is
    // "allow"). The user's own Jellyfin token is kept, encrypted, for direct streams.
    method: "POST",
    path: "/api/auth/jellyfin",
    handler: async (request, h) => {
      try {
        if (!setting<boolean>("jellyfinSignIn") || !jellyfinConfig()) {
          return h.response({ error: "Signing in with Jellyfin is not turned on" }).code(404);
        }
        const payload = (request.payload || {}) as any;
        const username = String(payload.username ?? "").trim().slice(0, 128);
        const password = String(payload.password ?? "").slice(0, 512);
        const clientType = payload.clientType === "tv" ? "tv" : "web";
        if (!username) return h.response({ error: "Enter your Jellyfin username" }).code(400);

        let jf;
        try {
          jf = await jellyfinAuthenticate(username, password, clientType);
        } catch (e: any) {
          logger.warn(`[auth] Jellyfin sign-in: ${e?.message ?? e}`);
          return h.response({ error: "Jellyfin is not reachable right now" }).code(502);
        }
        if (!jf) {
          recordFromRequest(request, "login_failed", `jellyfin ${username.slice(0, 80)}`);
          return h.response({ error: "Wrong Jellyfin username or password" }).code(401);
        }

        const makeAdmin = jf.isAdmin && setting<boolean>("jellyfinAdmins");
        let user = await User.findOne({ where: { jellyfinUserId: jf.userId } });
        if (!user) {
          const allow = setting<string>("jellyfinNewUsers") === "allow" || makeAdmin;
          user = await User.create({
            email: `${jf.userId}@jellyfin.invalid`,
            name: jf.name,
            role: makeAdmin ? "admin" : "user",
            isActive: allow,
            jellyfinUserId: jf.userId,
            jellyfinTokenEnc: encryptSecret(jf.token),
            preferences: { preferredContentType: "movie", favorites: [], recentChannels: [] },
          } as any);
          if (!allow) {
            sendAdminApprovalRequest(`${jf.name} (Jellyfin)`, user.email).catch((err) => logger.error({ err }, "Failed to send admin approval email"));
            return h.response({ error: "Your request for access has been sent. An administrator will let you in." }).code(403);
          }
        } else {
          if (!user.isActive) {
            recordFromRequest(request, "login_disabled", null, user.id);
            return h.response({ error: "Your account is waiting for an administrator or is turned off." }).code(403);
          }
          user.jellyfinTokenEnc = encryptSecret(jf.token);
          if (user.name !== jf.name) user.name = jf.name;
          if (makeAdmin && user.role !== "admin") user.role = "admin";
        }
        user.lastLogin = new Date();
        await user.save();

        const accessToken = createJWT({ userId: user.id, email: user.email, role: user.role }, 3600);
        const refreshToken = await issueRefreshToken(user.id, clientType, clientIp(request));
        return {
          accessToken,
          refreshToken,
          user: { id: user.id, email: user.email, name: user.name, role: user.role, avatarUrl: user.avatarUrl },
        };
      } catch (error) {
        logger.error({ err: error }, "Error during Jellyfin sign-in");
        return h.response({ error: "Internal Server Error" }).code(500);
      }
    },
  },
  {
    // The Google sign-in client id is public by nature (it is embedded in any page that
    // uses it), so the webui fetches it here instead of having it baked in at build time.
    method: "GET",
    path: "/api/auth/google/client-id",
    handler: () => ({ clientId: setting<string>("googleClientId") || null }),
  },
  {
    // Sign-out: revokes this refresh token's session on the server (clients also clear
    // their stored tokens). Unknown tokens are ignored so sign-out never fails.
    method: "POST",
    path: "/api/auth/logout",
    handler: async (request, h) => {
      const token = (request.payload as any)?.refreshToken;
      if (typeof token === "string" && token.length > 0) {
        await revokeRefreshToken(token).catch((err) => logger.error({ err }, "logout revoke failed"));
      }
      return { success: true };
    },
  },
];
