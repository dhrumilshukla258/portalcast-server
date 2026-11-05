// Admin "Merge with…" (content/titleMerges.ts, metaEnrichment mergeTitles): titles that are one
// film but did not group as versions (owner 2026-11-05: the NAS's "Dune: Part One" beside the
// portal's "Dune", the same TMDB id).
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveMerges } from "../src/content/titleMerges";

const m = (from: string, to: string) => ({ type: "movie" as const, from, to, fromName: from, toName: to, at: "" });

test("merges follow chains", () => {
  const r = resolveMerges([m("movie:a", "movie:b"), m("movie:b", "movie:c")]);
  assert.equal(r.get("movie:a"), "movie:c");
  assert.equal(r.get("movie:b"), "movie:c");
  assert.equal(r.get("movie:c"), undefined);
});

test("merging the NAS copy into the portal's title, a new copy following, and undoing it", async () => {
  const { sequelize } = await import("../src/db/index");
  await sequelize.sync();
  const { ContentMeta } = await import("../src/models/ContentMeta");
  const { mergeTitles, unmergeTitle, groupKeyFor, MergeRefused } = await import("../src/content/metaEnrichment");
  const { mergeProblem, listTitleMerges } = await import("../src/content/titleMerges");

  const dune = "movie:dune:tmdb438631";
  const part = "movie:dune part one:tmdb438631";
  await ContentMeta.bulkCreate([
    { id: "movie_314832", type: "movie", name: "Dune - HD", year: "2021", tmdbId: 438631, groupKey: dune, portalCategoryId: "1", isRepresentative: true },
    { id: "movie_572464", type: "movie", name: "Dune UHD", year: "2021", tmdbId: 438631, groupKey: dune, portalCategoryId: "104", isRepresentative: false },
    { id: "movie_L134", type: "movie", name: "Dune: Part One", year: "2021", tmdbId: 438631, groupKey: part, portalCategoryId: "local", isRepresentative: true },
    { id: "series_9", type: "series", name: "Dune: Prophecy", year: "2024", tmdbId: 90228, groupKey: "series:dune prophecy:tmdb90228", portalCategoryId: "5", isRepresentative: true },
  ] as any[]);
  assert.equal(groupKeyFor("movie", "Dune: Part One", "2021", 438631, "local"), part, "two titles before");

  // Refused: another type, or itself.
  await assert.rejects(mergeTitles("movie_L134", "series_9"), MergeRefused);
  await assert.rejects(mergeTitles("movie_L134", "movie_L134"), MergeRefused);

  const r = await mergeTitles("movie_L134", "movie_314832");
  assert.equal(r.moved, 1);
  assert.equal(((await ContentMeta.findByPk("movie_L134")) as any).groupKey, dune, "the NAS copy is a version of Dune");
  // A copy that arrives later under the merged name follows (matching, the regroup, the library).
  assert.equal(groupKeyFor("movie", "Dune: Part One", "2021", 438631, "7"), dune);
  // Merging it again, or the other way round, is refused (already one title).
  assert.ok(mergeProblem(part, dune));
  assert.ok(mergeProblem(dune, part));
  assert.equal(listTitleMerges().length, 1);

  const u = await unmergeTitle(part);
  assert.equal(u?.moved, 1);
  assert.equal(((await ContentMeta.findByPk("movie_L134")) as any).groupKey, part, "its own title again");
  assert.equal(((await ContentMeta.findByPk("movie_314832")) as any).groupKey, dune, "the portal's copies stay");
  assert.equal(await unmergeTitle(part), null);
  assert.equal(groupKeyFor("movie", "Dune: Part One", "2021", 438631, "7"), part);
  await sequelize.close();
});
