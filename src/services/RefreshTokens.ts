// Revocable, rotating refresh tokens.
//
// Before: a refresh token was a bare JWT. Nothing could revoke it (no sign-out on the
// server, a stolen TV token worked for 6 months) and it was never rotated. Now every
// issued token is recorded by hash (models/RefreshToken.ts):
//   - /api/auth/refresh accepts a token only if its record exists and is not revoked,
//     then rotates: the old record is revoked, a new token is issued in the same family
//     with the same final expiry (a sign-in still lasts 30 days web / 180 days TV).
//   - a revoked/rotated token presented again is treated as stolen: the whole family is
//     revoked and a `refresh_reuse` security event is recorded.
//   - sign-out, disabling or deleting a user, and admin action revoke records.
// Tokens issued before this change carry no `jti`; they are accepted until they expire
// (so nobody is signed out by the upgrade) and are migrated into a family on first use.

import crypto from "crypto";
import { Op } from "sequelize";
import { RefreshToken } from "@/models/RefreshToken";
import { createJWT, verifyJWT, type JWTPayload } from "@/auth/jwt";
import { logger } from "@/infra/logger";

const hashOf = (token: string) => crypto.createHash("sha256").update(token).digest("hex");

export const REFRESH_TTL_SECONDS = { tv: 6 * 30 * 24 * 3600, web: 30 * 24 * 3600 } as const;

export function refreshTtlFor(clientType: string | undefined): number {
  return clientType === "tv" ? REFRESH_TTL_SECONDS.tv : REFRESH_TTL_SECONDS.web;
}

async function store(token: string, userId: number, family: string, clientType: string | undefined, expiresAt: Date, ip?: string | null): Promise<void> {
  await RefreshToken.create({ tokenHash: hashOf(token), userId, family, clientType: clientType ?? null, expiresAt, ip: ip ?? null });
}

/** A brand-new session (sign-in, pairing). */
export async function issueRefreshToken(userId: number, clientType: string | undefined, ip?: string | null): Promise<string> {
  const ttl = refreshTtlFor(clientType);
  const family = crypto.randomUUID();
  const token = createJWT({ userId, type: "refresh", clientType, jti: crypto.randomUUID(), fam: family }, ttl);
  await store(token, userId, family, clientType, new Date(Date.now() + ttl * 1000), ip);
  return token;
}

export type RefreshOutcome =
  | { ok: true; userId: number; clientType: string | undefined; refreshToken: string }
  | { ok: false; reason: "invalid" | "revoked" | "reuse" | "expired"; userId?: number };

/**
 * Validates and rotates. Returns the NEW refresh token to hand back to the client.
 */
export async function rotateRefreshToken(token: string, ip?: string | null): Promise<RefreshOutcome> {
  const decoded = verifyJWT(token) as JWTPayload | false;
  if (!decoded || decoded.type !== "refresh" || typeof decoded.userId !== "number") return { ok: false, reason: "invalid" };
  const userId = decoded.userId;
  const clientType = typeof decoded.clientType === "string" ? decoded.clientType : undefined;
  const expiresAt = new Date((decoded.exp ?? 0) * 1000);
  if (expiresAt.getTime() <= Date.now()) return { ok: false, reason: "expired", userId };

  const h = hashOf(token);
  const row = await RefreshToken.findByPk(h);

  let family: string;
  if (row) {
    if (row.revokedAt) {
      // Replay of a token we already rotated away or revoked: the family is compromised.
      await RefreshToken.update(
        { revokedAt: new Date(), revokedReason: "reuse detected" },
        { where: { family: row.family, revokedAt: null } },
      );
      return { ok: false, reason: row.revokedReason === "reuse detected" || row.revokedReason === "rotated" ? "reuse" : "revoked", userId };
    }
    family = row.family;
    await row.update({ revokedAt: new Date(), revokedReason: "rotated", lastUsedAt: new Date() });
  } else if (!decoded.jti) {
    // Pre-upgrade token: accept until it expires, and migrate it into a family now.
    family = crypto.randomUUID();
    await RefreshToken.create({ tokenHash: h, userId, family, clientType: clientType ?? null, expiresAt, revokedAt: new Date(), revokedReason: "rotated", lastUsedAt: new Date(), ip: ip ?? null });
  } else {
    // Signed by us but unknown: the database was reset, or it was revoked and purged.
    return { ok: false, reason: "invalid", userId };
  }

  // Same final expiry as the sign-in it belongs to (no sliding renewal).
  const remaining = Math.max(60, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
  const next = createJWT({ userId, type: "refresh", clientType, jti: crypto.randomUUID(), fam: family }, remaining);
  await store(next, userId, family, clientType, expiresAt, ip);
  return { ok: true, userId, clientType, refreshToken: next };
}

/** Sign-out: revoke this token's whole family. Unknown tokens are ignored. */
export async function revokeRefreshToken(token: string, reason = "signed out"): Promise<void> {
  const row = await RefreshToken.findByPk(hashOf(token));
  if (!row) return;
  await RefreshToken.update({ revokedAt: new Date(), revokedReason: reason }, { where: { family: row.family, revokedAt: null } });
}

export async function revokeAllForUser(userId: number, reason: string): Promise<number> {
  const [n] = await RefreshToken.update({ revokedAt: new Date(), revokedReason: reason }, { where: { userId, revokedAt: null } });
  if (n > 0) logger.info(`[auth] revoked ${n} session(s) of user ${userId}: ${reason}`);
  return n;
}

/** Active sessions of a user (for the admin view). */
export async function activeSessions(userId: number) {
  return RefreshToken.findAll({
    where: { userId, revokedAt: null, expiresAt: { [Op.gt]: new Date() } },
    attributes: ["family", "clientType", "createdAt", "lastUsedAt", "expiresAt", "ip"],
    order: [["createdAt", "DESC"]], raw: true,
  });
}

/** Drop expired and long-revoked rows (daily cleanup). */
export async function purgeRefreshTokens(): Promise<number> {
  const old = new Date(Date.now() - 7 * 86400 * 1000);
  return RefreshToken.destroy({ where: { [Op.or]: [{ expiresAt: { [Op.lt]: new Date() } }, { revokedAt: { [Op.lt]: old } }] } });
}
