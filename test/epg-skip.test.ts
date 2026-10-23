// Channels without a guide (content/epg.ts skipEmpty): asked again only after a while, never
// skipped on one empty answer or with the setting at 0.
import { test } from "node:test";
import assert from "node:assert/strict";
import { skipEmpty } from "../src/content/epg";

const H = 3600_000;
const now = Date.UTC(2026, 9, 23, 12);

test("a channel is skipped only after two empty answers, until the recheck time", () => {
  const state: Record<string, [number, number]> = { once: [1, now - H], twice: [2, now - H], old: [5, now - 73 * H] };
  assert.equal(skipEmpty(state, "unknown", 72 * H, now), false, "never seen: asked");
  assert.equal(skipEmpty(state, "once", 72 * H, now), false, "one empty answer: asked again");
  assert.equal(skipEmpty(state, "twice", 72 * H, now), true, "two in a row: skipped");
  assert.equal(skipEmpty(state, "old", 72 * H, now), false, "asked more than 72 h ago: asked again");
  assert.equal(skipEmpty(state, "twice", 0, now), false, "setting 0: every channel every time");
});
