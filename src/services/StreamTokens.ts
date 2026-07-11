import crypto from "crypto";

// Every client-facing stream URL now carries an opaque random token instead
// of the real upstream cmd/URL (even base64-encoded, that was trivially
// reversible by anyone who copied the link). The token maps, server-side
// only, to both the real resource AND the identity that requested it — so
// this single primitive replaces the earlier separate uid-signing scheme too.
// It also carries optional content metadata (live/movie/series + title +
// category) so the admin "active streams" view can show what's actually
// being watched instead of a raw resource key.

export interface StreamTokenMeta {
  kind?: "live" | "movie" | "series";
  label?: string;
  category?: string;
}

interface StreamTokenEntry extends StreamTokenMeta {
  resource: string; // real upstream cmd (stalker) or URL (proxy/vod)
  referer?: string;
  userLabel: string;
  createdAt: number;
  lastSeen: number;
}

const TTL_MS = 6 * 60 * 60 * 1000; // 6h idle timeout — covers long-running live/VOD sessions
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

const tokens = new Map<string, StreamTokenEntry>();

setInterval(() => {
  const cutoff = Date.now() - TTL_MS;
  for (const [token, entry] of tokens.entries()) {
    if (entry.lastSeen < cutoff) tokens.delete(token);
  }
}, SWEEP_INTERVAL_MS).unref();

export function mintStreamToken(resource: string, userLabel: string, referer?: string, meta?: StreamTokenMeta): string {
  const token = crypto.randomBytes(16).toString("hex");
  const now = Date.now();
  // meta is spread FIRST so the explicit params always win — a caller
  // accidentally passing a whole StreamTokenEntry (which itself has a
  // `resource` field) as `meta` must never be able to silently clobber the
  // real resource/referer/userLabel for this new token.
  tokens.set(token, { ...meta, resource, referer, userLabel, createdAt: now, lastSeen: now });
  return token;
}

export function resolveStreamToken(token: string | undefined | null): StreamTokenEntry | null {
  if (!token) return null;
  const entry = tokens.get(token);
  if (!entry) return null;
  if (Date.now() - entry.lastSeen > TTL_MS) {
    tokens.delete(token);
    return null;
  }
  entry.lastSeen = Date.now();
  return entry;
}

// Reads `t` off a Hapi request's query string and resolves it.
export function streamTokenFromRequest(request: any): StreamTokenEntry | null {
  const { t } = (request.query || {}) as { t?: string };
  return resolveStreamToken(t);
}

// Mints a fresh token for the same resource/referer/metadata under the SAME
// identity as an already-resolved token — used when one gated route hands
// off to another (e.g. /api/vod/play redirecting into /api/proxy) without
// re-deriving identity.
export function rekeyStreamToken(entry: StreamTokenEntry, resource?: string): string {
  return mintStreamToken(resource ?? entry.resource, entry.userLabel, entry.referer, {
    kind: entry.kind,
    label: entry.label,
    category: entry.category,
  });
}

// Builds a /api/proxy?t=... URL for a real upstream resource, tagging it with
// &m3u8=1 when the resource is an HLS playlist. The frontend picks its player
// mime type (application/x-mpegurl vs video/mp4) by checking whether the
// stream URL string *contains* "m3u8" — that used to work because the raw
// upstream URL was visible to it directly; now that it's hidden behind an
// opaque token, this tag is the only remaining signal carrying that through.
export function proxyUrlFor(rawUrl: string, userLabel: string, meta?: StreamTokenMeta): string {
  const token = mintStreamToken(rawUrl, userLabel, undefined, meta);
  const isM3u8 = rawUrl.toLowerCase().includes(".m3u8");
  return `/api/proxy?t=${token}${isM3u8 ? "&m3u8=1" : ""}`;
}
