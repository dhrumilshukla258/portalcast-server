// New episodes of watched series (content/episodeWatch.ts) and provider dates in the list cache
// (services/xtreamCache.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { episodeSummary, newEpisodesAt, seriesCandidates } from "../src/content/episodeWatch";
import { mapVodItem } from "../src/services/xtreamCache";

const DAY = 86_400_000;
const now = Date.UTC(2026, 9, 23, 12);
const sec = (ms: number) => Math.floor(ms / 1000);
const info = (dates: (string | null)[][]) => ({
  episodes: Object.fromEntries(dates.map((season, i) => [String(i + 1), season.map((d, j) => ({ id: `${i}-${j}`, info: { releasedate: d ?? "" } }))])),
});

test("episodes are counted over every season, with the newest date the portal gave", () => {
  const s = episodeSummary(info([["2026-01-01 10:00:00", "2026-01-08 10:00:00"], ["2026-10-20 10:00:00"]]));
  assert.equal(s.n, 3);
  assert.equal(s.newest, sec(Date.parse("2026-10-20 10:00:00")));
  assert.deepEqual(episodeSummary(info([[null, null]])), { n: 2, newest: 0 });
  assert.deepEqual(episodeSummary(null), { n: 0, newest: 0 });
});

test("the first look never calls a series new without the portal's own dates", () => {
  assert.equal(newEpisodesAt(undefined, { n: 10, newest: 0 }, now), null);
  assert.equal(newEpisodesAt(undefined, { n: 10, newest: sec(now - 3 * DAY) }, now), sec(now - 3 * DAY));
});

test("a list that grew since the last check is new: the portal's date, else the check's time", () => {
  const prev = { n: 10, at: now - DAY };
  assert.equal(newEpisodesAt(prev, { n: 10, newest: 0 }, now), null, "same count: nothing new");
  assert.equal(newEpisodesAt(prev, { n: 11, newest: 0 }, now), sec(now), "no dates: the check's time");
  assert.equal(newEpisodesAt(prev, { n: 11, newest: sec(now - 6 * 3600_000) }, now), sec(now - 6 * 3600_000), "the portal's date");
  // A portal that dates every episode with its season's date: older than the last check.
  assert.equal(newEpisodesAt(prev, { n: 11, newest: sec(now - 200 * DAY) }, now), sec(now));
});

test("list dates: the Xtream adapter's time is read, a Stalker duration is not a date", () => {
  assert.equal(mapVodItem({ id: "1", name: "A", added: "1761000000" }, 1, 5).added, "1761000000");
  assert.equal(mapVodItem({ id: "1", name: "A", time: 1761000000 }, 1, 5).added, "1761000000", "Xtream: time holds added");
  assert.equal(mapVodItem({ id: "1", name: "A", time: "120" }, 1, 5).added, "", "Stalker: time is minutes");
  assert.equal(mapVodItem({ id: "1", name: "A", added: "2025-05-01 10:00:00", time: "95" }, 1, 5).added, String(sec(Date.parse("2025-05-01 10:00:00"))));
});

test("a history row's series: the stored catalog id, then meta.mediaId (rows saved with an episode's file), then mediaId", () => {
  assert.deepEqual(seriesCandidates({ mediaId: "3206331", meta: JSON.stringify({ type: "series", mediaId: "569231" }) }), [569231, 3206331]);
  assert.deepEqual(seriesCandidates({ mediaId: "567747", meta: { type: "series", mediaId: "567747", catalogId: "series_100" } }), [100, 567747]);
  assert.deepEqual(seriesCandidates({ mediaId: "77", meta: { type: "series", catalogId: "series_L18" } }), [77], "a library id is not a portal id");
  assert.deepEqual(seriesCandidates({ mediaId: "abc", meta: null }), []);
});
