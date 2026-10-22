import { test } from "node:test";
import assert from "node:assert/strict";
import { isWatched, watchPercent, progressType, contentIdsOf, catalogIdOf } from "../src/content/viewers";

// What a progress row says, shared by recommendations and Home rows.

test("a row counts as watching when completed or 20% in, from the stored percent or the duration", () => {
  assert.equal(isWatched({ completed: true, progress: 0, meta: {} }), true);
  assert.equal(isWatched({ completed: false, progress: 0, meta: { progressPercent: 19.9 } }), false);
  assert.equal(isWatched({ completed: false, progress: 0, meta: { progressPercent: 20 } }), true);
  assert.equal(watchPercent({ progress: 600, meta: { duration: 2400 } }), 25);
  assert.equal(watchPercent({ progress: 600, meta: "{\"duration\":3000}" }), 20, "meta stored as JSON text");
  assert.equal(watchPercent({ progress: 600, meta: { duration: 0 } }), null);
  assert.equal(isWatched({ completed: false, progress: 10, meta: null }), false);
});

test("the title a row is: its catalogId, else both guesses; its type from meta, else the id", () => {
  assert.deepEqual(contentIdsOf({ mediaId: "77", meta: { catalogId: "movie_603" } }), ["movie_603"]);
  assert.deepEqual(contentIdsOf({ mediaId: "77", meta: {} }), ["movie_77", "series_77"]);
  assert.equal(catalogIdOf({ meta: "not json" }), null);
  assert.equal(progressType({ meta: { type: "series", catalogId: "movie_1" } }), "series");
  assert.equal(progressType({ meta: { catalogId: "series_9" } }), "series");
  assert.equal(progressType({ meta: { type: "tv" } }), null);
});
