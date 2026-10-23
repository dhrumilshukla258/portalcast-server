// A title matched to a different TMDB title (the IMDb correction job, the year fix, "Fix
// match") must not keep what only the old title had: its ratings, trailer, runtime...
import { test } from "node:test";
import assert from "node:assert/strict";
import { initDB } from "../src/db";
import { ContentMeta } from "../src/models/ContentMeta";
import { xtreamCache } from "../src/services/xtreamCache";
import { enrichLocalTitle } from "../src/content/metaEnrichment";

const meta = (tmdbId: number, extra: Record<string, unknown> = {}) => ({
  poster: null, backdrop: null, backdropHd: null, overview: `title ${tmdbId}`, cast: null, director: null, trailerKey: null,
  tmdbId, genres: [], originalLanguage: "en", countries: [], keywordIds: [], releaseYear: "2016", rating: null, ratingCount: null,
  imdbId: null,
  details: { tagline: null, ageRating: null, runtime: null, studios: [], collection: null, originalTitle: null, premiered: null, logo: null, people: [] },
  ...extra,
});

test("a changed match clears the old title's own data; a refresh of the same one keeps it", async () => {
  await initDB();
  const id = "local_rematch_1";
  const store = async (tmdbId: number, m: any) => { await xtreamCache.set(`tmdb_local_${id}_${tmdbId}`, m); await enrichLocalTitle({ contentId: id, type: "movie", name: "Lion", year: null, tmdbId }); };
  await store(8587, meta(8587, { trailerKey: "old-trailer", rating: 8.3, ratingCount: 9000, imdbId: "tt0110357",
    details: { ...meta(0).details, tagline: "old tagline", runtime: 88, logo: "/old-logo.png" } }));
  await ContentMeta.update({ imdbRating: 8.5, rtRating: "93%", metascore: 88, omdbCheckedAt: new Date() }, { where: { id } });

  // The same title again: nothing is lost.
  await store(8587, meta(8587, { imdbId: "tt0110357" }));
  let row: any = await ContentMeta.findByPk(id, { raw: true });
  assert.equal(row.trailerKey, "old-trailer");
  assert.equal(row.rtRating, "93%");
  assert.equal(row.runtime, 88);

  // A different title with less known about it: none of the old one's data stays.
  await store(334543, meta(334543, { imdbId: "tt3741834" }));
  row = await ContentMeta.findByPk(id, { raw: true });
  assert.equal(Number(row.tmdbId), 334543);
  assert.equal(row.imdbId, "tt3741834");
  for (const k of ["trailerKey", "rating", "imdbRating", "rtRating", "metascore", "omdbCheckedAt", "tagline", "runtime", "logo"]) assert.equal(row[k], null, k);
  assert.ok(row.detailsCheckedAt, "the new title's details were stored");
});
