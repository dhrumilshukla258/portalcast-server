import crypto from "crypto";
import type { Request } from "@hapi/hapi";

if (!process.env.JWT_SECRET) {
  throw new Error("JWT_SECRET environment variable must be set");
}
const JWT_SECRET: string = process.env.JWT_SECRET;

// Shapes seen across every createJWT() call site in this codebase:
// - access token:  { userId, email, role }
// - refresh token: { userId, type: "refresh", clientType }
// - admin bootstrap: { role: "admin" } (routes/providerConfig.ts — no userId/email)
// - stream token:  { sub, scope: "stream" } (services/xtreamAuth.ts)
// All fields are optional here since no single token carries all of them.
export interface JWTPayload {
  userId?: number;
  email?: string;
  role?: string;
  sub?: number;
  scope?: string;
  type?: string;
  clientType?: string;
  exp?: number;
  [key: string]: unknown;
}

export function createJWT(payload: JWTPayload, expiresInSeconds?: number): string {
  const head = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const expTime = expiresInSeconds !== undefined ? expiresInSeconds : (24 * 60 * 60); // Default to 1 day
  const payloadWithExp = { ...payload, exp: Math.floor(Date.now() / 1000) + expTime };
  const body = Buffer.from(JSON.stringify(payloadWithExp)).toString('base64url');
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

export function verifyJWT(token: string): JWTPayload | false {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return false;
    const sig = crypto.createHmac('sha256', JWT_SECRET).update(`${parts[0]}.${parts[1]}`).digest('base64url');
    const sigBuf = Buffer.from(sig);
    const providedBuf = Buffer.from(parts[2]);
    const validSig = sigBuf.length === providedBuf.length && crypto.timingSafeEqual(sigBuf, providedBuf);
    if (validSig) {
      const payload: JWTPayload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
      if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
        return false; // expired
      }
      return payload;
    }
    return false;
  } catch {
    return false;
  }
}

export function authCheck(request: Request): JWTPayload | false {
  // Hapi's default Request generic types `headers` as `{}` — the real shape
  // (a Dictionary<string>) only appears if every route declared its own Refs,
  // which this codebase doesn't. Narrow it here instead of typing the whole
  // request param as `any`.
  const authHeader = (request.headers as Record<string, string | undefined>).authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return false;
  }
  const token = authHeader.split(" ")[1];
  return verifyJWT(token);
}

// authCheck() alone only proves the JWT is validly signed and unexpired — it
// says nothing about WHO it belongs to. Several routes gated only on
// authCheck() under paths clearly meant to be admin-only (content-manager
// panel, provider config, cache clearing, uploads) turned out reachable by
// any regular logged-in user, not just the admin login (createJWT({role:
// "admin"}) in routes/providerConfig.ts is the only place that ever sets this
// claim). Use this wherever a route needs to actually enforce "admin only,"
// not just "logged in."
export function requireAdmin(request: Request): JWTPayload | false {
  const userPayload = authCheck(request);
  if (!userPayload || userPayload.role !== "admin") return false;
  return userPayload;
}
