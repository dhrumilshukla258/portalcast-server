// One stored copy per TMDB image (content/imageCache.ts storedSize, owner 2026-10-22).
import { test } from "node:test";
import assert from "node:assert/strict";
import { storedSize } from "../src/content/imageCache";

test("every requested size maps to one of two stored sizes", () => {
  for (const s of ["w45", "w92", "w154", "w185", "w300", "w342", "w500", "h632"]) assert.equal(storedSize(s), "w500", s);
  for (const s of ["w780", "w1280", "original"]) assert.equal(storedSize(s), "w1280", s);
});
