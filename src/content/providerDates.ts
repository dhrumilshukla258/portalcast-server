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
  // 1. Every title's date from the cached lists, one category at a time. A title listed in more
  //    than one category keeps the earliest date for a movie (when it first arrived) and the
  //    latest for a series (its newest episodes): one value per title, so runs do not flip it.
  const found = new Map<string, number>();
  let seen = 0;
  for (const type of ["movie", "series"] as const) {
    for (const genre of await readGenres(type)) {
      if (!genre.id || genre.id === "*") continue;
      const list = await xtreamCache.get<any[]>(type === "movie" ? `vod_streams_${genre.id}` : `series_list_${genre.id}`);
      if (!Array.isArray(list)) continue;
      seen += list.length;
      for (const it of list) {
        const id = type === "movie" ? it?.stream_id : it?.series_id;
        const sec = providerSeconds(type === "movie" ? it?.added : it?.last_modified ?? it?.added);
        if (id === undefined || id === null || !sec) continue;
        const key = `${type}_${id}`;
        const have = found.get(key);
        if (have === undefined || (type === "movie" ? sec < have : sec > have)) found.set(key, sec);
      }
      await new Promise((r) => setImmediate(r));
    }
  }

  // 2. Only dates that differ from what is stored are written (the first run writes them all,
  //    later runs a handful: quick, and the write lock is held only briefly), 500 per transaction.
  const changes: [string, number][] = [];
  for (const r of (await sequelize.query("SELECT id, providerAddedAt FROM content_meta", { type: QueryTypes.SELECT })) as any[]) {
    const sec = found.get(String(r.id));
    if (sec && sec !== (Number(r.providerAddedAt) || 0)) changes.push([String(r.id), sec]);
  }
  for (let i = 0; i < changes.length; i += 500) {
    await sequelize.transaction(async (transaction) => {
      for (const [id, sec] of changes.slice(i, i + 500)) {
        await sequelize.query("UPDATE content_meta SET providerAddedAt = ? WHERE id = ?", { replacements: [sec, id], transaction });
      }
    });
    await new Promise((r) => setImmediate(r));
  }
  if (changes.length) {
    logger.info(`[provider-dates] ${changes.length} titles got a new provider date (${seen} read)`);
    onChanged?.();
  }
  return `${seen} titles read, ${changes.length} dates changed`;
}
