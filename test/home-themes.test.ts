// Fresh Home rows (content/homeThemes.ts): Just added, trending this server has, daily themes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { justAdded, trendingRanks, dailyThemes, dayNumber, type TitleFacts } from "../src/content/homeThemes";

const DAY = 86_400_000;
const now = Date.now();

// Eight titles: ranks 0-3 movies, 4-7 series; genres and languages as noted.
function fixture() {
  const n = 8;
  const idx: any = {
    ids: Array.from({ length: n }, (_, i) => (i < 4 ? `movie_${i}` : `series_${i}`)),
    type: Uint8Array.from([1, 1, 1, 1, 2, 2, 2, 2]),
    lang: Int32Array.from([0, 0, 1, 1, 0, 0, 1, 1]),
    langs: ["en", "hi"],
    postings: { genre: new Map([["Horror", Int32Array.from([0, 1, 4, 5])], ["Comedy", Int32Array.from([2, 3, 6, 7])]]) },
  };
  const facts: TitleFacts = {
    year: Int16Array.from([1985, 1992, 2016, 2016, 1995, 2023, 2016, 2024]),
    rating: Float32Array.from([8.1, 7.4, 7.9, 6.5, 8.6, 7.2, 7.5, 8.0]),
    votes: Int32Array.from([90_000, 40_000, 60_000, 12_000, 30_000, 9_000, 8_000, 15_000]),
    added: Float64Array.from([now - 400 * DAY, now - 400 * DAY, now - 2 * DAY, now - 5 * DAY, now - 400 * DAY, now - 1 * DAY, now - 400 * DAY, now - 40 * DAY]),
    byTmdb: new Map([["movie:603", 0], ["series:1396", 4], ["movie:27205", 2]]),
    newSince: now - 300 * DAY,
  };
  return { idx, facts };
}

test("Just added: titles first seen in the last 30 days, newest first, never the first import", () => {
  const { idx, facts } = fixture();
  assert.deepEqual(justAdded(idx, facts, () => true, now), [5, 2, 3]);
  // On a new install (first import 2 days ago) nothing counts as new.
  assert.deepEqual(justAdded(idx, { ...facts, newSince: now + DAY }, () => true, now), []);
});

test("Trending this week keeps TMDB's order, only titles this server has, interleaved on Home", () => {
  const { facts } = fixture();
  const online = { movie: [27205, 999, 603], series: [1396, 42] };
  assert.deepEqual(trendingRanks(facts, online, "movie", () => true), [2, 0]);
  assert.deepEqual(trendingRanks(facts, online, "all", () => true), [2, 4, 0]);
  assert.deepEqual(trendingRanks(facts, online, "all", (r) => r !== 4), [2, 0]);
});

test("Daily themes: same rows all day for a viewer, best rated first, only allowed titles", () => {
  const { idx, facts } = fixture();
  const args = { idx, facts, ok: (r: number) => r !== 1, genres: ["Horror"], langs: [1], catalogGenres: ["Comedy", "Horror"], count: 4, minRow: 1 };
  const a = dailyThemes({ ...args, seed: "7:1:20000:all" });
  const b = dailyThemes({ ...args, seed: "7:1:20000:all" });
  assert.deepEqual(a, b);
  assert.ok(a.length >= 2);
  for (const t of a) {
    assert.ok(!t.ranks.includes(1), "a title the viewer may not see is left out");
    const ratings = t.ranks.map((r) => facts.rating[r]);
    assert.deepEqual(ratings, [...ratings].sort((x, y) => y - x), t.title);
  }
  assert.equal(new Set(a.map((t) => t.key)).size, a.length, "no theme twice");
});

test("the day number changes once a day", () => {
  const d = new Date(2026, 9, 22, 12, 0, 0);
  assert.equal(dayNumber(d) + 1, dayNumber(new Date(2026, 9, 23, 12, 0, 0)));
});
