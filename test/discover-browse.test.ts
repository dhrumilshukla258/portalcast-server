// Discover's filtered browse (content/discoverIndex.ts browse): genres AND together, and
// "not these genres" leaves out any title carrying one of them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { browse, imdbScore, type DiscoverIndex } from "../src/content/discoverIndex";

// Six titles, newest first (rank = position); type 1 = movie, 2 = series.
function index(): DiscoverIndex {
  const ids = ["m1", "m2", "m3", "s4", "m5", "m6"];
  const genre: Record<string, number[]> = {
    Crime: [0, 1, 2, 3, 5],
    Drama: [1, 3, 4],
    Horror: [2, 5],
    Comedy: [4],
  };
  const postings = { genre: new Map<string, Int32Array>(), country: new Map(), theme: new Map(), network: new Map() } as DiscoverIndex["postings"];
  for (const [g, ranks] of Object.entries(genre)) postings.genre.set(g, Int32Array.from(ranks));
  return {
    ids,
    type: Uint8Array.from([1, 1, 1, 2, 1, 1]),
    lang: new Int32Array(6).fill(-1),
    langs: [],
    langIndex: new Map(),
    // Hindi: m2 (original) and m3 (a Hindi-dubbed copy of an English film); Tamil: s4.
    audio: new Map([["hi", Int32Array.from([1, 2])], ["en", Int32Array.from([2])], ["ta", Int32Array.from([3])]]),
    // IMDb x10: m1 8.1, m2 7.0, m3 none, s4 9.2, m5 6.9, m6 7.5.
    imdb: Uint8Array.from([81, 70, 0, 92, 69, 75]),
    rankOf: new Map(ids.map((id, r) => [id, r])),
    postings,
    facets: {} as DiscoverIndex["facets"],
    builtAt: 0,
  } as DiscoverIndex;
}

const q = (over: Partial<Parameters<typeof browse>[1]>) => ({ tags: [], hidden: new Set<string>(), page: 1, pageSize: 50, ...over });
const g = (...values: string[]) => values.map((value) => ({ kind: "genre" as const, value }));

test("several genres: a title must have all of them", () => {
  assert.deepEqual(browse(index(), q({ tags: g("Crime", "Drama") })), { ids: ["m2", "s4"], total: 2 });
});

test("not a genre: titles with it are left out", () => {
  assert.deepEqual(browse(index(), q({ tags: g("Crime"), exclude: g("Horror") })), { ids: ["m1", "m2", "s4"], total: 3 });
  // Two excluded: any of them leaves a title out.
  assert.deepEqual(browse(index(), q({ tags: g("Crime"), exclude: g("Horror", "Drama") })), { ids: ["m1"], total: 1 });
});

test("only exclusions: everything else, with type, hidden titles and pages applied", () => {
  assert.deepEqual(browse(index(), q({ exclude: g("Crime") })), { ids: ["m5"], total: 1 });
  assert.deepEqual(browse(index(), q({ exclude: g("Horror"), type: "movie" })), { ids: ["m1", "m2", "m5"], total: 3 });
  assert.deepEqual(browse(index(), q({ exclude: g("Horror"), hidden: new Set(["m2"]) })), { ids: ["m1", "s4", "m5"], total: 3 });
  assert.deepEqual(browse(index(), q({ exclude: g("Horror"), pageSize: 2, page: 2 })), { ids: ["s4", "m5"], total: 4 });
});

test("an unknown excluded genre changes nothing; no filters is the whole list", () => {
  assert.deepEqual(browse(index(), q({ tags: g("Crime"), exclude: g("Western") })), { ids: ["m1", "m2", "m3", "s4", "m6"], total: 5 });
  assert.deepEqual(browse(index(), q({})), { ids: ["m1", "m2", "m3", "s4", "m5", "m6"], total: 6 });
});

test("a language: titles with that audio, dubbed copies included", () => {
  assert.deepEqual(browse(index(), q({ language: "hi" })), { ids: ["m2", "m3"], total: 2 });
  assert.deepEqual(browse(index(), q({ language: "en" })), { ids: ["m3"], total: 1 });
  assert.deepEqual(browse(index(), q({ language: "hi", type: "series" })), { ids: [], total: 0 });
  assert.deepEqual(browse(index(), q({ language: "gu" })), { ids: [], total: 0 });
  // With genres: both must hold.
  assert.deepEqual(browse(index(), q({ language: "hi", tags: g("Horror") })), { ids: ["m3"], total: 1 });
});

test("IMDb rating: titles rated at least that, alone or with other filters", () => {
  assert.deepEqual(browse(index(), q({ minImdb: 7 })), { ids: ["m1", "m2", "s4", "m6"], total: 4 });
  assert.deepEqual(browse(index(), q({ minImdb: 7.5, type: "movie" })), { ids: ["m1", "m6"], total: 2 });
  assert.deepEqual(browse(index(), q({ minImdb: 7, tags: g("Crime"), exclude: g("Horror") })), { ids: ["m1", "m2", "s4"], total: 3 });
  assert.deepEqual(browse(index(), q({ minImdb: 7, language: "hi" })), { ids: ["m2"], total: 1 });
  // A title with no IMDb score is not "rated 0 or more": no filter, no change.
  assert.equal(browse(index(), q({})).total, 6);
});

test("IMDb scores are stored x10 and only when real", () => {
  assert.equal(imdbScore(7.5), 75);
  assert.equal(imdbScore("8.04"), 80);
  assert.equal(imdbScore(null), 0);
  assert.equal(imdbScore(0), 0);
  assert.equal(imdbScore(11), 0);
});
