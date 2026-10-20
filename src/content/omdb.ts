// OMDb (https://www.omdbapi.com): Rotten Tomatoes and Metacritic scores, looked up by the
// IMDb id TMDB gave us (never by title, so no wrong matches). Needs OMDB_API_KEY (one key or
// several, comma-separated); without it nothing runs. A free key allows 1,000 calls a day:
// each key is used up to OMDB_DAILY_LIMIT (default 900) calls, or until OMDb refuses it, then
// the next. Each day takes the newest titles not yet checked; titles are checked again after
// 90 days (scores settle after release). Keys go only to OMDb and are never logged.

import { setting } from "@/config/settings";
import axios from "axios";
import { Op } from "sequelize";
import { ContentMeta } from "@/models/ContentMeta";
import { logger } from "@/infra/logger";

const RECHECK_MS = 90 * 24 * 60 * 60 * 1000;

export async function enrichFromOmdb(): Promise<void> {
  const omdbApiKeys = setting<string[]>("omdbKeys");
  const omdbDailyLimit = setting<number>("omdbDailyLimit");
  if (omdbApiKeys.length === 0 || omdbDailyLimit === 0) return;
  const rows = (await ContentMeta.findAll({
    where: {
      imdbId: { [Op.ne]: null },
      isRepresentative: true,
      [Op.or]: [{ omdbCheckedAt: null }, { omdbCheckedAt: { [Op.lt]: new Date(Date.now() - RECHECK_MS) } }],
    },
    attributes: ["id", "imdbId"],
    // Never-checked first, newest year first (what people open first), then most voted.
    order: [["omdbCheckedAt", "ASC"], ["year", "DESC"], ["imdbVotes", "DESC"]],
    limit: omdbDailyLimit * omdbApiKeys.length,
    raw: true,
  })) as any[];
  let checked = 0, filled = 0;
  let k = 0, used = 0; // current key (by position; logs name it "key 2", never its value)
  rowLoop: for (const r of rows) {
    let data: any;
    for (;;) {
      if (k >= omdbApiKeys.length) break rowLoop;
      if (used >= omdbDailyLimit) { k++; used = 0; continue; }
      try {
        used++;
        ({ data } = await axios.get("https://www.omdbapi.com/", { params: { i: r.imdbId, apikey: omdbApiKeys[k] }, timeout: 10000 }));
      } catch (e: any) {
        const status = e?.response?.status;
        if (!status) { logger.warn(`[OMDb] stopped at ${r.imdbId}: network error`); break rowLoop; }
        // 401: invalid key or its daily limit reached. Move to the next key.
        logger.warn(`[OMDb] key ${k + 1} refused (status ${status}); ${k + 1 < omdbApiKeys.length ? "next key" : "no keys left today"}`);
        k++; used = 0;
        continue;
      }
      if (data?.Response === "False" && /limit|key/i.test(String(data?.Error))) {
        logger.warn(`[OMDb] key ${k + 1}: ${String(data.Error).slice(0, 60)}; ${k + 1 < omdbApiKeys.length ? "next key" : "no keys left today"}`);
        k++; used = 0;
        continue;
      }
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
