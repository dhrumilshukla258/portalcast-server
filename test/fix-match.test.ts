// Admin "Fix match" on a portal title (content/metaEnrichment.ts fixPortalMatch), with a
// stand-in TMDB: the chosen title is stored and locked, null matches automatically again.
import { test } from "node:test";
import assert from "node:assert/strict";
import { initDB } from "../src/db";
import { loadSettings, saveSetting } from "../src/config/settings";
import { ContentMeta } from "../src/models/ContentMeta";
import { fixPortalMatch } from "../src/content/metaEnrichment";
import { idInQuery } from "../src/content/tmdb";

const titles: Record<number, { title: string; date: string; imdb: string }> = {
  8587: { title: "The Lion King", date: "1994-06-15", imdb: "tt0110357" },
  334543: { title: "Lion", date: "2016-11-25", imdb: "tt3741834" },
};
const detail = (id: number) => ({
  id, title: titles[id].title, release_date: titles[id].date, genres: [{ id: 18, name: "Drama" }], production_countries: [], original_language: "en",
  overview: `About ${titles[id].title}`, poster_path: `/p${id}.jpg`, backdrop_path: null, vote_average: 8, vote_count: 100, imdb_id: titles[id].imdb,
  credits: { cast: [], crew: [] }, keywords: { keywords: [] }, external_ids: { imdb_id: titles[id].imdb }, videos: { results: [] },
  images: { logos: [], backdrops: [], posters: [] }, release_dates: { results: [] },
});
async function standIn(url: string) {
  const d = /\/movie\/(\d+)/.exec(url);
  if (d && titles[+d[1]]) return { data: detail(+d[1]) };
  if (/\/search\/movie/.test(url)) return { data: { results: [{ id: 8587, title: "The Lion King", release_date: "1994-06-15", popularity: 50, vote_count: 9000 }] } };
  const e: any = new Error("404"); e.response = { status: 404 }; throw e;
}

test("Fix match: the chosen title is kept and locked; null matches automatically again", async () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("axios").get = standIn;
  (await import("axios")).default.get = standIn as any;
  await initDB();
  await loadSettings();
  await saveSetting("tmdbToken", "stand-in");
  await ContentMeta.upsert({ id: "movie_9001", type: "movie", name: "Lion", portalCategoryId: "77", tmdbId: 8587, source: "tmdb", year: "1994", enrichedAt: new Date() } as any);

  assert.deepEqual(await fixPortalMatch("movie_9001", 334543), { tmdbId: 334543, locked: true });
  let row: any = await ContentMeta.findByPk("movie_9001", { raw: true });
  assert.equal(Number(row.tmdbId), 334543);
  assert.equal(Number(row.tmdbIdLocked), 334543);
  assert.equal(row.year, "2016");
  assert.equal(row.imdbId, "tt3741834");

  await assert.rejects(fixPortalMatch("movie_9001", 999999), /TMDB has no movie 999999/);
  row = await ContentMeta.findByPk("movie_9001", { raw: true });
  assert.equal(Number(row.tmdbId), 334543, "a failed choice changes nothing");

  assert.deepEqual(await fixPortalMatch("movie_9001", null), { tmdbId: 8587, locked: false });
  row = await ContentMeta.findByPk("movie_9001", { raw: true });
  assert.equal(row.tmdbIdLocked, null);

  assert.equal(await fixPortalMatch("movie_missing", 334543), null);
  await ContentMeta.upsert({ id: "movie_L1", type: "movie", name: "Home video", portalCategoryId: "local" } as any);
  assert.equal(await fixPortalMatch("movie_L1", 334543), null, "local titles have their own Fix match");
});

test("a pasted IMDb id, IMDb or TMDB link, or TMDB id names the title", () => {
  assert.deepEqual(idInQuery("tt3741834"), { imdbId: "tt3741834" });
  assert.deepEqual(idInQuery(" https://www.imdb.com/title/tt3741834/?ref_=fn "), { imdbId: "tt3741834" });
  assert.deepEqual(idInQuery("https://www.themoviedb.org/movie/334543-lion"), { tmdbId: 334543 });
  assert.deepEqual(idInQuery("https://www.themoviedb.org/tv/1399-game-of-thrones/season/1"), { tmdbId: 1399 });
  assert.deepEqual(idInQuery("1917"), { tmdbId: 1917 }, "also searched as a name");
  assert.equal(idInQuery("Lion"), null);
  assert.equal(idInQuery("Blade Runner 2049"), null);
});
