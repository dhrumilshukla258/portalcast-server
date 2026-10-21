// Artwork beside local titles (Jellyfin's names: folder.jpg / poster.jpg, backdrop.jpg /
// fanart.jpg, logo.png / clearlogo.png). It wins over TMDB's for that title, as Jellyfin does.
//
// Stored as a marker "local-art:<itemId>:<kind>:<version>" (in content_meta.poster/backdrop and
// in local list items) and turned into a signed absolute URL whenever an image goes out:
//   <origin>/api/images/local?a=<itemId>.<kind>.<version>&s=<signature>
// Signed so nobody can walk the ids to see which titles are on the NAS; absolute because both
// apps prefix relative image paths with /api/images. <version> (the file's mtime) makes a
// replaced image a new URL, so the long cache on devices never shows the old one.

import crypto from "crypto";
import fs from "fs";
import path from "path";
import { serverSecret } from "@/infra/serverSecret";

export type ArtKind = "poster" | "backdrop" | "logo" | "still";
export interface LocalArt { poster?: string; backdrop?: string; logo?: string; v?: number }

type FolderArtKind = Exclude<ArtKind, "still">;
const NAMES: Record<FolderArtKind, string[]> = {
  poster: ["poster", "folder", "cover", "default", "movie", "show"],
  backdrop: ["backdrop", "fanart", "background", "art", "landscape"],
  logo: ["logo", "clearlogo"],
};
const EXTS = [".jpg", ".jpeg", ".png", ".webp"];
const PREFIX = "local-art:";
const KEY = crypto.createHmac("sha256", serverSecret).update("local-art").digest();

/** The artwork files in a title folder (names only, relative to that folder). */
export function findArt(dir: string): LocalArt | null {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const lower = new Map(names.map((n) => [n.toLowerCase(), n]));
  const art: LocalArt = {};
  let v = 0;
  for (const kind of Object.keys(NAMES) as FolderArtKind[]) {
    for (const base of NAMES[kind]) {
      const hit = EXTS.map((e) => lower.get(base + e)).find(Boolean);
      if (hit) {
        art[kind] = hit;
        try { v = Math.max(v, Math.floor(fs.statSync(path.join(dir, hit)).mtimeMs / 1000)); } catch { /* gone */ }
        break;
      }
    }
  }
  if (!art.poster && !art.backdrop && !art.logo) return null;
  art.v = v;
  return art;
}

/** `id` is a title id, or "f<fileId>" for an episode still. */
export function artMarker(id: number | string, kind: ArtKind, v = 0): string {
  return `${PREFIX}${id}:${kind}:${v}`;
}

export function isArtMarker(u: unknown): boolean {
  return typeof u === "string" && u.startsWith(PREFIX);
}

function sign(a: string): string {
  return crypto.createHmac("sha256", KEY).update(a).digest("base64url").slice(0, 22);
}

export function verifyArt(a: string, s: string | undefined): boolean {
  if (!s) return false;
  const want = Buffer.from(sign(a));
  const have = Buffer.from(String(s));
  return want.length === have.length && crypto.timingSafeEqual(want, have);
}

/** Marker -> signed URL (absolute when `origin` is given). Anything else is returned as is. */
export function artUrl(u: string, origin?: string): string {
  if (!isArtMarker(u)) return u;
  const [itemId, kind, v] = u.slice(PREFIX.length).split(":");
  const a = `${itemId}.${kind}.${v || 0}`;
  const rel = `/api/images/local?a=${a}&s=${sign(a)}`;
  return origin ? `${origin}${rel}` : rel;
}

const FIELDS = ["screenshot_uri", "cover", "backdrop_path", "backdrop_hd_path", "logo_path"] as const;

/** Turns every artwork marker in a list item into its URL. */
export function withArtUrls<T extends Record<string, any>>(item: T, origin?: string): T {
  const out: any = { ...item };
  if (isArtMarker(out.logo)) out.logo = artUrl(out.logo, origin);
  for (const f of FIELDS) if (isArtMarker(out[f])) out[f] = artUrl(out[f], origin);
  return out;
}
