// Home versions per viewer (content/viewers.ts viewerGenerationOf): one viewer's playback
// leaves the others' cached Home alone; a title someone finishes (Popular on this server) or
// removes from their history moves everyone's.
import { test } from "node:test";
import assert from "node:assert/strict";
import { initDB } from "../src/db";
import { viewersReady, saveProgress, deleteProgress, viewerGenerationOf } from "../src/content/viewers";

test("positions move only the viewer's own version; watched titles move everyone's", async () => {
  await initDB();
  await viewersReady();
  const meta = { duration: 6000, type: "movie" };
  const a0 = viewerGenerationOf(1, 1), b0 = viewerGenerationOf(2, 1);

  await saveProgress(2, 1, "m1", 30, false, meta); // 0.5 %: not watched
  await saveProgress(2, 1, "m1", 90, false, meta);
  assert.equal(viewerGenerationOf(1, 1), a0, "another viewer's positions");
  assert.notEqual(viewerGenerationOf(2, 1), b0, "the viewer's own");

  const a1 = viewerGenerationOf(1, 1);
  await saveProgress(2, 1, "m1", 3000, false, meta); // 50 %: watched now
  assert.notEqual(viewerGenerationOf(1, 1), a1, "a title became watched");

  const a2 = viewerGenerationOf(1, 1);
  await saveProgress(2, 1, "m1", 3200, false, meta); // still watched, recent
  assert.equal(viewerGenerationOf(1, 1), a2, "a watched title's position");

  await deleteProgress(2, 1, "m1");
  assert.notEqual(viewerGenerationOf(1, 1), a2, "a watched title removed from history");

  const a3 = viewerGenerationOf(1, 1);
  await saveProgress(2, 1, "m2", 10, false, meta);
  await deleteProgress(2, 1, "m2");
  assert.equal(viewerGenerationOf(1, 1), a3, "an unwatched title removed");
});
