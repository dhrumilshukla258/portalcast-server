// A rebuilt in-memory catalog replaces the old one everywhere: readers get the new one and
// nothing keeps the old one (a resolved start-up promise held the first one for good, and the
// card loader then fell back to the database after every rebuild).
import { test } from "node:test";
import assert from "node:assert/strict";
import { initDB } from "../src/db";
import { loadSettings, saveSetting } from "../src/config/settings";
import { ContentMeta } from "../src/models/ContentMeta";
import { startCatalogSnapshot, rebuildCatalogSnapshot, catalogReady, catalogSnapshot, onCatalogSwap, catalogChanges } from "../src/content/catalog/store";

test("after a rebuild, readers get the new catalog and the old one is let go", async () => {
  await initDB();
  await loadSettings();
  await saveSetting("catalogSnapshot", true);
  await ContentMeta.upsert({ id: "movie_1", type: "movie", name: "One", portalCategoryId: "1", groupKey: "movie:one", enrichedAt: new Date() } as any);
  let swaps = 0;
  onCatalogSwap(() => { swaps++; });

  await startCatalogSnapshot();
  const first = catalogSnapshot();
  assert.ok(first, "built at start");
  assert.equal(await catalogReady(), first);
  assert.equal((await catalogChanges())?.snap, first);

  await ContentMeta.upsert({ id: "movie_2", type: "movie", name: "Two", portalCategoryId: "1", groupKey: "movie:two", enrichedAt: new Date() } as any);
  await rebuildCatalogSnapshot("test");
  const second = catalogSnapshot();
  assert.ok(second && second !== first, "rebuilt");
  assert.equal(await catalogReady(), second, "readers waiting on start-up get the current catalog, not the first");
  assert.equal((await catalogChanges())?.snap, second, "the change tracker moved on");
  assert.equal(swaps, 2, "readers were told at start and at the rebuild");
});
