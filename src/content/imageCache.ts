// TMDB artwork cached on our own disk (the plan's "metadata folder"): the apps load
//   <origin>/api/images/tmdb/<size>/<file>
// and the server fetches each image from TMDB once, keeps it in the cache folder and serves
// it from there with a one-year cache header. Faster after the first view, works when TMDB
// is slow or unreachable for images already seen, and viewers' addresses never reach TMDB.
//
// Settings: imageCacheFolder (default <data folder>/image-cache, a NAS folder is a good
// choice), imageCacheGb (size cap, default 20; 0 turns caching off and the apps load TMDB
// directly as before). A nightly job removes the least recently used images above the cap.

import fs from "fs";
import path from "path";
import axios from "axios";
import { setting } from "@/config/settings";
import { dataDir } from "@/infra/paths";
import { logger } from "@/infra/logger";

const SIZES = new Set(["w45", "w92", "w154", "w185", "w300", "w342", "w500", "w780", "w1280", "h632", "original"]);
const FILE_RE = /^[A-Za-z0-9_-]{4,80}\.(jpg|jpeg|png|svg|webp)$/;
const TMDB_RE = /^https?:\/\/image\.tmdb\.org\/t\/p\/([a-z0-9]+)\/([A-Za-z0-9_-]+\.[a-z]+)$/i;

export function imageCacheEnabled(): boolean {
  return Number(setting<number>("imageCacheGb")) > 0;
}

export function imageCacheFolder(): string {
  const configured = String(setting<string>("imageCacheFolder") || "").trim();
  return configured ? path.resolve(configured) : path.join(dataDir, "image-cache");
}

/** TMDB image URL -> our cached URL (absolute with `origin`); anything else unchanged. */
export function cachedTmdbUrl(url: string, origin?: string): string {
  if (!imageCacheEnabled()) return url;
  const m = TMDB_RE.exec(url);
  if (!m || !SIZES.has(m[1]) || !FILE_RE.test(m[2])) return url;
  return `${origin ?? ""}/api/images/tmdb/${m[1]}/${m[2]}`;
}

export function validCacheRequest(size: string, file: string): boolean {
  return SIZES.has(size) && FILE_RE.test(file);
}

const inflight = new Map<string, Promise<string | null>>();

/** The cached file's path, downloading it from TMDB first when needed (one download per image). */
export async function cachedImagePath(size: string, file: string): Promise<string | null> {
  const target = path.join(imageCacheFolder(), size, file);
  try {
    const st = fs.statSync(target);
    // "Last used", at most once a day, for the eviction job.
    if (Date.now() - st.mtimeMs > 24 * 3600_000) fs.utimes(target, new Date(), new Date(), () => {});
    return target;
  } catch {
    /* not cached yet */
  }
  const key = `${size}/${file}`;
  const running = inflight.get(key);
  if (running) return running;
  const job = (async () => {
    try {
      const res = await axios.get(`https://image.tmdb.org/t/p/${size}/${file}`, { responseType: "arraybuffer", timeout: 15000, maxContentLength: 25 * 1024 * 1024 });
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const tmp = `${target}.${process.pid}.part`;
      fs.writeFileSync(tmp, Buffer.from(res.data));
      fs.renameSync(tmp, target); // never a half-written file
      return target;
    } catch (e: any) {
      logger.debug(`[images] could not fetch ${key}: ${e?.message ?? e}`);
      return null;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, job);
  return job;
}

/** Nightly: removes least recently used images until the cache is under 90% of its cap. */
export async function evictImageCache(): Promise<string> {
  const capBytes = Number(setting<number>("imageCacheGb")) * 1024 ** 3;
  if (!(capBytes > 0)) return "image cache is off";
  const root = imageCacheFolder();
  const files: { p: string; size: number; mtime: number }[] = [];
  let total = 0;
  for (const size of fs.existsSync(root) ? fs.readdirSync(root) : []) {
    const dir = path.join(root, size);
    let names: string[] = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) {
      try {
        const st = fs.statSync(path.join(dir, n));
        if (!st.isFile()) continue;
        files.push({ p: path.join(dir, n), size: st.size, mtime: st.mtimeMs });
        total += st.size;
      } catch { /* gone */ }
    }
  }
  if (total <= capBytes) return `${(total / 1024 ** 3).toFixed(2)} GB of ${setting<number>("imageCacheGb")} GB used`;
  files.sort((a, b) => a.mtime - b.mtime);
  let removed = 0;
  for (const f of files) {
    if (total <= capBytes * 0.9) break;
    try { fs.rmSync(f.p); total -= f.size; removed++; } catch { /* gone */ }
  }
  return `${removed} images removed, ${(total / 1024 ** 3).toFixed(2)} GB left`;
}
