import { test } from "node:test";
import assert from "node:assert/strict";
import { shadowCheck, shadowStatus } from "../src/content/catalog/shadow";

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

test("one call in 20 is compared in the background; a difference is counted with its place", async () => {
  let dbReads = 0;
  for (let i = 0; i < 19; i++) shadowCheck("cards", "same", async () => { dbReads++; return "same"; });
  await settle();
  assert.equal(dbReads, 0, "not sampled yet");
  shadowCheck("cards", '{"name":"Snapshot"}', async () => { dbReads++; return '{"name":"Database"}'; });
  await settle();
  assert.equal(dbReads, 1);
  const s = shadowStatus();
  assert.equal(s.checked, 1);
  assert.equal(s.differed, 1);
  assert.match(s.lastDifference!.detail, /Database.*Snapshot/);
});

test("at most one check a second, so it never piles up under load", async () => {
  let dbReads = 0;
  for (let i = 0; i < 200; i++) shadowCheck("cards", "x", async () => { dbReads++; return "x"; });
  await settle();
  assert.equal(dbReads, 0, "the previous check was less than a second ago");
  await new Promise((resolve) => setTimeout(resolve, 1050));
  for (let i = 0; i < 20; i++) shadowCheck("cards", "x", async () => { dbReads++; return "x"; });
  await settle();
  assert.equal(dbReads, 1);
  assert.equal(shadowStatus().differed, 1, "an equal answer adds no difference");
});
