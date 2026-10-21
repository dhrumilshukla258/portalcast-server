import { test } from "node:test";
import assert from "node:assert/strict";
import { uniqueTagValues } from "../src/content/tags";

test("a title's tags keep each value once, trimmed, first spelling first", () => {
  assert.deepEqual(uniqueTagValues(["Drama", " Drama", "Action", "", "  ", "Drama", "Crime"]), ["Drama", "Action", "Crime"]);
  assert.deepEqual(uniqueTagValues([]), []);
});
