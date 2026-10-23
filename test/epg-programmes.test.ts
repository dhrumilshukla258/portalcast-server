// A refused channel keeps its running and upcoming programmes from the served guide (epgServe.programmesOf).
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildColumnsForTests, programmesOf, type Snapshot } from "../src/content/epgServe";

test("programmesOf gives one channel's running and upcoming programmes as sent", async () => {
  const now = Math.floor(Date.now() / 1000);
  const p = (name: string, s: number, e: number) => ({ name, start_timestamp: now + s, stop_timestamp: now + e, descr: `${name} story` });
  const cols = await buildColumnsForTests({
    "1": [p("Ended", -7200, -3600), p("Later", 3600, 7200), p("Now", -600, 1800)],
    "2": [p("Other", 0, 3600)],
  }, now);
  const snap = { cols } as unknown as Snapshot;
  assert.deepEqual(programmesOf(snap, "1").map((x) => x.name), ["Now", "Later"]);
  assert.equal(programmesOf(snap, "1")[0].descr, "Now story");
  assert.deepEqual(programmesOf(snap, "2").map((x) => x.name), ["Other"]);
  assert.deepEqual(programmesOf(snap, "nope"), []);
});
