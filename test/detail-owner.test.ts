// A movie's files carry the movie's details, not those of whichever title shares a file's id
// (routes/stalkerV2/shared.ts enrichArtworkFromTmdb ownerId; owner 2026-10-25: The Matrix
// opened with a 4.8 film's IMDb link).
import { test } from "node:test";
import assert from "node:assert/strict";

test("a title's files get the title's rating and IMDb id; an episode's files get none", async () => {
  const { sequelize } = await import("../src/db/index");
  const { ContentMeta } = await import("../src/models/ContentMeta");
  await (ContentMeta as any).sync();
  await ContentMeta.bulkCreate([
    { id: "movie_100", type: "movie", name: "The Matrix", groupKey: "g-matrix", isRepresentative: true, tmdbId: 603, imdbId: "tt0133093", imdbRating: 8.7, imdbVotes: 2000000, poster: "/matrix.jpg" },
    // Another title whose id is the Matrix file's id on the portal.
    { id: "movie_555", type: "movie", name: "Some Other Film", groupKey: "g-other", isRepresentative: true, tmdbId: 9999, imdbId: "tt0276868", imdbRating: 4.8, imdbVotes: 900, poster: "/other.jpg" },
  ] as any[]);
  const { enrichArtworkFromTmdb } = await import("../src/routes/stalkerV2/shared");
  const files = [{ id: "555", name: "English / 1080p", screenshot_uri: "" }];

  const owned = await enrichArtworkFromTmdb(files, "movie", "http://pc.test", "100");
  assert.equal(owned[0].imdb_id, "tt0133093");
  assert.equal(owned[0].rating_best, "8.7");
  assert.match(String(owned[0].screenshot_uri), /matrix\.jpg/);
  assert.equal(owned[0].id, "555"); // still the file: it is what plays

  // Before: keyed by the file's own id, the other film's.
  const byFile = await enrichArtworkFromTmdb(files, "movie", "http://pc.test");
  assert.equal(byFile[0].imdb_id, "tt0276868");

  const episode = await enrichArtworkFromTmdb(files, "movie", "http://pc.test", null);
  assert.equal(episode[0].imdb_id, undefined);
  assert.equal(episode[0].rating_best, undefined);
  await sequelize.close();
});
