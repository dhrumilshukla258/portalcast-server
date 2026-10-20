// IMDb ratings from IMDb's own daily file (https://developer.imdb.com/non-commercial-datasets/,
// title.ratings.tsv.gz: tconst, averageRating, numVotes; about 1.5M rows, 8 MB). Free for
// personal, non-commercial use; no key. IMDb has no free API, and reading ratings off its
// web pages is against its terms, so the file is the source: it is refreshed every day,
// and we load it at most once a day. Only titles whose IMDb id TMDB gave us are updated.

import axios from "axios";
import zlib from "zlib";
import readline from "readline";
import { QueryTypes } from "sequelize";
import { ContentMeta } from "@/models/ContentMeta";
import { SystemConfig } from "@/models/SystemConfig";
import { logger } from "@/infra/logger";

const URL = "https://datasets.imdbws.com/title.ratings.tsv.gz";
const SYNCED_KEY = "imdb_ratings_synced_at";
const EVERY_MS = 20 * 60 * 60 * 1000;

export async function syncImdbRatings(force = false): Promise<void> {
  const last = Number((await SystemConfig.findByPk(SYNCED_KEY))?.value ?? 0);
  if (!force && Date.now() - last < EVERY_MS) return;

  const sequelize = ContentMeta.sequelize!;
  const ours = (await sequelize.query("SELECT DISTINCT `imdbId` FROM `content_meta` WHERE `imdbId` IS NOT NULL", { type: QueryTypes.SELECT })) as any[];
  const wanted = new Set(ours.map((r) => r.imdbId as string));
  if (wanted.size === 0) return;

  const found: [string, number, number][] = [];
  try {
    const res = await axios.get(URL, { responseType: "stream", timeout: 120000 });
    const lines = readline.createInterface({ input: res.data.pipe(zlib.createGunzip()), crlfDelay: Infinity });
    for await (const line of lines) {
      const tab = line.indexOf("\t");
      const id = line.slice(0, tab);
      if (!wanted.has(id)) continue;
      const [, avg, votes] = line.split("\t");
      const a = Number(avg), v = Number(votes);
      if (a > 0 && v > 0) found.push([id, a, v]);
    }
  } catch (e: any) {
    logger.warn(`[IMDb] ratings file not loaded: ${e?.message ?? e}`);
    return;
  }

  // Small transactions: a long write lock would stall users' progress saves.
  for (let i = 0; i < found.length; i += 1000) {
    const slice = found.slice(i, i + 1000);
    await sequelize.transaction(async (transaction) => {
      for (const [id, a, v] of slice) {
        await sequelize.query("UPDATE `content_meta` SET `imdbRating` = ?, `imdbVotes` = ? WHERE `imdbId` = ?", { replacements: [a, v, id], transaction });
      }
    });
  }
  await SystemConfig.upsert({ key: SYNCED_KEY, value: Date.now() });
  logger.info(`[IMDb] ratings updated for ${found.length} of ${wanted.size} IMDb ids`);
}
