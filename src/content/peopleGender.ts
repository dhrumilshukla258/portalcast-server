// Gender of the people in the catalog, for the People tab's Actors / Actresses (2026-10-22).
//
// Sources: TMDB is where every stored person comes from (all but a handful of name-only NFO
// names carry a TMDB person id), and it gives gender in title credits and person details:
//   - from now on: enrichment stores it with the credits (content/tmdb.ts peopleOf), and a
//     person page refreshes it from the person's details (content/people.ts personDetails);
//   - for people stored before: this job asks TMDB once per title for its credits
//     (`/movie/{id}/credits`, `/tv/{id}/aggregate_credits` + creators) and stores every gender
//     in it, titles with most unknown people first. ~82k titles at about 6 a second, in runs
//     of at most 5 minutes every 10 minutes: a few hours in all, then nothing to do.
// TVmaze, OMDb and the IMDb ratings add nothing here: TVmaze's cast is kept as text only (no
// person rows) and OMDb/IMDb carry no people. NFO files have no gender.
//
// Values: 1 female, 2 male, 3 non-binary, 0 TMDB has none, NULL not asked yet.

import { logger } from "@/infra/logger";
import { fetchCreditGenders } from "@/content/tmdb";
import { titlesNeedingGender, storeTitleGenders, genderCounts } from "@/content/people";
import { loadGenders } from "@/content/peopleSearch";
import { setting } from "@/config/settings";

const RUN_MS = 5 * 60 * 1000;
const GAP_MS = 150;
const BATCH = 200;

let failedThisRun = new Set<string>();

/** The job: fills genders for at most RUN_MS. Returns a one-line summary. */
export async function fillPeopleGenders(): Promise<string> {
  if (!setting<string>("tmdbToken")) return "skipped (no TMDB key)";
  const t0 = Date.now();
  failedThisRun = new Set();
  let titles = 0, known = 0;
  outer: while (Date.now() - t0 < RUN_MS) {
    const batch = (await titlesNeedingGender(BATCH + failedThisRun.size)).filter((t) => !failedThisRun.has(t.titleKey));
    if (batch.length === 0) break;
    for (const { titleKey } of batch) {
      if (Date.now() - t0 >= RUN_MS) break outer;
      const [type, id] = titleKey.split(":");
      const tmdbId = Number(id);
      if (!Number.isInteger(tmdbId) || tmdbId <= 0) { failedThisRun.add(titleKey); continue; }
      const genders = await fetchCreditGenders(type === "series" ? "tv" : "movie", tmdbId);
      await new Promise((r) => setTimeout(r, GAP_MS));
      // No answer (network, or the title is gone from TMDB): tried again next run.
      if (!genders) { failedThisRun.add(titleKey); continue; }
      known += await storeTitleGenders(titleKey, genders);
      titles++;
    }
  }
  const left = await genderCounts();
  // The People tab's Actors / Actresses read genders from memory: refresh it.
  if (titles > 0) await loadGenders();
  const summary = `${titles} titles, ${known} genders stored; ${left.known} people with a gender, ${left.unknown} not asked yet`;
  if (titles > 0) logger.info(`[people] gender fill: ${summary} (${Math.round((Date.now() - t0) / 1000)} s)`);
  return summary;
}
