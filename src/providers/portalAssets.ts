import { initialConfig } from "@/config/server";

// Normalizes a portal channel logo reference to a portal-root path suitable
// for the /api/images proxy (e.g. "/stalker_portal/misc/logos/320/1.png").
// Stalker portals usually store just a filename; some store a partial path.
export function channelLogoPath(logo?: string): string {
  if (!logo) return "";
  if (logo.startsWith("http")) return logo; // already an absolute URL
  const ctx = initialConfig.contextPath ? `/${initialConfig.contextPath}` : "";
  if (logo.includes("/")) {
    return `${ctx}/${logo.replace(/^\//, "")}`;
  }
  return `${ctx}/misc/logos/320/${logo}`;
}

// Logo reference → same-origin proxied path the web app and players can load
// (avoids mixed-content blocks and portals unreachable from the client).
export function proxiedLogoPath(logo?: string): string {
  const p = channelLogoPath(logo);
  if (!p || p.startsWith("http")) return p;
  return `/api/images${p}`;
}

// Hosts that are already safe to expose directly — proxying these would only
// add a redundant hop with no privacy benefit (they're not the portal).
const SAFE_ABSOLUTE_IMAGE_HOSTS = new Set(["image.tmdb.org"]);

// Rewrites any absolute upstream image URL (Xtream stream_icon/cover, a Stalker
// logo that was already absolute, etc.) into a same-origin /api/images/proxy
// path so the real portal/CDN host is never sent to the browser — the whole
// point of the stream-token scheme this mirrors (see StreamTokens.ts) is that
// nothing copyable/inspectable from the client should reveal the upstream
// address. A bare `<img src="https://real-portal.example/...">` defeats that
// even though the video URLs themselves are already opaque-tokenized.
// Non-absolute values (relative /api/images paths the frontend already
// prefixes itself, or empty strings) pass through untouched.
//
// `origin`, when passed, makes the return value fully absolute
// (`${origin}/api/images/proxy?u=...`) instead of relative. This matters for
// webui JSON responses specifically: the frontend's own MediaCard convention
// prefixes any *non*-http value with `/api/images` itself (that's how it
// handles Stalker's bare portal-relative paths) — since our own proxy path
// already starts with `/api/images`, returning it relative there causes the
// frontend to prefix it a second time (`/api/images/api/images/proxy?...`,
// a 400). Returning it already-absolute sidesteps that rule entirely, the
// same way an absolute TMDB URL already does. Callers with no request
// context (M3U/XMLTV export, Xtream protocol responses) don't pass origin
// and continue absolutizing the relative result themselves afterward.
export function proxiedImageUrl(url?: string, origin?: string): string {
  if (!url) return "";
  if (!url.startsWith("http")) return url;
  try {
    if (SAFE_ABSOLUTE_IMAGE_HOSTS.has(new URL(url).hostname)) return url;
  } catch {
    // Malformed URL — fall through and proxy it anyway rather than leak it as-is.
  }
  const relative = `/api/images/proxy?u=${Buffer.from(url, "utf8").toString("base64url")}`;
  return origin ? `${origin}${relative}` : relative;
}
