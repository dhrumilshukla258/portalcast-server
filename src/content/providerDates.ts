// The provider's own dates per title (owner, 2026-10-22: "the new content added by the IPTV
// helps"): a movie's `added`, a series' `last_modified` (portals move it when episodes are added).
// Stored as content_meta.providerAddedAt (unix seconds) by a job that walks the cached provider
// lists one category at a time (memory stays flat), one transaction per category. Used by Home
// (content/homeThemes.ts): "Just added" by the provider's date, "New episodes" of watched series.

import { QueryTypes } from "sequelize";
import { sequelize } from "@/db";
import { readGenres } from "@/infra/storage";
import { xtreamCache } from "@/services/xtreamCache";
import { logger } from "@/infra/logger";

/** A provider date (unix seconds or ms, or a date string) as unix seconds; null when unusable. */
export function providerSeconds(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const n = Number(raw);
  // A number is a timestamp or nothing ("0" is not the year 2000, as Date.parse would read it).
  if (Number.isFinite(n)) {
    const sec = n > 1e12 ? Math.floor(n / 1000) : Math.floor(n);
    return sec > 946_684_800 && sec < Date.now() / 1000 + 86_400 ? sec : null; // 2000 .. tomorrow
  }
  const t = Date.parse(String(raw));
  return Number.isFinite(t) ? providerSeconds(Math.floor(t / 1000)) : null;
}

let onChanged: (() => void) | null = null;
/** Home's rows are rebuilt when dates changed (content/home.ts registers markHomeStale). */
export function onProviderDatesChanged(fn: () => void): void {
  onChanged = fn;
}

export async function fillProviderDates(): Promise<string> {
  let seen = 0, changed = 0;
  for (const type of ["movie", "series"] as const) {
    const genres = await readGenres(type);
    for (const genre of genres) {
      if (!genre.id || genre.id === "*") continue;
      const list = await xtreamCache.get<any[]>(type === "movie" ? `vod_streams_${genre.id}` : `series_list_${genre.id}`);
      if (!Array.isArray(list) || !list.length) continue;
      const pairs: [string, number][] = [];
      for (const it of list) {
        const id = type === "movie" ? it?.stream_id : it?.series_id;
        const sec = providerSeconds(type === "movie" ? it?.added : it?.last_modified ?? it?.added);
        if (id !== undefined && id !== null && sec) pairs.push([`${type}_${id}`, sec]);
      }
      if (!pairs.length) continue;
      seen += pairs.length;
      await sequelize.transaction(async (transaction) => {
        // SQLite's own count of changed rows on this connection, before and after.
        const total = async () => Number(((await sequelize.query("SELECT total_changes() AS n", { transaction, type: QueryTypes.SELECT })) as any[])[0]?.n ?? 0);
        const before = await total();
        for (const [id, sec] of pairs) {
          await sequelize.query(
            "UPDATE content_meta SET providerAddedAt = ? WHERE id = ? AND (providerAddedAt IS NULL OR providerAddedAt <> ?)",
            { replacements: [sec, id, sec], transaction },
          );
        }
        changed += (await total()) - before;
      });
      await new Promise((r) => setImmediate(r));
    }
  }
  if (changed > 0) {
    logger.info(`[provider-dates] ${changed} titles got a new provider date (${seen} read)`);
    onChanged?.();
  }
  return `${seen} titles read, ${changed} dates changed`;
}
