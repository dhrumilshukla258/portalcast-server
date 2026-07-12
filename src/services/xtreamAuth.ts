import { User } from "@/models/User";
import { verifyPassword } from "@/auth/password";
import { createJWT, verifyJWT } from "@/auth/jwt";

// Stream tokens are 30-day JWTs embedded in the password field of Xtream API
// responses so that clients never carry the user's real password in stream URLs.
export const STREAM_TOKEN_TTL = 30 * 24 * 60 * 60; // 30 days in seconds

export function generateStreamToken(userId: number): string {
  return createJWT({ sub: userId, scope: "stream" }, STREAM_TOKEN_TTL);
}

export async function resolveXtreamUser(username?: string, password?: string): Promise<User | null> {
  if (!username || !password) return null;

  // Stream token branch: if the password looks like a JWT, validate it
  if (password.startsWith("eyJ")) {
    const payload = verifyJWT(password);
    if (payload && payload.scope === "stream" && payload.sub) {
      const tokenUser = await User.findOne({ where: { id: payload.sub, email: username, isActive: true } });
      if (tokenUser) return tokenUser;
    }
    // Invalid or expired stream token — fall through to password check
  }

  // Try per-user DB credentials first
  const user = await User.findOne({ where: { email: username, isActive: true } });
  if (user && user.passwordHash && user.salt && verifyPassword(password, user.passwordHash, user.salt)) {
    return user;
  }

  // Admin env-var credentials (ADMIN_EMAIL + ADMIN_PASSWORD).
  // With no ADMIN_EMAIL configured, the admin password alone is accepted.
  const adminEmail = (process.env.ADMIN_EMAIL || "").toLowerCase().trim();
  const adminPassword = process.env.ADMIN_PASSWORD || "";
  if (adminPassword && password === adminPassword && (!adminEmail || username.toLowerCase() === adminEmail)) {
    return (user ?? { email: username }) as User;
  }

  return null;
}
