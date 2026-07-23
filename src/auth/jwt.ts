import crypto from "crypto";

if (!process.env.JWT_SECRET) {
  throw new Error("JWT_SECRET environment variable must be set");
}
const JWT_SECRET: string = process.env.JWT_SECRET;

export function createJWT(payload: any, expiresInSeconds?: number): string {
  const head = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const expTime = expiresInSeconds !== undefined ? expiresInSeconds : (24 * 60 * 60); // Default to 1 day
  const payloadWithExp = { ...payload, exp: Math.floor(Date.now() / 1000) + expTime };
  const body = Buffer.from(JSON.stringify(payloadWithExp)).toString('base64url');
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

export function verifyJWT(token: string): any | false {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return false;
    const sig = crypto.createHmac('sha256', JWT_SECRET).update(`${parts[0]}.${parts[1]}`).digest('base64url');
    if (sig === parts[2]) {
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
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

export function authCheck(request: any): any | false {
  const authHeader = request.headers.authorization;
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
export function requireAdmin(request: any): any | false {
  const userPayload = authCheck(request);
  if (!userPayload || userPayload.role !== "admin") return false;
  return userPayload;
}
