// Card posters ready before anyone scrolls to them (plan Phase 4): the apps show cards at
// w342 (content/imageCache.ts serves /api/images/tmdb/w342/...). This nightly job puts the
// w342 poster of every representative title in the image cache folder, newest titles first,
// as a slow trickle for TMDB (2 a second, at most 3 hours a night: the first full pass over
// ~95k titles takes a few nights, later nights only fetch new titles). Downloads go straight
// to disk, never into the in-memory image cache that serves what viewers are looking at.

import { QueryTypes } from "sequelize";
import { sequelize } from "@/db";
import { logger } from "@/infra/logger";
import { imageCacheEnabled, prefetchToDisk, tmdbImageParts } from "@/content/imageCache";

const SIZE = "w342";
const PER_SECOND = 2;
const BUDGET_MS = 3 * 60 * 60 * 1000;

export async function prefillCardPosters(): Promise<string> {
  if (!imageCacheEnabled()) return "image cache is off";
  const rows = (await sequelize.query(
    "SELECT poster FROM content_meta WHERE isRepresentative = 1 AND poster LIKE 'https://image.tmdb.org/t/p/%' ORDER BY enrichedAt DESC",
    { type: QueryTypes.SELECT },
  )) as { poster: string }[];
  const started = Date.now();
  let fetched = 0, cached = 0, missing = 0, done = 0;
  for (const { poster } of rows) {
    if (Date.now() - started > BUDGET_MS) break;
    const parts = tmdbImageParts(poster);
    if (!parts) continue;
    const result = await prefetchToDisk(SIZE, parts.file);
    done++;
    if (result === "cached") { cached++; continue; } // nothing asked of TMDB: no wait
    if (result === "fetched") fetched++; else missing++;
    await new Promise((r) => setTimeout(r, 1000 / PER_SECOND));
  }
  const summary = `${fetched} fetched, ${cached} already cached, ${missing} unavailable, ${rows.length - done} left for the next night`;
  logger.info(`[images] card poster pre-fill: ${summary}`);
  return summary;
}
