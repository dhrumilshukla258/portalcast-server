// Which series an IPTV episode id belongs to, and its episode number (speed plan, data
// model step). Replaces the 932,868 `ep_info_<id>` key/value rows of xtream_cache: one
// compact table keyed by the integer episode id (db/index.ts creates it), written in
// batches by the series warm-up and read by movie-link to label a stream.

import { QueryTypes } from "sequelize";
import { XtreamCache } from "@/models/XtreamCache";
import { logger } from "@/infra/logger";

const pending = new Map<number, [number, number]>(); // episodeId -> [seriesId, episodeNum]
let flushing: Promise<void> | null = null;
const BATCH = 300; // 3 bound parameters per row: under SQLite's historical 999 limit

const db = () => XtreamCache.sequelize!;

/** Records an episode's series (batched; visible to episodeLocation at once). */
export function rememberEpisode(episodeId: string | number, seriesId: string | number, episodeNum: number): void {
  const e = Number(episodeId), s = Number(seriesId);
  if (!Number.isSafeInteger(e) || !Number.isSafeInteger(s)) return;
  pending.set(e, [s, Number.isFinite(episodeNum) ? episodeNum : 0]);
  if (flushing) return;
  flushing = (async () => {
    await new Promise((r) => setImmediate(r)); // let the caller's loop queue a whole season first
    while (pending.size > 0) {
      const rows: [number, number, number][] = [];
      for (const [id, [series, num]] of pending) {
        rows.push([id, series, num]);
        if (rows.length >= BATCH) break;
      }
      for (const [id] of rows) pending.delete(id);
      try {
        await db().query(
          `INSERT OR REPLACE INTO episode_index (episodeId, seriesId, episode) VALUES ${rows.map(() => "(?, ?, ?)").join(", ")}`,
          { replacements: rows.flat() },
        );
      } catch (e: any) {
        logger.error(`[episodes] writing ${rows.length} episode rows failed: ${e?.message ?? e}`);
      }
    }
  })().finally(() => {
    flushing = null;
  });
}

/** The series and episode number an episode id was last seen under, or null. */
export async function episodeLocation(episodeId: string | number): Promise<{ seriesId: number; episode: number } | null> {
  const e = Number(episodeId);
  if (!Number.isSafeInteger(e)) return null;
  const queued = pending.get(e);
  if (queued) return { seriesId: queued[0], episode: queued[1] };
  const rows = (await db().query("SELECT seriesId, episode FROM episode_index WHERE episodeId = ?", {
    replacements: [e],
    type: QueryTypes.SELECT,
  })) as { seriesId: number; episode: number }[];
  return rows[0] ?? null;
}
