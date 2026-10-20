// Upstream stream links never leave the server readable.
//
// A portal's create_link answer is a full upstream URL (its video CDN, with a session hash),
// playable by anyone who holds it, bypassing this server. Clients still need *something* to
// hand back when they ask for playback (movie-link / download), so such a link is sent
// sealed: AES-GCM with the server's key (auth/crypto.ts), opaque and tamper-proof, and
// unsealed only here on the way back in. Found 2026-10-20: 23 watch-progress records held
// raw CDN links that had reached browsers this way.

import { encryptSecret, decryptSecret } from "@/auth/crypto";

const PREFIX = "sealed:";
const ABSOLUTE = /^\s*(?:ffmpeg\s+|ffrt\s+)?https?:\/\//i;

/** True for a link pointing outside this server (anything absolute not on `origin`). */
export function isUpstreamLink(value: unknown, origin?: string): boolean {
  if (typeof value !== "string" || !ABSOLUTE.test(value)) return false;
  const url = value.replace(/^\s*(?:ffmpeg|ffrt)\s+/i, "");
  return !(origin && url.startsWith(origin));
}

/** An upstream link sealed for a client; anything else (relative paths, our own URLs) as is. */
export function sealCmd(value: unknown, origin?: string): unknown {
  return isUpstreamLink(value, origin) ? PREFIX + encryptSecret(String(value)) : value;
}

/** The original link from a sealed value; other values as is; "" for a forged/broken seal. */
export function unsealCmd(value: unknown): string {
  const s = typeof value === "string" ? value : value == null ? "" : String(value);
  if (!s.startsWith(PREFIX)) return s;
  try {
    return decryptSecret(s.slice(PREFIX.length));
  } catch {
    return "";
  }
}

export function isSealed(value: unknown): boolean {
  return typeof value === "string" && value.startsWith(PREFIX);
}
