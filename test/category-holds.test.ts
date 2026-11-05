// What a provider category holds, and category overrides per provider profile
// (content/overrides.ts; owner 2026-11-04: "this should be per profile").
import { test } from "node:test";
import assert from "node:assert/strict";
import { genreKey } from "../src/content/overrides";
import { categoryFitsType } from "../src/content/discoverIndex";

test("override keys carry the profile; older keys had none", () => {
  assert.equal(genreKey("movie", "42", 3), "p3:movie_42");
  assert.equal(genreKey("movie", "42"), "movie_42");
  assert.equal(genreKey("vod", "10", 1), "p1:vod_10");
});

test("what the admin says a category holds wins over its titles", () => {
  const counts = new Map([["movie:39", 1], ["series:39", 1010]]);
  assert.equal(categoryFitsType(counts, "movie", "39"), false);
  assert.equal(categoryFitsType(counts, "movie", "39", "both"), true);
  assert.equal(categoryFitsType(counts, "movie", "39", "movie"), true);
  assert.equal(categoryFitsType(counts, "series", "39", "movie"), false);
  assert.equal(categoryFitsType(undefined, "series", "39", "movie"), false);
});

test("a profile's own overrides win; older ones apply until moved to the active profile", async () => {
  const { sequelize } = await import("../src/db/index");
  const { GenreOverride } = await import("../src/models/GenreOverride");
  const { SystemConfig } = await import("../src/models/SystemConfig");
  const { ConfigProfile } = await import("../src/models/ConfigProfile");
  await GenreOverride.sync();
  await SystemConfig.sync();
  await ConfigProfile.sync();
  const { loadGenreOverrides, getHiddenGenreIds, categoryHolds, moveGenreOverridesToProfile } = await import("../src/content/overrides");

  // Written before overrides were per profile: hidden 5, renamed 7.
  await GenreOverride.bulkCreate([
    { genre_key: "movie_5", hidden: true },
    { genre_key: "movie_7", display_name: "Old name" },
  ] as any[]);
  // Profile 2 renamed 7 its own way and holds 10 as series.
  await GenreOverride.bulkCreate([
    { genre_key: "p2:movie_7", display_name: "Profile 2 name" },
    { genre_key: "p2:vod_10", holds: "series" },
  ] as any[]);

  const p1 = await loadGenreOverrides("movie", ["5", "7"], 1);
  assert.ok(p1.get("movie_5")?.hidden, "older rows still apply");
  assert.equal(p1.get("movie_7")?.display_name, "Old name");
  const p2 = await loadGenreOverrides("movie", ["7"], 2);
  assert.equal(p2.get("movie_7")?.display_name, "Profile 2 name", "the profile's own row wins");
  assert.equal((await categoryHolds(2)).get("10"), "series");
  assert.equal((await categoryHolds(1)).size, 0, "another profile's choice does not apply");

  // The active profile is 1: the older rows become its own, once.
  await ConfigProfile.create({ name: "Provider", config: {} as any, isActive: true, isEnabled: true } as any);
  const active = (await ConfigProfile.findOne({ where: { isActive: true } }))!.id;
  await moveGenreOverridesToProfile();
  const keys = (await GenreOverride.findAll({ raw: true })).map((r: any) => r.genre_key).sort();
  assert.deepEqual(keys, [`p${active}:movie_5`, `p${active}:movie_7`, "p2:movie_7", "p2:vod_10"].sort());
  assert.deepEqual([...(await getHiddenGenreIds("movie"))], ["5"]);
  const flag = await SystemConfig.findByPk("genre_overrides_per_profile");
  assert.ok(flag?.value);
  // A second start changes nothing.
  await GenreOverride.create({ genre_key: "movie_9", hidden: true } as any);
  await moveGenreOverridesToProfile();
  assert.ok(await GenreOverride.findByPk("movie_9"), "runs once");
  await sequelize.close();
});
