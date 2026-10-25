// movies?movieId=LF<id> answers with that local file, not My Library's first title
// (content/library/catalog.ts localFileAsTitle; owner 2026-10-25: no local movie played).
import { test } from "node:test";
import assert from "node:assert/strict";

test("a local file's id asked as a movie gives that file", async () => {
  const { sequelize } = await import("../src/db/index");
  const { LocalItem } = await import("../src/models/LocalItem");
  const { MediaFile } = await import("../src/models/MediaFile");
  const { ContentMeta } = await import("../src/models/ContentMeta");
  const { Library } = await import("../src/models/Library");
  void Library; void ContentMeta;
  await sequelize.sync(); // every model's table: the title's lookup reads its tags too
  await LocalItem.bulkCreate([
    { id: 1, libraryId: 1, kind: "movie", root: "/m", relPath: "A (2020)", name: "First Title", year: "2020" },
    { id: 2, libraryId: 1, kind: "movie", root: "/m", relPath: "Sonic 2 (2022)", name: "Sonic the Hedgehog 2", year: "2022" },
  ] as any[]);
  await MediaFile.bulkCreate([
    { id: 10, itemId: 1, libraryId: 1, root: "/m", relPath: "A (2020)/a.mkv", size: 1, mtimeMs: 1, height: 1080 },
    { id: 20, itemId: 2, libraryId: 1, root: "/m", relPath: "Sonic 2 (2022)/s2-1080.mkv", size: 1, mtimeMs: 1, height: 1080 },
    { id: 21, itemId: 2, libraryId: 1, root: "/m", relPath: "Sonic 2 (2022)/s2-2160.mkv", size: 1, mtimeMs: 1, height: 2160 },
  ] as any[]);
  const { localFileAsTitle } = await import("../src/content/library/catalog");

  const one = await localFileAsTitle("LF20");
  assert.deepEqual(one.data.map((d: any) => d.id), ["LF20"]);
  assert.equal(one.total_items, 1);

  const missing = await localFileAsTitle("LF999");
  assert.equal(missing.data.length, 0);
  await sequelize.close();
});
