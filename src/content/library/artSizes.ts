// Local-library artwork at card size (plan Phase 4): poster and fanart files beside NAS titles
// are often 2-5 MB, shown in 130 dp cards. With `w` (342, 780 or 1280) the art route serves a
// JPEG scaled to that width, made once with ffmpeg (installed in the container) and kept in
// the image cache folder under the signed address and width: a changed file has a new version
// in its address, so it gets a new copy. At most two conversions at a time; when ffmpeg is
// missing or fails, the original file is served as before.

import crypto from "crypto";
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { logger } from "@/infra/logger";
import { imageCacheFolder } from "@/content/imageCache";

export const ART_WIDTHS = new Set([342, 780, 1280]);
const MAX_RUNNING = 2;

let running = 0;
const waiting: (() => void)[] = [];
const inflight = new Map<string, Promise<string | null>>();

async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= MAX_RUNNING) await new Promise<void>((resolve) => waiting.push(resolve));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

function convert(src: string, out: string, width: number): Promise<boolean> {
  return new Promise((resolve) => {
    let proc;
    try {
      // Never wider than the original (min), height kept in proportion (even).
      proc = spawn("ffmpeg", ["-v", "error", "-y", "-i", src, "-vf", `scale='min(${width},iw)':-2`, "-q:v", "4", "-frames:v", "1", out]);
    } catch {
      return resolve(false);
    }
    proc.on("error", () => resolve(false));
    proc.on("close", (code) => resolve(code === 0));
  });
}

/**
 * The path of `file` scaled to `width` (made on first use), or null to serve the original.
 * `key` is the signed art address (it carries the file's version).
 */
export async function scaledArt(file: string, key: string, width: number): Promise<string | null> {
  if (!ART_WIDTHS.has(width)) return null;
  const name = `${crypto.createHash("sha1").update(`${key}|${width}`).digest("hex")}.jpg`;
  const out = path.join(imageCacheFolder(), "local", name.slice(0, 2), name);
  try {
    await fs.promises.access(out);
    return out;
  } catch {
    /* not made yet */
  }
  let job = inflight.get(out);
  if (!job) {
    job = slot(async () => {
      await fs.promises.mkdir(path.dirname(out), { recursive: true });
      const tmp = `${out}.${process.pid}.part.jpg`;
      const ok = await convert(file, tmp, width);
      if (!ok) {
        await fs.promises.rm(tmp, { force: true }).catch(() => {});
        logger.debug(`[art] could not scale ${key} to ${width}: serving the original`);
        return null;
      }
      await fs.promises.rename(tmp, out);
      return out;
    }).finally(() => inflight.delete(out));
    inflight.set(out, job);
  }
  return job;
}
