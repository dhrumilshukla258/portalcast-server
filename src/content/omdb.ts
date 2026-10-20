// OMDb (https://www.omdbapi.com): Rotten Tomatoes and Metacritic scores, looked up by the
// IMDb id TMDB gave us (never by title, so no wrong matches). Needs OMDB_API_KEY; without
// it nothing runs. The free key allows 1,000 calls a day, so each day takes the newest
// titles not yet checked, up to OMDB_DAILY_LIMIT (default 900); titles are checked again
// after 90 days (scores settle after release). The key is sent only to OMDb, never logged.

import axios from "axios";
import { Op } from "sequelize";
import { ContentMeta } from "@/models/ContentMeta";
import { omdbApiKey, omdbDailyLimit } from "@/config/server";
import { logger } from "@/infra/logger";

const RECHECK_MS = 90 * 24 * 60 * 60 * 1000;

export async function enrichFromOmdb(): Promise<void> {
  if (!omdbApiKey || omdbDailyLimit === 0) return;
  const rows = (await ContentMeta.findAll({
    where: {
      imdbId: { [Op.ne]: null },
      isRepresentative: true,
      [Op.or]: [{ omdbCheckedAt: null }, { omdbCheckedAt: { [Op.lt]: new Date(Date.now() - RECHECK_MS) } }],
    },
    attributes: ["id", "imdbId"],
    // Never-checked first, newest year first (what people open first), then most voted.
    order: [["omdbCheckedAt", "ASC"], ["year", "DESC"], ["imdbVotes", "DESC"]],
    limit: omdbDailyLimit,
    raw: true,
  })) as any[];
  let checked = 0, filled = 0;
  for (const r of rows) {
    let data: any;
    try {
      ({ data } = await axios.get("https://www.omdbapi.com/", { params: { i: r.imdbId, apikey: omdbApiKey }, timeout: 10000 }));
    } catch (e: any) {
      // 401 is "invalid key" or "request limit reached": stop for today either way.
      logger.warn(`[OMDb] stopped at ${r.imdbId}: status ${e?.response?.status ?? "network error"}`);
      break;
    }
    if (data?.Response === "False" && /limit|key/i.test(String(data?.Error))) {
      logger.warn(`[OMDb] stopped: ${String(data.Error).slice(0, 80)}`);
      break;
    }
    checked++;
    const rt = (data?.Ratings || []).find((x: any) => x?.Source === "Rotten Tomatoes")?.Value;
    const meta = Number(data?.Metascore);
    const patch: Record<string, any> = { omdbCheckedAt: new Date() };
    if (typeof rt === "string" && /^\d{1,3}%$/.test(rt)) patch.rtRating = rt;
    if (meta > 0 && meta <= 100) patch.metascore = meta;
    // A title's other versions share the IMDb id: update them all.
    await ContentMeta.update(patch, { where: { imdbId: r.imdbId } });
    if (patch.rtRating || patch.metascore) filled++;
    await new Promise((res) => setTimeout(res, 200));
  }
  if (checked) logger.info(`[OMDb] ${checked} titles checked, ${filled} with Rotten Tomatoes/Metacritic scores`);
}
