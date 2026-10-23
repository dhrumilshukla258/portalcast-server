// Fresh Home rows (content/homeThemes.ts): Just added, trending this server has, daily themes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { justAdded, newEpisodes, trendingRanks, dailyThemes, dayNumber, nameKey, type TitleFacts } from "../src/content/homeThemes";
import { providerSeconds } from "../src/content/providerDates";

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
    providerAdded: new Float64Array(n),
    providerLatest: new Float64Array(n),
    byTmdb: new Map([["movie:603", 0], ["series:1396", 4], ["movie:27205", 2]]),
    byName: new Map(),
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

test("name keys: accents, case, punctuation, a year and a leading The do not matter", () => {
  assert.equal(nameKey("The Office (2005)"), "office");
  assert.equal(nameKey("Fast & Furious"), "fast and furious");
  assert.equal(nameKey("Amélie"), nameKey("Amelie"));
  assert.equal(nameKey("Pokémon: The Movie"), "pokemon the movie");
  assert.equal(nameKey("Señor Ávila"), "senor avila");
  assert.equal(nameKey("  THE   END!! "), "end");
});

test("the day number changes once a day", () => {
  const d = new Date(2026, 9, 22, 12, 0, 0);
  assert.equal(dayNumber(d) + 1, dayNumber(new Date(2026, 9, 23, 12, 0, 0)));
});

test("Just added prefers the provider's own date, and works on a new install with it", () => {
  const { idx, facts } = fixture();
  facts.newSince = now + DAY; // a new install: first-seen dates say nothing
  facts.providerAdded[6] = now - 3 * DAY; // the provider added rank 6 three days ago
  facts.providerAdded[0] = now - 90 * DAY; // and rank 0 long ago (not new)
  assert.deepEqual(justAdded(idx, facts, () => true, now), [6]);
});

test("New episodes: watched series the provider updated after the viewer's last watch", () => {
  const { facts } = fixture();
  facts.providerLatest[4] = now - 1 * DAY; // updated yesterday, watched a week ago -> new
  facts.providerLatest[5] = now - 10 * DAY; // updated before the last watch -> not new
  facts.providerLatest[6] = now - 60 * DAY; // too long ago
  const watched = [{ rank: 4, at: now - 7 * DAY }, { rank: 5, at: now - 2 * DAY }, { rank: 6, at: now - 90 * DAY }];
  assert.deepEqual(newEpisodes(facts, watched, () => true, now), [4]);
  assert.deepEqual(newEpisodes(facts, watched, (r) => r !== 4, now), []);
});

test("provider dates: unix seconds or ms or a date; nonsense is ignored", () => {
  assert.equal(providerSeconds("1761000000"), 1761000000);
  assert.equal(providerSeconds(1761000000000), 1761000000);
  assert.equal(providerSeconds("2025-10-20"), Math.floor(Date.parse("2025-10-20") / 1000));
  assert.equal(providerSeconds(""), null);
  assert.equal(providerSeconds("0"), null);
  assert.equal(providerSeconds("4102444800"), null); // year 2100: in the future
});
