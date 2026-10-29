// OpenSubtitles' file hash ("moviehash") of the video being played, so the subtitle search
// can ask for subtitles made for exactly this file (timed to it: no drift). The hash is
// the file's size plus its first and last 64 KB read as little-endian 64-bit words, summed
// modulo 2^64, as 16 hex digits. Only those 128 KB and the size are read: from the disk for
// a folder-library file, from Jellyfin for a Jellyfin file, from the provider for an IPTV
// file (range requests; a provider that ignores ranges gives no hash). HLS has no single
// file and gives none.

import fs from "fs";
import axios from "axios";
import { fileForToken } from "@/routes/library/stream";
import { JELLYFIN_ROOT, jellyfinFetch, jellyfinIdsOf, jellyfinStreamPath } from "@/content/library/jellyfin";
import { logger } from "@/infra/logger";

const CHUNK = 64 * 1024;
const MASK = (1n << 64n) - 1n;

/** The hash from the size and the two 64 KB ends (shorter files: what there is). */
export function movieHash(size: number, head: Buffer, tail: Buffer): string {
  let h = BigInt(size);
  for (const buf of [head, tail]) {
    for (let i = 0; i + 8 <= buf.length; i += 8) h = (h + buf.readBigUInt64LE(i)) & MASK;
  }
  return h.toString(16).padStart(16, "0");
}

const cache = new Map<string, { at: number; hash: string | null }>();
const TTL_MS = 6 * 60 * 60 * 1000;

type RangeRead = (start: number, end: number) => Promise<{ data: Buffer; total: number | null } | null>;

async function hashVia(read: RangeRead): Promise<string | null> {
  const first = await read(0, CHUNK - 1);
  if (!first || !first.total || first.total < CHUNK * 2) return null;
  const last = await read(first.total - CHUNK, first.total - 1);
  if (!last || last.data.length !== CHUNK || first.data.length !== CHUNK) return null;
  return movieHash(first.total, first.data, last.data);
}

const totalOf = (contentRange: string | null | undefined) => {
  const m = /\/(\d+)\s*$/.exec(String(contentRange ?? ""));
  return m ? Number(m[1]) : null;
};

/** The hash of what a stream token plays, or null (HLS, no ranges, unreachable). Cached per file. */
export async function hashForResource(resource: string | undefined): Promise<string | null> {
  if (!resource || /\.m3u8(\?|$)/i.test(resource)) return null;
  const hit = cache.get(resource);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.hash;
  let hash: string | null = null;
  try {
    if (resource.startsWith("local:")) {
      const target = await fileForToken(resource);
      if (target?.file.root === JELLYFIN_ROOT) {
        const ids = jellyfinIdsOf(target.file.relPath);
        const path = ids ? jellyfinStreamPath(ids.itemId, ids.sourceId) : null;
        if (path) {
          hash = await hashVia(async (start, end) => {
            const res = await jellyfinFetch(path, { headers: { Range: `bytes=${start}-${end}` }, signal: AbortSignal.timeout(15_000) });
            if (res.status !== 206) { await res.body?.cancel().catch(() => {}); return null; }
            return { data: Buffer.from(await res.arrayBuffer()), total: totalOf(res.headers.get("content-range")) };
          });
        }
      } else if (target?.abs) {
        const fh = await fs.promises.open(target.abs, "r");
        try {
          const { size } = await fh.stat();
          hash = await hashVia(async (start, end) => {
            const buf = Buffer.alloc(end - start + 1);
            const { bytesRead } = await fh.read(buf, 0, buf.length, start);
            return { data: buf.subarray(0, bytesRead), total: size };
          });
        } finally {
          await fh.close();
        }
      }
    } else if (/^https?:\/\//i.test(resource)) {
      hash = await hashVia(async (start, end) => {
        const res = await axios.get(resource, {
          headers: { Range: `bytes=${start}-${end}`, "User-Agent": "VLC/3.0.16 LibVLC/3.0.16" },
          responseType: "arraybuffer", timeout: 15_000, maxContentLength: CHUNK * 2, validateStatus: (s) => s === 206,
        }).catch(() => null);
        if (!res) return null;
        return { data: Buffer.from(res.data), total: totalOf(res.headers["content-range"]) };
      });
    }
  } catch (e: any) {
    logger.warn(`[subtitles] could not read the file for its hash: ${e?.message ?? e}`);
  }
  cache.set(resource, { at: Date.now(), hash });
  if (cache.size > 500) cache.delete(cache.keys().next().value as string);
  return hash;
}
