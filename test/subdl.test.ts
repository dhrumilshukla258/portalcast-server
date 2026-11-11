// SubDL links (content/subdl.ts): SubDL appends "?api_key=<key>" to every result's link now,
// and the path check dropped them all (owner 2026-11-11: SubDL never showed). The key must
// never reach the apps: the result's id is the path without it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { subdlPathOf, isValidSubdlPath } from "../src/content/subdl";

test("a SubDL link keeps its path and loses the key", () => {
  assert.equal(subdlPathOf("/subtitle/3602620-8520000.zip?api_key=subdl_EXAMPLE"), "/subtitle/3602620-8520000.zip");
  assert.equal(subdlPathOf("/subtitle/3197651-3213944.zip"), "/subtitle/3197651-3213944.zip", "older links too");
  assert.equal(subdlPathOf("/subtitle/x.zip#frag"), "/subtitle/x.zip");
  for (const bad of ["", null, undefined, "https://evil.example/subtitle/1.zip", "/subtitle/../etc.zip?x", "/other/1.zip"]) {
    assert.equal(subdlPathOf(bad), null, String(bad));
  }
  assert.equal(isValidSubdlPath("/subtitle/3602620-8520000.zip?api_key=x"), false, "a key never passes as a path");
});
