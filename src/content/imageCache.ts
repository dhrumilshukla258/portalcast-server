// TMDB artwork cached on our own disk (the plan's "metadata folder"): the apps load
//   <origin>/api/images/tmdb/<size>/<file>
// and the server fetches each image from TMDB once, keeps it in the cache folder and serves
// it from there with a one-year cache header. Faster after the first view, works when TMDB
// is slow or unreachable for images already seen, and viewers' addresses never reach TMDB.
//
// Settings: imageCacheFolder (default <data folder>/image-cache, a NAS folder is a good
// choice), imageCacheGb (size cap, default 20; 0 turns caching off and the apps load TMDB
// directly as before). A nightly job removes the least recently used images above the cap.

import crypto from "crypto";
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

// Speed plan step 7. Every file call here is non-blocking: the folder can be on the NAS, and
// one blocking write to a disk waking from sleep froze the whole server (measured: 30
// requests finishing together at ~5,005 ms). The most-used images are also kept in memory
// (128 MB, least recently used goes first), so they never touch the disk at all.
const MEM_MAX_BYTES = 128 * 1024 * 1024;
const MEM_MAX_ITEM = 2 * 1024 * 1024; // an "original" backdrop can be several MB: disk only
const mem = new Map<string, Buffer>();
let memBytes = 0;
const touched = new Map<string, number>(); // last "used" stamp written per file, for eviction

function memGet(key: string): Buffer | undefined {
  const b = mem.get(key);
  if (b) { mem.delete(key); mem.set(key, b); } // most recently used moves to the end
  return b;
}

function memPut(key: string, b: Buffer): void {
  if (b.length > MEM_MAX_ITEM || mem.has(key)) return;
  mem.set(key, b);
  memBytes += b.length;
  while (memBytes > MEM_MAX_BYTES) {
    const oldest = mem.keys().next().value;
    if (oldest === undefined) break;
    memBytes -= mem.get(oldest)!.length;
    mem.delete(oldest);
  }
}

/** Marks a file used (its mtime) at most once a day, for the nightly eviction job. */
function touch(key: string, target: string): void {
  const last = touched.get(key) ?? 0;
  if (Date.now() - last < 24 * 3600_000) return;
  touched.set(key, Date.now());
  fs.promises.utimes(target, new Date(), new Date()).catch(() => {});
}

/** Saves a downloaded image without anyone waiting for the disk (never a half-written file). */
function saveInBackground(target: string, bytes: Buffer): void {
  const tmp = `${target}.${process.pid}.${Date.now()}.part`;
  fs.promises
    .mkdir(path.dirname(target), { recursive: true })
    .then(() => fs.promises.writeFile(tmp, bytes))
    .then(() => fs.promises.rename(tmp, target))
    .catch((e) => {
      logger.debug(`[images] could not save ${target}: ${e?.message ?? e}`);
      fs.promises.rm(tmp, { force: true }).catch(() => {});
    });
}

const inflight = new Map<string, Promise<Buffer | null>>();

/**
 * The image's bytes: from memory, else the cache folder, else TMDB (one download per image,
 * saved in the background). Null when TMDB has no such image or cannot be reached.
 */
export async function cachedImage(size: string, file: string): Promise<Buffer | null> {
  const key = `${size}/${file}`;
  const hit = memGet(key);
  if (hit) return hit;
  const running = inflight.get(key);
  if (running) return running;
  const target = path.join(imageCacheFolder(), size, file);
  const job = (async () => {
    try {
      const bytes = await fs.promises.readFile(target);
      touch(key, target);
      memPut(key, bytes);
      return bytes;
    } catch {
      /* not cached yet */
    }
    try {
      const res = await axios.get(`https://image.tmdb.org/t/p/${size}/${file}`, { responseType: "arraybuffer", timeout: 15000, maxContentLength: 25 * 1024 * 1024 });
      const bytes = Buffer.from(res.data);
      memPut(key, bytes);
      touched.set(key, Date.now());
      saveInBackground(target, bytes);
      return bytes;
    } catch (e: any) {
      logger.debug(`[images] could not fetch ${key}: ${e?.message ?? e}`);
      return null;
    }
  })().finally(() => inflight.delete(key));
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
  // Non-blocking throughout: this walks the whole folder, which can be on the NAS.
  let sizes: string[] = [];
  try { sizes = await fs.promises.readdir(root); } catch { /* no cache yet */ }
  // <size>/<file> for TMDB images; relay/<xx>/<hash> for portal images (one level deeper).
  const dirs: string[] = [];
  for (const size of sizes) {
    if (size !== "relay") { dirs.push(path.join(root, size)); continue; }
    let subs: string[] = [];
    try { subs = await fs.promises.readdir(path.join(root, size)); } catch { /* none */ }
    for (const sub of subs) dirs.push(path.join(root, size, sub));
  }
  for (const dir of dirs) {
    let names: string[] = [];
    try { names = await fs.promises.readdir(dir); } catch { continue; }
    for (const n of names) {
      try {
        const st = await fs.promises.stat(path.join(dir, n));
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
    try { await fs.promises.rm(f.p); total -= f.size; removed++; } catch { /* gone */ }
  }
  return `${removed} images removed, ${(total / 1024 ** 3).toFixed(2)} GB left`;
}

// ── Portal images (channel logos, posters of titles not on TMDB) ─────────────
// Relayed images were fetched from the portal on every request (apps kept them an hour), so
// every logo of every channel list went back to the portal again and again. They are kept
// like TMDB images now: memory, then <cache folder>/relay/, then the portal once. Images the
// portal does not have are remembered for 10 minutes, so a missing logo is not asked for on
// every page. The bytes are checked by the caller (an image, under the size cap) before
// they are kept.

const MISSING_FOR_MS = 10 * 60_000;
const missing = new Map<string, number>();
const relayInflight = new Map<string, Promise<Buffer | null>>();

export async function cachedRelayImage(url: string, fetchImage: () => Promise<Buffer | null>): Promise<Buffer | null> {
  const hash = crypto.createHash("sha1").update(url).digest("hex");
  const key = `relay/${hash}`;
  const hit = memGet(key);
  if (hit) return hit;
  const gone = missing.get(key);
  if (gone && Date.now() - gone < MISSING_FOR_MS) return null;
  const running = relayInflight.get(key);
  if (running) return running;
  const target = path.join(imageCacheFolder(), "relay", hash.slice(0, 2), hash);
  const job = (async () => {
    if (imageCacheEnabled()) {
      try {
        const bytes = await fs.promises.readFile(target);
        touch(key, target);
        memPut(key, bytes);
        return bytes;
      } catch {
        /* not cached yet */
      }
    }
    const bytes = await fetchImage();
    if (!bytes) {
      missing.set(key, Date.now());
      if (missing.size > 5000) missing.delete(missing.keys().next().value as string);
      return null;
    }
    missing.delete(key);
    memPut(key, bytes);
    if (imageCacheEnabled()) {
      touched.set(key, Date.now());
      saveInBackground(target, bytes);
    }
    return bytes;
  })().finally(() => relayInflight.delete(key));
  relayInflight.set(key, job);
  return job;
}
