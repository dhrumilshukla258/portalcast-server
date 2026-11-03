// /api/v2/series and /api/v2/movies with season parts merged (routes/stalkerV2/seasonMerge.ts),
// around a stand-in for the provider-facing handler. Mylanchi as one catalog has it: season 7
// twice, once filed by the provider as season 1 with the finale, once as season 7.
import { test } from "node:test";
import assert from "node:assert/strict";

const ep = (id: string, n: number, title: string) => ({ id, series_number: String(n), name: `Episode ${n}. ${title}`, is_episode: 1 });
// What the provider-facing handler answers, by "movieId|seasonId|page".
const answers: Record<string, any[]> = {
  "515872||1": [{ id: "1", video_id: "515872", season_number: "1", name: "Season 1. Mylanchi S07", is_season: true }],
  "574273||1": [{ id: "7", video_id: "574273", season_number: "7", name: "Season 7. Mylanchi Season 7", is_season: true }],
  "515872|1|1": [ep("e27", 27, "28-05-2023 : And the Winner Is?"), ep("e26", 26, "A Finale to Remember"), ep("e25a", 25, "Guests")],
  "574273|7|1": [ep("f25", 25, "Episode 25"), ep("f24", 24, "Episode 24")],
  // A plain show, untouched.
  "900||1": [{ id: "5600", season_number: "1", name: "Season 1", is_season: true }],
};
const calls: string[] = [];
async function inner(request: any) {
  const q = request.query;
  const key = `${q.movieId}|${q.seasonId && q.seasonId !== "0" ? q.seasonId : ""}|${q.page ?? 1}`;
  calls.push(`${key}${q.episodeId ? `|ep${q.episodeId}` : ""}${q.seasonNumber ? `|n${q.seasonNumber}` : ""}`);
  if (q.episodeId) {
    const list = answers[`${q.movieId}|${q.seasonId}|1`] ?? [];
    const found = list.filter((e) => e.id === String(q.episodeId));
    return { success: true, data: found.map((e) => ({ ...e, cmd: `play/${q.movieId}/${e.id}` })) };
  }
  const data = answers[key] ?? [];
  return { success: true, page: Number(q.page ?? 1), total_items: data.length, data };
}
const h = {} as any;
const req = (query: Record<string, any>) => ({ query: { category: "*", ...query }, headers: {}, info: {} }) as any;

test("season parts: one season list, episodes merged, files from the right part", async () => {
  await import("../src/db/index");
  const { ContentMeta } = await import("../src/models/ContentMeta");
  const { Genre } = await import("../src/models/Genre");
  await (ContentMeta as any).sync();
  await (Genre as any).sync();
  for (const m of ["ContentOverride", "ConfigProfile"]) await ((await import(`../src/models/${m}`)) as any)[m].sync();
  await Genre.bulkCreate([{ id: "1_series_28", title: "MALAYALAM | TV SHOWS", type: "series", profileId: 1 }] as any[]);
  await ContentMeta.bulkCreate([
    { id: "series_515872", type: "series", name: "Asianet : Mylanchi S07", groupKey: "series:mylanchi:tmdb235327", portalCategoryId: "28", tmdbId: 235327, isRepresentative: false },
    { id: "series_574273", type: "series", name: "Asianet : Mylanchi Season 7", groupKey: "series:mylanchi:tmdb235327", portalCategoryId: "28", tmdbId: 235327, isRepresentative: true },
    { id: "series_900", type: "series", name: "Westworld", groupKey: "series:westworld:tmdb63247", portalCategoryId: "28", tmdbId: 63247, isRepresentative: true },
  ] as any[]);
  const { mergeSeriesHandler, mergeMoviesHandler } = await import("../src/routes/stalkerV2/seasonMerge");
  const series = mergeSeriesHandler(inner);
  const movies = mergeMoviesHandler(inner);

  // Seasons: one Season 7 from both parts, the opened one first at equal quality.
  const seasons = await series(req({ movieId: "574273" }), h);
  assert.equal(seasons.data.length, 1);
  assert.equal(seasons.data[0].name, "Season 7");
  assert.equal(seasons.data[0].id, "m:7:574273.7~515872.1");
  // The same from the other part.
  const other = await series(req({ movieId: "515872" }), h);
  assert.equal(other.data[0].id, "m:7:515872.1~574273.7");

  // Episodes: every number once; 25 from the copy with a real title.
  const eps = await series(req({ movieId: "574273", seasonId: seasons.data[0].id, page: 1 }), h);
  assert.deepEqual(eps.data.map((e: any) => e.id), ["e27", "e26", "e25a", "f24"]);
  assert.equal(eps.total_items, 4);
  assert.ok(eps.data.every((e: any) => e.season_id === seasons.data[0].id));
  // Each part asked with the merged season's number (TMDB art for season 7, not 1).
  assert.ok(calls.includes("515872|1|1|n7"));

  // An episode's file: from the part that has it, on either route.
  const file = await movies(req({ movieId: "574273", seasonId: seasons.data[0].id, episodeId: "f24" }), h);
  assert.equal(file.data[0].cmd, "play/574273/f24");
  const file2 = await series(req({ movieId: "574273", seasonId: seasons.data[0].id, episodeId: "e27" }), h);
  assert.equal(file2.data[0].cmd, "play/515872/e27");

  // A show without season parts, and requests with a plain season id: as before.
  calls.length = 0;
  const plain = await series(req({ movieId: "900" }), h);
  assert.equal(plain.data[0].id, "5600");
  await series(req({ movieId: "900", seasonId: "5600" }), h);
  assert.deepEqual(calls, ["900||1", "900|5600|1"]);
});
